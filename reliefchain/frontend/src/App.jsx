import React, { useEffect, useMemo, useState, useCallback } from "react";
import { ethers } from "ethers";
import { QRCodeSVG } from "qrcode.react";
import QRScanner from "./components/QRScanner.jsx";
import {
  CONTRACT_ADDRESS, RPC_URL, ABI, DEMO_ACCOUNTS, RELAYER, STATUS_LABELS, ORG_TYPE_LABELS,
  HANDOVER_TYPES, eip712Domain, VOUCHER_TTL_SECONDS, DEFAULT_CHAIN_ID,
  encodeVoucher, decodeVoucher, findClashes, CONFLICT_REASONS,
} from "./config.js";

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Derived once — a signed voucher must name addresses, and we do it without a node.
const DEMO_ADDRESSES = DEMO_ACCOUNTS.map((a) => new ethers.Wallet(a.pk).address);

// The queue survives a page reload, exactly like an unsent outbox on a real phone.
const QUEUE_KEY = "reliefchain.voucherQueue";
const readQueue = () => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; }
};

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (t) => new Date(Number(t) * 1000).toLocaleString();
const roleOfAddress = (a) => {
  const i = DEMO_ADDRESSES.findIndex((x) => x.toLowerCase() === String(a).toLowerCase());
  return i >= 0 ? DEMO_ACCOUNTS[i].role : short(a);
};
const humanDuration = (sec) => {
  const s = Math.max(0, Number(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} hr`;
  return `${Math.round(s / 86400)} days`;
};

export default function App() {
  const [roleIdx, setRoleIdx] = useState(1); // start as Government
  const [batches, setBatches] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [claims, setClaims] = useState([]);
  const [orgNames, setOrgNames] = useState({});
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState("");
  const [desc, setDesc] = useState("Evacuation kits x500");
  const [qty, setQty] = useState(500);
  const [donation, setDonation] = useState("0.5");
  const [transferTo, setTransferTo] = useState(3); // default: Local Relief

  // ---- offline-first state ----
  const [online, setOnline] = useState(true);      // simulated connectivity
  const [queue, setQueue] = useState(readQueue);   // vouchers signed but not yet relayed
  const [epochCache, setEpochCache] = useState({}); // last known on-chain epoch per org
  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [voucherQr, setVoucherQr] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const signer = useMemo(
    () => new ethers.Wallet(DEMO_ACCOUNTS[roleIdx].pk, provider),
    [roleIdx]
  );
  const contract = useMemo(
    () => new ethers.Contract(CONTRACT_ADDRESS, ABI, signer),
    [signer]
  );
  // Pays gas for relief orgs once connectivity returns.
  const relayerContract = useMemo(
    () => new ethers.Contract(CONTRACT_ADDRESS, ABI, new ethers.Wallet(RELAYER.pk, provider)),
    []
  );

  const notify = (msg) => { setToast(msg); setTimeout(() => setToast(""), 5000); };

  useEffect(() => { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }, [queue]);

  const addrToRole = useCallback(async (addr) => {
    if (orgNames[addr]) return orgNames[addr];
    try {
      const org = await contract.getOrg(addr);
      if (org.registered) {
        const label = `${org.name} (${ORG_TYPE_LABELS[Number(org.orgType)]})`;
        setOrgNames((m) => ({ ...m, [addr]: label }));
        return label;
      }
    } catch (_) {}
    return roleOfAddress(addr);
  }, [contract, orgNames]);

  const loadBatches = useCallback(async () => {
    if (!online) return; // keep showing the last synced state, like a real field device
    try {
      const next = Number(await contract.nextBatchId());
      const list = [];
      for (let i = 1; i < next; i++) {
        const b = await contract.getBatch(i);
        list.push({
          id: Number(b.id),
          description: b.description,
          quantity: Number(b.quantity),
          creator: b.creator,
          currentHolder: b.currentHolder,
          status: Number(b.status),
          donatedWei: b.donatedWei,
          createdAt: Number(b.createdAt),
          deliveredAt: Number(b.deliveredAt),
        });
      }
      setBatches(list.reverse());
    } catch (e) {
      console.error(e);
      notify("⚠ Cannot reach chain — is `npx hardhat node` running and the contract deployed?");
    }
  }, [contract, online]);

  /**
   * Cache each org's epoch while we still have a network. Unlike a sequential nonce
   * this is not a counter we have to predict — it only moves when an org revokes its
   * vouchers, so a stale cache costs nothing and devices never collide.
   */
  const refreshEpochs = useCallback(async () => {
    if (!online) return;
    try {
      const entries = await Promise.all(
        [1, 2, 3].map(async (i) => [DEMO_ADDRESSES[i], Number(await contract.epochOf(DEMO_ADDRESSES[i]))])
      );
      setEpochCache(Object.fromEntries(entries));
    } catch (_) {}
  }, [contract, online]);

  const loadHistory = useCallback(async (id) => {
    if (!online) return;
    try {
      const raw = await contract.getCustodyHistory(id);
      const rows = [];
      for (const r of raw) {
        rows.push({
          from: await addrToRole(r.from),
          to: await addrToRole(r.to),
          recordedAt: Number(r.recordedAt),
          signedAt: Number(r.signedAt),
          note: r.note,
          offline: r.offline,
        });
      }
      setHistory(rows);

      const rawClaims = await contract.getConflictingClaims(id);
      const claimRows = [];
      for (const c of rawClaims) {
        claimRows.push({
          from: await addrToRole(c.claimedFrom),
          to: await addrToRole(c.claimedTo),
          signedAt: Number(c.signedAt),
          recordedAt: Number(c.recordedAt),
          note: c.note,
          reason: CONFLICT_REASONS[Number(c.reason)] ?? "Unknown",
        });
      }
      setClaims(claimRows);
    } catch (_) {}
  }, [contract, addrToRole, online]);

  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => { refreshEpochs(); }, [refreshEpochs, batches]);
  useEffect(() => {
    provider.getNetwork().then((n) => setChainId(n.chainId)).catch(() => {});
  }, []);
  useEffect(() => {
    if (transferTo === roleIdx) setTransferTo([1, 2, 3].find((i) => i !== roleIdx));
  }, [roleIdx, transferTo]);
  useEffect(() => { if (selectedId) loadHistory(selectedId); }, [selectedId, loadHistory, batches]);

  // ---------- Online actions ----------

  const handleCreate = async () => {
    try {
      const tx = await contract.createBatch(desc, qty);
      await tx.wait();
      notify(`✅ Batch created — QR issued`);
      loadBatches();
    } catch (e) { notify(`❌ ${e.reason || e.message}`); }
  };

  const handleDonate = async (id) => {
    try {
      const tx = await contract.donate(id, { value: ethers.parseEther(donation) });
      await tx.wait();
      notify(`✅ Donated ${donation} ETH to batch #${id}`);
      loadBatches();
    } catch (e) { notify(`❌ ${e.reason || e.message}`); }
  };

  const handleDeliver = async (id) => {
    try {
      // Off-chain proof (photo/receipt) would be hashed here — no PII on-chain
      const proofHash = ethers.keccak256(ethers.toUtf8Bytes(`proof-batch-${id}-${Date.now()}`));
      const tx = await contract.confirmDelivery(id, proofHash);
      await tx.wait();
      notify(`✅ Batch #${id} marked as DELIVERED`);
      loadBatches();
    } catch (e) { notify(`❌ ${e.reason || e.message}`); }
  };

  // ---------- Offline handover vouchers ----------

  /**
   * Signs a handover with NO network access.
   *
   * The voucher is made unique by a locally generated random salt, not by a counter.
   * That is the whole point: two field phones from the same organization can sign at
   * the same moment, neither aware of the other, and both vouchers stay valid. The
   * only cached value is the org's epoch, which moves only on revocation.
   */
  const signHandover = useCallback(async (batchId, note) => {
    const from = DEMO_ADDRESSES[roleIdx];
    const signedAt = Math.floor(Date.now() / 1000);
    const h = {
      batchId: Number(batchId),
      from,
      to: DEMO_ADDRESSES[transferTo],
      note,
      signedAt,
      salt: ethers.hexlify(ethers.randomBytes(32)),
      epoch: epochCache[from] ?? 0,
      deadline: signedAt + VOUCHER_TTL_SECONDS,
    };
    try {
      const signature = await signer.signTypedData(eip712Domain(chainId), HANDOVER_TYPES, h);
      setQueue((q) => [...q, { h, signature }]);
      notify(`📴 Signed offline — #${batchId} → ${DEMO_ACCOUNTS[transferTo].role} · ${queue.length + 1} queued for sync`);
    } catch (e) { notify(`❌ Signing failed: ${e.message}`); }
  }, [roleIdx, transferTo, queue.length, epochCache, signer, chainId]);

  /** One action, two worlds: online it transacts, offline it signs and queues. */
  const handleHandover = async (id, note) => {
    if (!online) return signHandover(id, note);
    try {
      const tx = await contract.transferCustody(id, DEMO_ADDRESSES[transferTo], note);
      await tx.wait();
      notify(`✅ Custody of batch #${id} → ${DEMO_ACCOUNTS[transferTo].role}`);
      loadBatches();
    } catch (e) { notify(`❌ ${e.reason || e.message}`); }
  };

  /**
   * Connectivity restored: the whole outbox becomes ONE transaction, paid by the relayer.
   *
   * Sorted by signedAt first. That field is inside the signed payload, so ordering on it
   * reconstructs the real sequence of handovers even across phones that never met — and
   * the contract enforces the sort so a relayer cannot rewrite history by reordering.
   */
  const syncQueue = async () => {
    if (!queue.length || syncing) return;
    setSyncing(true);
    const ordered = [...queue].sort((a, b) => Number(a.h.signedAt) - Number(b.h.signedAt));
    const n = ordered.length;
    try {
      const tx = await relayerContract.relayHandovers(
        ordered.map((q) => q.h), ordered.map((q) => q.signature)
      );
      const receipt = await tx.wait();

      // Count how many lost a custody race and were filed as claims instead.
      const conflicts = receipt.logs.filter((l) => {
        try { return relayerContract.interface.parseLog(l)?.name === "ConflictingClaimRecorded"; }
        catch { return false; }
      }).length;

      setQueue([]);
      notify(
        `📡 ${n} offline handover(s) in ONE transaction — gas ${receipt.gasUsed.toString()}, paid by the relayer` +
        (conflicts ? ` · ${conflicts} filed as conflicting claim(s)` : "")
      );
      await loadBatches();
    } catch (e) {
      notify(`❌ Sync failed (queue kept): ${e.reason || e.shortMessage || e.message}`);
    } finally { setSyncing(false); }
  };

  /** A voucher scanned off another device's screen. */
  const submitVoucher = async (v) => {
    try {
      const tx = await relayerContract.transferCustodyWithSig(v.h, v.signature);
      const receipt = await tx.wait();
      const conflicted = receipt.logs.some((l) => {
        try { return relayerContract.interface.parseLog(l)?.name === "ConflictingClaimRecorded"; }
        catch { return false; }
      });
      notify(conflicted
        ? `⚠ Batch #${v.h.batchId} had already moved on — filed as a conflicting claim, not discarded`
        : `✅ Offline-signed handover recorded on-chain — batch #${v.h.batchId}`);
      setSelectedId(Number(v.h.batchId));
      await loadBatches();
    } catch (e) { notify(`❌ ${e.reason || e.shortMessage || e.message}`); }
  };

  /** Lost phone: burn every voucher this org signed but hasn't had submitted yet. */
  const handleInvalidate = async () => {
    try {
      const tx = await contract.invalidateVouchers();
      await tx.wait();
      setQueue((q) => q.filter((x) => x.h.from.toLowerCase() !== DEMO_ADDRESSES[roleIdx].toLowerCase()));
      notify(`🔒 Every unsubmitted voucher signed by ${DEMO_ACCOUNTS[roleIdx].role} is now void`);
      refreshEpochs();
    } catch (e) { notify(`❌ ${e.reason || e.message}`); }
  };

  // QR payload is either "reliefchain:<batchId>" or a full signed handover voucher.
  const onScan = (text) => {
    setScanning(false);
    const t = String(text).trim();

    if (t.startsWith("{")) {
      let v;
      try { v = decodeVoucher(t); }
      catch (e) { notify(`❌ Could not read that voucher: ${e.message}`); return; }
      if (online) submitVoucher(v);
      else {
        setQueue((q) => [...q, v]);
        notify("📴 Signed voucher received — added to the sync queue");
      }
      return;
    }

    const m = t.match(/reliefchain:(\d+)/);
    if (!m) { notify("❌ Not a ReliefChain QR"); return; }
    const id = Number(m[1]);
    setSelectedId(id);
    handleHandover(id, `${online ? "QR scan" : "Offline QR"} handover by ${DEMO_ACCOUNTS[roleIdx].role}`);
  };

  const selected = batches.find((b) => b.id === selectedId);
  const myAddress = signer.address;
  const isOrg = roleIdx >= 1 && roleIdx <= 3;

  // Queued vouchers that move the same batch out of the same holder. Only one can
  // win on sync, so say so before the relayer spends gas finding out.
  const clashes = useMemo(() => findClashes(queue), [queue]);
  const orderedQueue = useMemo(
    () => queue.map((q, i) => ({ q, i })).sort((a, b) => Number(a.q.h.signedAt) - Number(b.q.h.signedAt)),
    [queue]
  );

  return (
    <div className="app">
      <header>
        <h1>🔗 ReliefChain</h1>
        <p className="tagline">Transparent disaster relief tracking · SDG 16</p>
        <div className="role-bar">
          <span>Acting as:</span>
          {DEMO_ACCOUNTS.map((a, i) => (
            <button key={a.role} className={i === roleIdx ? "role active" : "role"}
              onClick={() => setRoleIdx(i)}>{a.role}</button>
          ))}
          <button className={`net ${online ? "up" : "down"}`} onClick={() => setOnline((v) => !v)}>
            {online ? "📶 Network up" : "📴 No connectivity"}
          </button>
        </div>
        {!online && (
          <div className="offline-banner">
            📴 <strong>Offline mode</strong> — comms are down, the way they are in a real disaster zone. Handovers are
            signed on the phone with <strong>EIP-712</strong> and queued. Reading the chain, creating batches and
            confirming delivery are unavailable; what you see is the last synced state.
          </div>
        )}
      </header>

      {toast && <div className="toast">{toast}</div>}

      <main>
        <section className="panel">
          <h2>Actions — {DEMO_ACCOUNTS[roleIdx].role}</h2>

          {isOrg && (
            <div className="action-box">
              <h3>Create relief batch</h3>
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description" />
              <input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} />
              <button onClick={handleCreate} disabled={!online}>Create batch + issue QR</button>
              {!online && <p className="hint">Creating a batch is an on-chain transaction, so it needs connectivity.</p>}
            </div>
          )}

          {roleIdx === 4 && (
            <div className="action-box">
              <h3>Donate to a batch</h3>
              <input value={donation} onChange={(e) => setDonation(e.target.value)} placeholder="ETH" />
              <p className="hint">Select a batch below, then donate.</p>
              {selected && (
                <button className="go" onClick={() => handleDonate(selected.id)} disabled={!online}>
                  Donate {donation} ETH → batch #{selected.id}
                </button>
              )}
            </div>
          )}

          {isOrg && (
            <div className="action-box">
              <h3>Receive / hand over supplies</h3>
              <label>Transfer to: </label>
              <select value={transferTo} onChange={(e) => setTransferTo(Number(e.target.value))}>
                {[1, 2, 3].filter((i) => i !== roleIdx).map((i) => (
                  <option key={i} value={i}>{DEMO_ACCOUNTS[i].role}</option>
                ))}
              </select>
              <button className="go" onClick={() => setScanning(true)}>
                {online ? "📷 Scan QR to transfer" : "📷 Scan QR to sign offline"}
              </button>
              {selected && selected.currentHolder === myAddress && selected.status !== 2 && (
                <>
                  <button className="go" onClick={() => handleHandover(selected.id, online ? "Manual handover" : "Offline manual handover")}>
                    {online ? `Transfer batch #${selected.id} (no camera)` : `Sign handover of #${selected.id} offline`}
                  </button>
                  <button className="deliver" onClick={() => handleDeliver(selected.id)} disabled={!online}>
                    ✅ Confirm final delivery of #{selected.id}
                  </button>
                </>
              )}
              <p className="hint">
                Signing offline costs no gas — the relayer pays it, so relief orgs never need to hold ETH.
              </p>
              <button className="danger" onClick={handleInvalidate} disabled={!online}>
                🔒 Report phone lost (void all unsubmitted vouchers)
              </button>
            </div>
          )}

          {scanning && <QRScanner onScan={onScan} onClose={() => setScanning(false)} />}
        </section>

        <section className="panel">
          <h2>
            Relief batches <button className="refresh" onClick={loadBatches} disabled={!online}>↻</button>
            {!online && <span className="badge stale">last synced state</span>}
          </h2>
          {batches.length === 0 && <p className="hint">No batches yet — deploy script seeds one, or create above.</p>}
          {batches.map((b) => (
            <div key={b.id}
              className={`batch status-${b.status} ${selectedId === b.id ? "selected" : ""}`}
              onClick={() => setSelectedId(b.id)}>
              <div className="batch-head">
                <strong>#{b.id} · {b.description}</strong>
                <span className={`badge s${b.status}`}>{STATUS_LABELS[b.status]}</span>
              </div>
              <div className="batch-meta">
                Qty {b.quantity} · Donations {ethers.formatEther(b.donatedWei)} ETH
              </div>
            </div>
          ))}
        </section>

        {queue.length > 0 && (
          <section className="panel wide outbox">
            <h2>
              📴 Offline outbox — signed, awaiting on-chain record <span className="count">{queue.length}</span>
            </h2>
            <p className="hint">
              Handover vouchers signed with no connectivity, listed in the order they will be relayed —
              oldest signature first, so the chain ends up with the real field sequence. The signature itself is the
              evidence, so submitting them later still records <strong>the moment the supplies actually changed hands</strong>.
            </p>
            {clashes.size > 0 && (
              <p className="clash-warning">
                ⚠ <strong>{clashes.size} vouchers move the same batch out of the same holder.</strong> Only the earliest
                can take custody — the rest will be filed as conflicting claims for someone to reconcile. Nothing is lost,
                but the field record disagrees with itself.
              </p>
            )}
            {orderedQueue.map(({ q, i }) => (
              <div className={`voucher${clashes.has(i) ? " clashing" : ""}`} key={q.h.salt}>
                <div className="batch-head">
                  <strong>#{Number(q.h.batchId)} · {roleOfAddress(q.h.from)} → {roleOfAddress(q.h.to)}</strong>
                  {clashes.has(i) && <span className="badge clash">conflicts</span>}
                </div>
                <div className="batch-meta">
                  Signed {fmt(q.h.signedAt)} · expires {fmt(q.h.deadline)} · <em>{q.h.note}</em>
                </div>
                <div className="voucher-actions">
                  <button className="ghost" onClick={() => setVoucherQr(encodeVoucher(q))}>
                    ▣ Voucher QR (hand to another device)
                  </button>
                  <button className="ghost" onClick={() => setQueue((qs) => qs.filter((_, j) => j !== i))}>
                    Discard
                  </button>
                </div>
              </div>
            ))}
            <button className="sync" onClick={syncQueue} disabled={!online || syncing}>
              {syncing ? "Syncing…" : `📡 Signal restored — relay all ${queue.length} in ONE transaction`}
            </button>
            {!online && <p className="hint">Available once the network is back.</p>}
          </section>
        )}

        {selected && (
          <section className="panel wide">
            <h2>Batch #{selected.id} — traceability</h2>
            <div className="qr-box">
              <QRCodeSVG value={`reliefchain:${selected.id}`} size={140} />
              <p className="hint">Print / show this QR on the physical supplies</p>
            </div>
            <ol className="timeline">
              <li>
                <span className="dot created" />
                <div><strong>Batch created</strong><br />
                  {fmt(selected.createdAt)}</div>
              </li>
              {history.map((h, i) => (
                <li key={i}>
                  <span className={`dot ${h.offline ? "offline" : "transit"}`} />
                  <div>
                    <strong>{h.from} → {h.to}</strong>
                    {h.offline && <span className="badge offline-tag">📴 signed offline · relayed</span>}
                    <br />
                    {h.offline ? (
                      <>
                        Field handover <strong>{fmt(h.signedAt)}</strong><br />
                        <span className="sub">Recorded on-chain {fmt(h.recordedAt)} · synced {humanDuration(h.recordedAt - h.signedAt)} later</span>
                      </>
                    ) : fmt(h.recordedAt)}
                    <br /><em>{h.note}</em>
                  </div>
                </li>
              ))}
              {selected.status === 2 && (
                <li>
                  <span className="dot delivered" />
                  <div><strong>✅ Delivered</strong><br />
                    {fmt(selected.deliveredAt)}<br />
                    <em>Delivery proof hash stored on-chain (no PII)</em></div>
                </li>
              )}
            </ol>

            {claims.length > 0 && (
              <div className="claims">
                <h3>⚠ Conflicting claims <span className="count">{claims.length}</span></h3>
                <p className="hint">
                  Handovers that were validly signed in the field but arrived after custody had already moved on.
                  Custody went to whoever synced first; these are kept — signed and attributed — so a handover that
                  really happened is never erased. Each one needs a human to reconcile.
                </p>
                {claims.map((c, i) => (
                  <div className="claim" key={i}>
                    <div className="batch-head">
                      <strong>{c.from} → {c.to}</strong>
                      <span className="badge clash">{c.reason}</span>
                    </div>
                    <div className="batch-meta">
                      Claimed handover {fmt(c.signedAt)} · filed {fmt(c.recordedAt)} · <em>{c.note}</em>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {voucherQr && (
        <div className="scanner-overlay" onClick={() => setVoucherQr(null)}>
          <div className="scanner-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Signed handover voucher</h3>
            <p className="hint">Scan this from a device that still has a signal and it will submit the handover for you.</p>
            <QRCodeSVG value={voucherQr} size={260} level="L" />
            <button onClick={() => setVoucherQr(null)}>Close</button>
          </div>
        </div>
      )}

      <footer>
        No victim personal data is stored on-chain — only custody records and off-chain proof hashes.<br />
        Handovers are signable offline (EIP-712) and relayed later, so relief orgs need neither connectivity nor ETH.
      </footer>
    </div>
  );
}
