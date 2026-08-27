# ReliefChain 🔗

**Blockchain-based disaster relief tracking system — SDG 16 (Peace, Justice and Strong Institutions)**
Blockathon for Social Good 2026

Tracks relief supplies from donation to final delivery. Every org-to-org handover is recorded on-chain via QR scan, creating a tamper-resistant chain of custody shared by governments, NGOs, and local relief groups.

**Privacy by design:** no victim personal data on-chain — only custody records, timestamps, and hashes of off-chain delivery proofs.

**Works when the network doesn't.** Connectivity is the first thing a disaster takes out, so handovers are signed *offline* on the phone as EIP-712 vouchers, queued, and relayed once a signal returns — with the real field handover time preserved. Relief orgs need neither connectivity nor ETH.

## Structure

```
reliefchain/
├── contracts/ReliefChain.sol    # smart contract (custody + EIP-712 offline vouchers)
├── test/ReliefChain.test.js     # 25 tests: demo flow, voucher security, conflict rule
├── scripts/deploy.js            # deploys + seeds demo orgs & batch
├── hardhat.config.js
└── frontend/                    # React + ethers + QR (Vite), offline-first outbox
```

## Offline-first handovers (EIP-712)

The problem every relief-tracking demo ignores: **a truck arriving at a flattened village has no bars.** If the ledger only accepts online transactions, the record is written hours later from memory — which is exactly the gap where accountability is lost.

ReliefChain closes it:

1. **Sign, don't send.** The holding org signs a `Handover` struct (batch, recipient, note, `signedAt`, `nonce`, `deadline`) with EIP-712. This is pure local cryptography — no node, no gas, no network.
2. **Queue it.** The voucher sits in the phone's outbox (`localStorage`), or travels to another device as a QR code (~330 bytes).
3. **Relay it.** When any device with a signal shows up, `relayHandovers()` submits **the entire queue in one transaction**. The relayer pays the gas, so relief orgs never hold ETH.
4. **Truth survives the delay.** Each record stores both `signedAt` (when the supplies actually changed hands) and `recordedAt` (when the chain heard about it). The timeline shows both — *"field handover 14:32 · synced 19:07, 5 hours later"*.

Security properties, all covered by tests:

| Attack | Defence |
|---|---|
| Replaying a voucher | per-signer `nonce`, consumed on use |
| Hoarding a stale voucher | `deadline` (default 7 days) |
| Backdating / postdating a handover | `signedAt <= block.timestamp`, and it's inside the signed payload |
| Forging another org's handover | `ecrecover` must return `h.from` |
| Reusing a voucher on another chain/contract | chainId + contract address bound into the EIP-712 domain |
| Signature malleability | high-`s` signatures rejected (EIP-2) |
| Stolen phone | `invalidateVouchers()` burns every unsubmitted voucher at once |
| Bad entry hidden in a batch relay | relay is all-or-nothing — it reverts rather than silently dropping |

Signing a voucher still doesn't grant custody by itself: at submission time the contract re-checks that `h.from` is the current holder, that the recipient is a registered org, and that the batch isn't already delivered.

## Setup (needs internet)

```bash
# 1. contract side
cd reliefchain
npm install
npx hardhat test                 # all 25 tests should pass

# 2. frontend
cd frontend
npm install
```

## Run the demo

```bash
# Terminal 1 — local chain
npx hardhat node

# Terminal 2 — deploy (seeds Gov/NGO/Local orgs + demo batch #1)
npx hardhat run scripts/deploy.js --network localhost
# → copy the printed contract address into frontend/src/config.js (CONTRACT_ADDRESS)
#   (default hardhat first-deploy address is already pre-filled, usually correct)

# Terminal 3 — frontend
cd frontend && npm run dev
```

Open **http://localhost:5173**

### Live demo

No setup needed — the app is served from a laptop through a tunnel:

**https://republican-captured-performs-trainers.trycloudflare.com**

Everyone on that link shares one chain, so a batch you create shows up on everyone else's screen. The URL is temporary: it changes whenever the host laptop's network does, and it goes down when the laptop does. Run it locally with the steps above if you need something that stays up.

### Demo script (what to show judges)

**Act 1 — the happy path (network works)**

1. **Donor** role → select batch #1 → donate 0.5 ETH → donation appears on batch
2. **Government** role → "Create relief batch" → QR appears in the batch panel
3. **NGO** role → "Scan QR to transfer" → for the live pitch, open the site on a **phone**
   (same Wi-Fi, `http://<PC-LAN-IP>:5173`, and change `RPC_URL` in config.js to the LAN IP)
   and scan the QR shown on the projector — custody transfers live
   *(no camera? use the "Manual transfer" button — same contract call)*

**Act 2 — the disaster hits the network (this is the one judges remember)**

4. Hit **📶 Network up → 📴 No connectivity** in the header. An orange banner takes over; batch creation and delivery confirmation grey out.
5. Still as **Government**, hand over batch #1 → the button now reads *"Sign handover offline"*. Press it. **No transaction, no gas, no node** — just a signature. The **Offline outbox** panel appears.
6. Switch to **NGO** and sign the next hop too. Two handovers now sit in the outbox, signed hours apart, with nobody online.
   *Optional, very strong:* hit **Voucher QR** and scan it with a second device that still has signal — that phone submits the handover on the first phone's behalf.
7. Flip back to **📶 Network up** → press **"Signal restored — relay all 2 in ONE transaction"**. Both handovers land on-chain in a single transaction, and the toast reports the gas — *paid by the relayer, not the relief orgs*.
8. Open the **timeline**: the offline hops are marked 📴 and show **two** timestamps — *"Field handover 14:32 / Recorded on-chain 19:07 · synced 5 hr later"*. Point out that the chain records when supplies **actually** moved, not when the paperwork caught up.
9. **Local Relief** → "Confirm final delivery" → ✅ Delivered.
10. Footer: *no PII on-chain, proof stored as hash, handovers signable offline.*

**The two questions this pre-empts** — ask them yourselves before a judge does:
*"Does this work when the network is down?"* and *"Do you expect aid workers to buy ETH?"* Both answers are on screen in Act 2.

### Judging criteria mapping (for the pitch deck)

| Criterion | Answer |
|---|---|
| Comprehensiveness | End-to-end: donation → custody transfers → verified delivery, online **or** offline |
| Context & relevance | Multi-org relief chains are where records fragment — and they fragment worst exactly when connectivity fails |
| Economic & social benefit | Donor trust ↑ → donations ↑; accountability for institutions (SDG 16.6) |
| Security & privacy | Only the current holder can transfer; EIP-712 vouchers are nonce-bound, expiring, chain-bound and revocable; no PII on-chain |
| Usability | One action per handover (scan); works with zero bars; orgs never touch a gas fee or a token |
| Feasibility | Standard EVM stack; orgs need only a phone; meta-transactions remove the ETH-custody barrier that kills most real deployments |
| Creativity & presentation | Live "kill the network, keep the chain of custody" demo on stage |

## Testnet (optional)

```bash
export SEPOLIA_RPC_URL=https://...   # e.g. from Alchemy/Infura
export PRIVATE_KEY=0x...
npx hardhat run scripts/deploy.js --network sepolia
```
Then register your teammates' wallet addresses as orgs via `registerOrg`.
