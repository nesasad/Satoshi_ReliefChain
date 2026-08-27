// ====== EDIT AFTER DEPLOY ======
// Paste the address printed by scripts/deploy.js
export const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // default 1st address on hardhat local node

// The chain is served through the page's own origin (vite proxies /rpc to the
// hardhat node), so one build works on localhost, over the LAN on a phone, and
// through a tunnel — no edits, no CORS, and the node stays bound to 127.0.0.1.
export const RPC_URL =
  typeof location !== "undefined" && location.origin
    ? `${location.origin}/rpc`
    : "http://127.0.0.1:8545";

export const DEFAULT_CHAIN_ID = 31337n; // hardhat local node; refreshed from the RPC when online

// The Handover struct, shared by the ABI and the EIP-712 signing types below.
// `salt` (not a sequential nonce) is what makes a voucher unique, so any number of
// field devices can sign at the same time with no coordination between them.
const HANDOVER_TUPLE =
  "tuple(uint256 batchId, address from, address to, string note, uint256 signedAt, bytes32 salt, uint256 epoch, uint256 deadline)";

// Human-readable ABI (ethers v6)
export const ABI = [
  "function admin() view returns (address)",
  "function registerOrg(address orgAddr, string name, uint8 orgType)",
  "function createBatch(string description, uint256 quantity) returns (uint256)",
  "function donate(uint256 batchId) payable",
  "function transferCustody(uint256 batchId, address to, string note)",
  "function confirmDelivery(uint256 batchId, bytes32 proofHash)",
  "function nextBatchId() view returns (uint256)",
  "function epochOf(address org) view returns (uint256)",
  "function voucherSpent(bytes32 digest) view returns (bool)",
  `function transferCustodyWithSig(${HANDOVER_TUPLE} h, bytes signature) returns (bool tookCustody)`,
  `function relayHandovers(${HANDOVER_TUPLE}[] hs, bytes[] signatures) returns (uint256 tookCustody, uint256 conflicted)`,
  "function invalidateVouchers()",
  `function hashHandover(${HANDOVER_TUPLE} h) view returns (bytes32)`,
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function getBatch(uint256 batchId) view returns (tuple(uint256 id, string description, uint256 quantity, address creator, address currentHolder, uint8 status, uint256 donatedWei, uint256 createdAt, uint256 deliveredAt, bytes32 deliveryProofHash))",
  "function getCustodyHistory(uint256 batchId) view returns (tuple(address from, address to, uint256 recordedAt, uint256 signedAt, string note, bool offline)[])",
  "function getConflictingClaims(uint256 batchId) view returns (tuple(address claimedFrom, address claimedTo, uint256 signedAt, uint256 recordedAt, string note, uint8 reason)[])",
  "function getOrg(address orgAddr) view returns (tuple(string name, uint8 orgType, bool registered))",
  "event BatchCreated(uint256 indexed batchId, address indexed creator, string description, uint256 quantity)",
  "event DonationReceived(uint256 indexed batchId, address indexed donor, uint256 amount)",
  "event CustodyTransferred(uint256 indexed batchId, address indexed from, address indexed to, string note, bool offline, uint256 signedAt)",
  "event ConflictingClaimRecorded(uint256 indexed batchId, address indexed claimedFrom, address indexed claimedTo, uint256 signedAt, uint8 reason)",
  "event DeliveryConfirmed(uint256 indexed batchId, address indexed byOrg, bytes32 proofHash)",
  "event VouchersInvalidated(address indexed org, uint256 newEpoch)",
];

/** ConflictReason enum, mirrored from the contract. */
export const CONFLICT_REASONS = ["Custody had already moved on", "Batch was already delivered"];

// ---------- EIP-712 offline handover vouchers ----------
// A phone in a disaster zone signs this struct with NO network access. The signature
// travels out by QR or a synced queue; a relayer submits it and pays the gas.

export const HANDOVER_TYPES = {
  Handover: [
    { name: "batchId", type: "uint256" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "note", type: "string" },
    { name: "signedAt", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "epoch", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const eip712Domain = (chainId) => ({
  name: "ReliefChain",
  version: "2",
  chainId,
  verifyingContract: CONTRACT_ADDRESS,
});

/** Vouchers stay valid for a week — a realistic worst case for restoring connectivity. */
export const VOUCHER_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Compact wire format so a whole signed voucher fits comfortably in one QR code. */
export const encodeVoucher = ({ h, signature }) =>
  JSON.stringify({
    v: 2, b: Number(h.batchId), f: h.from, t: h.to, n: h.note,
    s: Number(h.signedAt), x: h.salt, e: Number(h.epoch), d: Number(h.deadline), g: signature,
  });

export const decodeVoucher = (text) => {
  const p = JSON.parse(text);
  if (p.v !== 2) throw new Error("Unsupported voucher version");
  return {
    h: {
      batchId: p.b, from: p.f, to: p.t, note: p.n,
      signedAt: p.s, salt: p.x, epoch: p.e, deadline: p.d,
    },
    signature: p.g,
  };
};

/**
 * Two vouchers clash when they both move the same batch out of the same holder.
 * Only one can win, so the outbox warns before the relayer spends gas on the loser.
 */
export const findClashes = (queue) => {
  const seen = new Map();
  const clashing = new Set();
  queue.forEach((q, i) => {
    const key = `${Number(q.h.batchId)}:${String(q.h.from).toLowerCase()}`;
    if (seen.has(key)) { clashing.add(seen.get(key)); clashing.add(i); }
    else seen.set(key, i);
  });
  return clashing;
};

// Hardhat local node default accounts — DEMO ONLY, never use on a real network.
// Index matches scripts/deploy.js signer order.
export const DEMO_ACCOUNTS = [
  { role: "Admin",      pk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { role: "Government", pk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { role: "NGO",        pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { role: "Local Relief", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
  { role: "Donor",      pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
];

// Pays gas on behalf of relief orgs when connectivity returns. In production this is a
// funded service (or the receiving org's own wallet) — never a key shipped to the client.
export const RELAYER = {
  role: "Relayer",
  pk: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // hardhat account #5
};

export const STATUS_LABELS = ["Created", "In Transit", "Delivered"];
export const ORG_TYPE_LABELS = ["Government", "NGO", "Local Relief"];
