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
 * and relayed later by anyone (see transferCustodyWithSig / relayHandovers).
 * Relief orgs therefore never need to hold ETH — the relayer pays the gas.
 */
contract ReliefChain {
    // ---------- Types ----------

    enum OrgType { Government, NGO, LocalRelief }
    enum BatchStatus { Created, InTransit, Delivered }

    struct Organization {
        string name;
        OrgType orgType;
        bool registered;
    }

    struct Batch {
        uint256 id;
        string description;      // e.g. "Emergency food kits x500"
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
        uint256 signedAt;        // time the physical handover actually happened (attested by signer)
        string note;             // e.g. scan location label ("Busan warehouse"), never PII
        bool offline;            // true if signed offline and submitted later by a relayer
    }

    /// An offline-signable handover authorisation. Signed with EIP-712 by `from`,
    /// carried out of the disaster zone (QR / queued on the phone), submitted by anyone.
    struct Handover {
        uint256 batchId;
        address from;            // must be the current holder at submission time
        address to;              // must be a registered org
        string note;
        uint256 signedAt;        // when the handover physically happened
        uint256 nonce;           // must equal nonces[from]
        uint256 deadline;        // voucher is unusable after this timestamp
    }

    // ---------- State ----------

    address public admin;
    uint256 public nextBatchId = 1;

    mapping(address => Organization) public orgs;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => CustodyRecord[]) private custodyHistory;

    /// Per-signer counter. Every accepted voucher bumps it, so a voucher can never
    /// be replayed, and an org can burn all its outstanding vouchers at once.
    mapping(address => uint256) public nonces;

    // ---------- EIP-712 ----------

    string public constant EIP712_NAME = "ReliefChain";
    string public constant EIP712_VERSION = "1";

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant HANDOVER_TYPEHASH = keccak256(
        "Handover(uint256 batchId,address from,address to,string note,uint256 signedAt,uint256 nonce,uint256 deadline)"
    );

    /// secp256k1n / 2 — signatures with a higher `s` are malleable (EIP-2) and rejected.
    uint256 private constant _HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ---------- Events (frontend reads these for the timeline) ----------

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
    event DeliveryConfirmed(uint256 indexed batchId, address indexed byOrg, bytes32 proofHash);
    event VouchersInvalidated(address indexed org, uint256 newNonce);

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

    /// Online path: the current holder submits the handover itself (needs connectivity + gas).
    function transferCustody(uint256 batchId, address to, string calldata note)
        external
        onlyCurrentHolder(batchId)
    {
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
     * The signer needs no ETH; the submitter pays the gas.
     */
    function transferCustodyWithSig(Handover calldata h, bytes calldata signature) external {
        _consumeVoucher(h, signature);
    }

    /**
     * Connectivity restored: flush a whole queue of offline handovers in ONE transaction.
     * Order matters — vouchers for the same batch must be supplied in handover order,
     * since each is validated against the custody state left by the previous one.
     * All-or-nothing: if any voucher is invalid the whole relay reverts, so a bad
     * entry can never be silently dropped from the audit trail.
     */
    function relayHandovers(Handover[] calldata hs, bytes[] calldata signatures) external {
        require(hs.length == signatures.length, "Length mismatch");
        require(hs.length > 0, "Empty relay");
        for (uint256 i = 0; i < hs.length; i++) {
            _consumeVoucher(hs[i], signatures[i]);
        }
    }

    /// Phone lost or compromised: burn every outstanding voucher this org has signed
    /// but not yet had submitted. Cheap insurance for an offline-first system.
    function invalidateVouchers() external onlyRegisteredOrg {
        uint256 newNonce = ++nonces[msg.sender];
        emit VouchersInvalidated(msg.sender, newNonce);
    }

    /// The EIP-712 digest a signer must sign. Exposed so a phone can verify what it signed.
    function hashHandover(Handover calldata h) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                HANDOVER_TYPEHASH,
                h.batchId,
                h.from,
                h.to,
                keccak256(bytes(h.note)),
                h.signedAt,
                h.nonce,
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

    function getOrg(address orgAddr) external view returns (Organization memory) {
        return orgs[orgAddr];
    }

    // ---------- Internals ----------

    function _consumeVoucher(Handover calldata h, bytes calldata signature) private {
        require(block.timestamp <= h.deadline, "Voucher expired");
        require(h.signedAt <= block.timestamp, "signedAt in future");
        require(h.nonce == nonces[h.from], "Bad nonce");

        address signer = _recover(hashHandover(h), signature);
        require(signer != address(0) && signer == h.from, "Bad signature");

        nonces[h.from] = h.nonce + 1;
        _recordTransfer(h.batchId, h.from, h.to, h.note, h.signedAt, true);
    }

    function _recordTransfer(
        uint256 batchId,
        address from,
        address to,
        string calldata note,
        uint256 signedAt,
        bool offline
    ) private {
        Batch storage b = batches[batchId];
        require(b.id != 0, "Batch does not exist");
        require(b.currentHolder == from, "Not current holder");
        require(b.status != BatchStatus.Delivered, "Already delivered");
        require(orgs[to].registered, "Recipient not registered");
        require(to != from, "Cannot transfer to self");

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
