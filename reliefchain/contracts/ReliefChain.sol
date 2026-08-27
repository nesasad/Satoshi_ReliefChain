// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ReliefChain — Blockchain-based disaster relief tracking (SDG 16)
 *
 * Records the full chain of custody for relief supplies:
 *   donation -> batch creation (QR issued) -> org-to-org transfers -> final delivery
 *
 * Privacy by design: NO victim personal data is stored on-chain.
 * Only custody/verification records (org addresses, timestamps, batch metadata,
 * and optional off-chain document hashes) live on-chain.
 *
 * Disaster-zone reality: connectivity is the first thing to fail. Handovers can be
 * signed OFFLINE as EIP-712 "handover vouchers" on a phone with no network, queued,
 * and relayed later by anyone. Relief orgs therefore never need to hold ETH — the
 * relayer pays the gas.
 *
 * ── The conflict rule ────────────────────────────────────────────────────────
 * Two field workers from the same organization can both sign a handover for the
 * same batch while offline, each unaware of the other. On sync:
 *
 *   1. Custody is SINGLE-WRITER. The first valid voucher to reach the chain wins.
 *   2. The loser is NOT discarded. It is recorded as a ConflictingClaim against
 *      the batch — signed, timestamped and attributed — without moving custody.
 *      A handover that physically happened never vanishes from the audit trail.
 *   3. A conflicting claim never reverts a relay. Only a malformed voucher does
 *      (bad signature, expired, revoked epoch, already spent).
 *
 * Vouchers carry a random `salt` rather than a sequential nonce, so any number of
 * devices can sign in parallel with no coordination at all. Replay is prevented by
 * spending the voucher's digest; bulk revocation by bumping the org's `epoch`.
 */
contract ReliefChain {
    // ---------- Types ----------

    enum OrgType { Government, NGO, LocalRelief }
    enum BatchStatus { Created, InTransit, Delivered }

    /// Why a validly signed handover could not take custody.
    enum ConflictReason { NotCurrentHolder, AlreadyDelivered }

    struct Organization {
        string name;
        OrgType orgType;
        bool registered;
    }

    struct Batch {
        uint256 id;
        string description;      // e.g. "Evacuation kits x500"
        uint256 quantity;
        address creator;         // org that created the batch
        address currentHolder;   // org currently holding the supplies
        BatchStatus status;
        uint256 donatedWei;      // total donations attached to this batch
        uint256 createdAt;
        uint256 deliveredAt;
        bytes32 deliveryProofHash; // hash of off-chain delivery proof (photo/doc), no PII on-chain
    }

    struct CustodyRecord {
        address from;
        address to;
        uint256 recordedAt;      // block time the handover was written on-chain
        uint256 signedAt;        // time the physical handover actually happened
        string note;             // e.g. scan location label, never PII
        bool offline;            // true if signed offline and submitted later by a relayer
    }

    /// A handover that was validly signed but arrived after custody had moved on.
    /// Kept as evidence for reconciliation; it does not change custody.
    struct ConflictingClaim {
        address claimedFrom;
        address claimedTo;
        uint256 signedAt;        // when the claimant says the handover happened
        uint256 recordedAt;
        string note;
        ConflictReason reason;
    }

    /// An offline-signable handover authorisation, signed with EIP-712 by `from`.
    /// `salt` makes every voucher unique, so devices never need to agree on ordering.
    struct Handover {
        uint256 batchId;
        address from;            // the org that says it handed the supplies over
        address to;              // must be a registered org
        string note;
        uint256 signedAt;        // when the handover physically happened
        bytes32 salt;            // device-chosen randomness — uniqueness, not ordering
        uint256 epoch;           // must equal epochOf[from]
        uint256 deadline;        // voucher is unusable after this timestamp
    }

    // ---------- State ----------

    address public admin;
    uint256 public nextBatchId = 1;

    mapping(address => Organization) public orgs;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => CustodyRecord[]) private custodyHistory;
    mapping(uint256 => ConflictingClaim[]) private conflictingClaims;

    /// Each voucher digest may be consumed once. Replaces a sequential nonce, so
    /// any number of offline devices can sign at the same time without colliding.
    mapping(bytes32 => bool) public voucherSpent;

    /// Bumping an org's epoch invalidates every voucher it has signed but not yet
    /// had submitted — the "lost phone" switch.
    mapping(address => uint256) public epochOf;

    // ---------- EIP-712 ----------

    string public constant EIP712_NAME = "ReliefChain";
    string public constant EIP712_VERSION = "2";

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant HANDOVER_TYPEHASH = keccak256(
        "Handover(uint256 batchId,address from,address to,string note,uint256 signedAt,bytes32 salt,uint256 epoch,uint256 deadline)"
    );

    /// secp256k1n / 2 — signatures with a higher `s` are malleable (EIP-2) and rejected.
    uint256 private constant _HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ---------- Events ----------

    event OrgRegistered(address indexed org, string name, OrgType orgType);
    event BatchCreated(uint256 indexed batchId, address indexed creator, string description, uint256 quantity);
    event DonationReceived(uint256 indexed batchId, address indexed donor, uint256 amount);
    event CustodyTransferred(
        uint256 indexed batchId,
        address indexed from,
        address indexed to,
        string note,
        bool offline,
        uint256 signedAt
    );
    event ConflictingClaimRecorded(
        uint256 indexed batchId,
        address indexed claimedFrom,
        address indexed claimedTo,
        uint256 signedAt,
        ConflictReason reason
    );
    event DeliveryConfirmed(uint256 indexed batchId, address indexed byOrg, bytes32 proofHash);
    event VouchersInvalidated(address indexed org, uint256 newEpoch);

    // ---------- Modifiers ----------

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    modifier onlyRegisteredOrg() {
        require(orgs[msg.sender].registered, "Not a registered org");
        _;
    }

    modifier onlyCurrentHolder(uint256 batchId) {
        require(batches[batchId].id != 0, "Batch does not exist");
        require(batches[batchId].currentHolder == msg.sender, "Not current holder");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // ---------- Org management ----------

    function registerOrg(address orgAddr, string calldata name, OrgType orgType) external onlyAdmin {
        require(!orgs[orgAddr].registered, "Already registered");
        orgs[orgAddr] = Organization(name, orgType, true);
        emit OrgRegistered(orgAddr, name, orgType);
    }

    // ---------- Batch lifecycle ----------

    /// Creates a relief batch. The returned batchId is what goes into the QR code.
    function createBatch(string calldata description, uint256 quantity)
        external
        onlyRegisteredOrg
        returns (uint256)
    {
        uint256 id = nextBatchId++;
        batches[id] = Batch({
            id: id,
            description: description,
            quantity: quantity,
            creator: msg.sender,
            currentHolder: msg.sender,
            status: BatchStatus.Created,
            donatedWei: 0,
            createdAt: block.timestamp,
            deliveredAt: 0,
            deliveryProofHash: bytes32(0)
        });
        emit BatchCreated(id, msg.sender, description, quantity);
        return id;
    }

    /// Donors attach funds to a specific batch — fully traceable.
    function donate(uint256 batchId) external payable {
        require(batches[batchId].id != 0, "Batch does not exist");
        require(batches[batchId].status != BatchStatus.Delivered, "Already delivered");
        require(msg.value > 0, "No value");
        batches[batchId].donatedWei += msg.value;
        emit DonationReceived(batchId, msg.sender, msg.value);
    }

    /// Online path: the current holder submits the handover itself. The caller is
    /// present and can react, so losing a race reverts here rather than becoming a claim.
    function transferCustody(uint256 batchId, address to, string calldata note)
        external
        onlyCurrentHolder(batchId)
    {
        require(batches[batchId].status != BatchStatus.Delivered, "Already delivered");
        _recordTransfer(batchId, msg.sender, to, note, block.timestamp, false);
    }

    /// Final delivery confirmation by the last holder (e.g. local relief group).
    /// proofHash = keccak256 of an off-chain delivery proof; no PII on-chain.
    function confirmDelivery(uint256 batchId, bytes32 proofHash)
        external
        onlyCurrentHolder(batchId)
    {
        require(batches[batchId].status != BatchStatus.Delivered, "Already delivered");
        batches[batchId].status = BatchStatus.Delivered;
        batches[batchId].deliveredAt = block.timestamp;
        batches[batchId].deliveryProofHash = proofHash;
        emit DeliveryConfirmed(batchId, msg.sender, proofHash);
    }

    // ---------- Offline handover vouchers ----------

    /**
     * Offline path: `h` was signed by `h.from` on a phone with no connectivity.
     * ANY address may submit it — a relayer, the receiving org, a base-camp laptop.
     *
     * Returns true if the voucher took custody, false if it lost the race and was
     * filed as a conflicting claim instead. Malformed vouchers revert.
     */
    function transferCustodyWithSig(Handover calldata h, bytes calldata signature)
        external
        returns (bool tookCustody)
    {
        return _consumeVoucher(h, signature);
    }

    /**
     * Connectivity restored: flush a whole queue of offline handovers in ONE transaction.
     *
     * Vouchers must be ordered by `signedAt` ascending. `signedAt` sits inside the
     * signed payload, so sorting on it reconstructs the real physical sequence of
     * handovers even when they were signed on different phones that never met.
     *
     * A voucher that lost a custody race becomes a ConflictingClaim and does not
     * abort the relay; only a malformed voucher reverts the whole batch.
     */
    function relayHandovers(Handover[] calldata hs, bytes[] calldata signatures)
        external
        returns (uint256 tookCustody, uint256 conflicted)
    {
        require(hs.length == signatures.length, "Length mismatch");
        require(hs.length > 0, "Empty relay");

        uint256 prevSignedAt = 0;
        for (uint256 i = 0; i < hs.length; i++) {
            require(hs[i].signedAt >= prevSignedAt, "Vouchers must be sorted by signedAt");
            prevSignedAt = hs[i].signedAt;

            if (_consumeVoucher(hs[i], signatures[i])) tookCustody++;
            else conflicted++;
        }
    }

    /// Phone lost or compromised: burn every outstanding voucher this org has signed
    /// but not yet had submitted. Cheap insurance for an offline-first system.
    function invalidateVouchers() external onlyRegisteredOrg {
        uint256 newEpoch = ++epochOf[msg.sender];
        emit VouchersInvalidated(msg.sender, newEpoch);
    }

    /// The EIP-712 digest a signer must sign. Exposed so a phone can verify what it
    /// signed, and so a relayer can check `voucherSpent` before paying for a submission.
    function hashHandover(Handover calldata h) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                HANDOVER_TYPEHASH,
                h.batchId,
                h.from,
                h.to,
                keccak256(bytes(h.note)),
                h.signedAt,
                h.salt,
                h.epoch,
                h.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    /// Rebuilt per call so the contract stays correct across chain forks / replays.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                keccak256(bytes(EIP712_NAME)),
                keccak256(bytes(EIP712_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------- Views ----------

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        require(batches[batchId].id != 0, "Batch does not exist");
        return batches[batchId];
    }

    function getCustodyHistory(uint256 batchId) external view returns (CustodyRecord[] memory) {
        return custodyHistory[batchId];
    }

    /// Signed handovers that lost a custody race. Anything in here needs a human to
    /// reconcile what actually happened in the field.
    function getConflictingClaims(uint256 batchId) external view returns (ConflictingClaim[] memory) {
        return conflictingClaims[batchId];
    }

    function getOrg(address orgAddr) external view returns (Organization memory) {
        return orgs[orgAddr];
    }

    // ---------- Internals ----------

    /**
     * Validates a voucher and either moves custody or files a conflicting claim.
     *
     * Reverts only on a voucher that should never have been submitted. Losing a
     * race is a legitimate outcome of concurrent offline work, not an error.
     */
    function _consumeVoucher(Handover calldata h, bytes calldata signature) private returns (bool) {
        require(block.timestamp <= h.deadline, "Voucher expired");
        require(h.signedAt <= block.timestamp, "signedAt in future");
        require(h.epoch == epochOf[h.from], "Voucher revoked");
        require(orgs[h.from].registered, "Signer not a registered org");
        require(orgs[h.to].registered, "Recipient not registered");
        require(h.to != h.from, "Cannot transfer to self");

        bytes32 digest = hashHandover(h);
        require(!voucherSpent[digest], "Voucher already used");

        address signer = _recover(digest, signature);
        require(signer != address(0) && signer == h.from, "Bad signature");

        Batch storage b = batches[h.batchId];
        require(b.id != 0, "Batch does not exist");

        voucherSpent[digest] = true;

        // ---- the conflict rule ----
        if (b.status == BatchStatus.Delivered) {
            _fileClaim(h, ConflictReason.AlreadyDelivered);
            return false;
        }
        if (b.currentHolder != h.from) {
            // Someone else moved this batch first. First-to-sync wins; this signed
            // handover is preserved as a claim rather than thrown away.
            _fileClaim(h, ConflictReason.NotCurrentHolder);
            return false;
        }

        _recordTransfer(h.batchId, h.from, h.to, h.note, h.signedAt, true);
        return true;
    }

    function _fileClaim(Handover calldata h, ConflictReason reason) private {
        conflictingClaims[h.batchId].push(
            ConflictingClaim(h.from, h.to, h.signedAt, block.timestamp, h.note, reason)
        );
        emit ConflictingClaimRecorded(h.batchId, h.from, h.to, h.signedAt, reason);
    }

    function _recordTransfer(
        uint256 batchId,
        address from,
        address to,
        string calldata note,
        uint256 signedAt,
        bool offline
    ) private {
        require(orgs[to].registered, "Recipient not registered");
        require(to != from, "Cannot transfer to self");

        Batch storage b = batches[batchId];
        custodyHistory[batchId].push(CustodyRecord(from, to, block.timestamp, signedAt, note, offline));
        b.currentHolder = to;
        b.status = BatchStatus.InTransit;

        emit CustodyTransferred(batchId, from, to, note, offline, signedAt);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "Bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        require(uint256(s) <= _HALF_CURVE_ORDER, "Malleable signature");
        require(v == 27 || v == 28, "Bad signature v");
        return ecrecover(digest, v, r, s);
    }
}
