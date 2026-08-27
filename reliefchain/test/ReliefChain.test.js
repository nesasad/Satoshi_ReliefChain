const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("ReliefChain", function () {
  let relief, addr, chainId, domain;
  let admin, gov, ngo, local, donor, stranger, relayer;

  const NOT_CURRENT_HOLDER = 0; // ConflictReason.NotCurrentHolder
  const ALREADY_DELIVERED = 1;  // ConflictReason.AlreadyDelivered

  const HANDOVER_TYPES = {
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

  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

  /** Build + EIP-712-sign a handover voucher, exactly as an offline phone would. */
  async function signVoucher(signer, overrides = {}) {
    const t = await now();
    const h = {
      batchId: 1,
      from: signer.address,
      to: ngo.address,
      note: "Central warehouse handover",
      signedAt: t,
      salt: ethers.hexlify(ethers.randomBytes(32)),
      epoch: await relief.epochOf(signer.address),
      deadline: t + 3600,
      ...overrides,
    };
    return { h, signature: await signer.signTypedData(domain, HANDOVER_TYPES, h) };
  }

  beforeEach(async () => {
    [admin, gov, ngo, local, donor, stranger, relayer] = await ethers.getSigners();
    relief = await (await ethers.getContractFactory("ReliefChain")).deploy();
    addr = await relief.getAddress();
    chainId = (await ethers.provider.getNetwork()).chainId;
    domain = { name: "ReliefChain", version: "2", chainId, verifyingContract: addr };

    await relief.registerOrg(gov.address, "Public Safety Canada", 0);   // Government
    await relief.registerOrg(ngo.address, "Canadian Red Cross", 1);     // NGO
    await relief.registerOrg(local.address, "Yellowknife ESS", 2);      // LocalRelief
  });

  // ---------------- Core flow ----------------

  it("full flow: donate -> create -> transfer x2 -> deliver", async () => {
    await expect(relief.connect(gov).createBatch("Evacuation kits x500", 500))
      .to.emit(relief, "BatchCreated").withArgs(1, gov.address, "Evacuation kits x500", 500);

    await expect(relief.connect(donor).donate(1, { value: ethers.parseEther("1.0") }))
      .to.emit(relief, "DonationReceived").withArgs(1, donor.address, ethers.parseEther("1.0"));

    await expect(relief.connect(gov).transferCustody(1, ngo.address, "Staging area handover"))
      .to.emit(relief, "CustodyTransferred")
      .withArgs(1, gov.address, ngo.address, "Staging area handover", false, anyValue);

    await relief.connect(ngo).transferCustody(1, local.address, "Reception centre handover");

    const proofHash = ethers.keccak256(ethers.toUtf8Bytes("delivery-proof-photo-001"));
    await expect(relief.connect(local).confirmDelivery(1, proofHash))
      .to.emit(relief, "DeliveryConfirmed").withArgs(1, local.address, proofHash);

    const batch = await relief.getBatch(1);
    expect(batch.status).to.equal(2); // Delivered
    expect(batch.donatedWei).to.equal(ethers.parseEther("1.0"));
    expect(batch.currentHolder).to.equal(local.address);

    const history = await relief.getCustodyHistory(1);
    expect(history.length).to.equal(2);
    expect(history[0].from).to.equal(gov.address);
    expect(history[0].offline).to.equal(false);
    expect(history[1].to).to.equal(local.address);
  });

  it("rejects transfer by non-holder", async () => {
    await relief.connect(gov).createBatch("Water bottles x1000", 1000);
    await expect(
      relief.connect(ngo).transferCustody(1, local.address, "sneaky")
    ).to.be.revertedWith("Not current holder");
  });

  it("rejects transfer to unregistered org", async () => {
    await relief.connect(gov).createBatch("Blankets x300", 300);
    await expect(
      relief.connect(gov).transferCustody(1, stranger.address, "oops")
    ).to.be.revertedWith("Recipient not registered");
  });

  it("rejects batch creation by unregistered address", async () => {
    await expect(
      relief.connect(stranger).createBatch("Fake batch", 1)
    ).to.be.revertedWith("Not a registered org");
  });

  it("rejects actions after delivery", async () => {
    await relief.connect(gov).createBatch("Medkits x100", 100);
    await relief.connect(gov).transferCustody(1, local.address, "direct");
    await relief.connect(local).confirmDelivery(1, ethers.ZeroHash);

    await expect(
      relief.connect(local).transferCustody(1, ngo.address, "late")
    ).to.be.revertedWith("Already delivered");
    await expect(
      relief.connect(donor).donate(1, { value: 1 })
    ).to.be.revertedWith("Already delivered");
  });

  it("only admin can register orgs", async () => {
    await expect(
      relief.connect(stranger).registerOrg(stranger.address, "Evil Org", 1)
    ).to.be.revertedWith("Not admin");
  });

  // ---------------- Offline handover vouchers ----------------

  describe("offline handover vouchers", () => {
    beforeEach(async () => {
      await relief.connect(gov).createBatch("Evacuation kits x500", 500);
    });

    it("a relayer can submit a handover signed offline, and the org spends no gas", async () => {
      const { h, signature } = await signVoucher(gov, { note: "Highway 3 checkpoint (offline)" });
      const govBalanceBefore = await ethers.provider.getBalance(gov.address);

      await expect(relief.connect(relayer).transferCustodyWithSig(h, signature))
        .to.emit(relief, "CustodyTransferred")
        .withArgs(1, gov.address, ngo.address, "Highway 3 checkpoint (offline)", true, h.signedAt);

      expect(await ethers.provider.getBalance(gov.address)).to.equal(govBalanceBefore);

      const [rec] = await relief.getCustodyHistory(1);
      expect(rec.offline).to.equal(true);
      expect(rec.signedAt).to.equal(h.signedAt);
      expect(rec.recordedAt).to.be.gte(rec.signedAt);
      expect((await relief.getBatch(1)).currentHolder).to.equal(ngo.address);
    });

    it("relays a whole offline queue in a single transaction", async () => {
      const t = await now();
      const first = await signVoucher(gov, { to: ngo.address, note: "Camp -> Red Cross truck", signedAt: t - 7200 });
      const second = await signVoucher(ngo, { to: local.address, note: "Truck -> reception centre", signedAt: t - 3600 });

      await relief.connect(relayer).relayHandovers([first.h, second.h], [first.signature, second.signature]);

      const history = await relief.getCustodyHistory(1);
      expect(history.length).to.equal(2);
      expect(history[0].from).to.equal(gov.address);
      expect(history[1].to).to.equal(local.address);
      expect(history.every((r) => r.offline)).to.equal(true);
      expect((await relief.getBatch(1)).currentHolder).to.equal(local.address);
    });

    it("rejects a replayed voucher", async () => {
      const { h, signature } = await signVoucher(gov);
      await relief.connect(relayer).transferCustodyWithSig(h, signature);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Voucher already used");
    });

    it("rejects an expired voucher", async () => {
      const t = await now();
      const { h, signature } = await signVoucher(gov, { deadline: t + 60 });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Voucher expired");
    });

    it("rejects a voucher backdated into the future", async () => {
      const t = await now();
      const { h, signature } = await signVoucher(gov, { signedAt: t + 3600 });
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("signedAt in future");
    });

    it("rejects a forged voucher (signer is not the claimed holder)", async () => {
      const t = await now();
      const h = {
        batchId: 1, from: gov.address, to: ngo.address, note: "forged",
        signedAt: t, salt: ethers.hexlify(ethers.randomBytes(32)),
        epoch: 0, deadline: t + 3600,
      };
      const signature = await stranger.signTypedData(domain, HANDOVER_TYPES, h);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Bad signature");
    });

    it("rejects a voucher signed for a different chain", async () => {
      const { h } = await signVoucher(gov);
      const wrongDomain = { ...domain, chainId: 999999n };
      const signature = await gov.signTypedData(wrongDomain, HANDOVER_TYPES, h);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Bad signature");
    });

    it("rejects a voucher from an unregistered signer", async () => {
      const t = await now();
      const h = {
        batchId: 1, from: stranger.address, to: ngo.address, note: "who?",
        signedAt: t, salt: ethers.hexlify(ethers.randomBytes(32)),
        epoch: 0, deadline: t + 3600,
      };
      const signature = await stranger.signTypedData(domain, HANDOVER_TYPES, h);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Signer not a registered org");
    });

    it("rejects a malformed signature and a mismatched relay", async () => {
      const { h } = await signVoucher(gov);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, "0x1234")
      ).to.be.revertedWith("Bad sig length");
      await expect(relief.connect(relayer).relayHandovers([h], [])).to.be.revertedWith("Length mismatch");
      await expect(relief.connect(relayer).relayHandovers([], [])).to.be.revertedWith("Empty relay");
    });

    it("the on-chain digest matches what a phone signs offline", async () => {
      const { h, signature } = await signVoucher(gov);
      expect(await relief.hashHandover(h)).to.equal(
        ethers.TypedDataEncoder.hash(domain, HANDOVER_TYPES, h)
      );
      expect(ethers.verifyTypedData(domain, HANDOVER_TYPES, h, signature)).to.equal(gov.address);
    });
  });

  // ---------------- Parallel offline signing (no nonce collisions) ----------------

  describe("parallel offline signing", () => {
    beforeEach(async () => {
      await relief.connect(gov).createBatch("Evacuation kits x500", 500);   // batch 1
      await relief.connect(gov).createBatch("Water bottles x1000", 1000);   // batch 2
    });

    it("two devices of the same org can sign different batches offline and BOTH land", async () => {
      // The regression this replaces: with a sequential per-org nonce both devices
      // computed the same value and one perfectly good handover was silently rejected.
      const t = await now();
      const deviceA = await signVoucher(gov, { batchId: 1, to: ngo.address, note: "device A", signedAt: t - 600 });
      const deviceB = await signVoucher(gov, { batchId: 2, to: local.address, note: "device B", signedAt: t - 300 });

      const res = await relief.connect(relayer).relayHandovers.staticCall(
        [deviceA.h, deviceB.h], [deviceA.signature, deviceB.signature]
      );
      expect(res[0]).to.equal(2n); // both took custody
      expect(res[1]).to.equal(0n); // no conflicts

      await relief.connect(relayer).relayHandovers(
        [deviceA.h, deviceB.h], [deviceA.signature, deviceB.signature]
      );
      expect((await relief.getBatch(1)).currentHolder).to.equal(ngo.address);
      expect((await relief.getBatch(2)).currentHolder).to.equal(local.address);
    });

    it("vouchers may be submitted in any order across devices", async () => {
      const t = await now();
      const a = await signVoucher(gov, { batchId: 1, to: ngo.address, signedAt: t - 600 });
      const b = await signVoucher(gov, { batchId: 2, to: local.address, signedAt: t - 300 });

      // b first, a second — no sequencing between independent batches
      await relief.connect(relayer).transferCustodyWithSig(b.h, b.signature);
      await relief.connect(relayer).transferCustodyWithSig(a.h, a.signature);

      expect((await relief.getBatch(1)).currentHolder).to.equal(ngo.address);
      expect((await relief.getBatch(2)).currentHolder).to.equal(local.address);
    });

    it("a relay must be sorted by signedAt so the physical order is reconstructed", async () => {
      const t = await now();
      const earlier = await signVoucher(gov, { batchId: 1, to: ngo.address, signedAt: t - 7200 });
      const later = await signVoucher(gov, { batchId: 2, to: local.address, signedAt: t - 60 });

      await expect(
        relief.connect(relayer).relayHandovers([later.h, earlier.h], [later.signature, earlier.signature])
      ).to.be.revertedWith("Vouchers must be sorted by signedAt");

      await relief.connect(relayer).relayHandovers(
        [earlier.h, later.h], [earlier.signature, later.signature]
      );
      const [rec1] = await relief.getCustodyHistory(1);
      const [rec2] = await relief.getCustodyHistory(2);
      expect(rec1.signedAt).to.be.lt(rec2.signedAt);
    });

    it("invalidateVouchers burns every outstanding voucher across all devices", async () => {
      const a = await signVoucher(gov, { batchId: 1, to: ngo.address, note: "device A" });
      const b = await signVoucher(gov, { batchId: 2, to: local.address, note: "device B" });

      await expect(relief.connect(gov).invalidateVouchers())
        .to.emit(relief, "VouchersInvalidated").withArgs(gov.address, 1);

      for (const v of [a, b]) {
        await expect(
          relief.connect(relayer).transferCustodyWithSig(v.h, v.signature)
        ).to.be.revertedWith("Voucher revoked");
      }

      // A voucher signed after the bump carries the new epoch and works again.
      const fresh = await signVoucher(gov, { batchId: 1, to: ngo.address });
      expect(fresh.h.epoch).to.equal(1n);
      await relief.connect(relayer).transferCustodyWithSig(fresh.h, fresh.signature);
      expect((await relief.getBatch(1)).currentHolder).to.equal(ngo.address);
    });
  });

  // ---------------- The conflict rule ----------------

  describe("conflict rule: two workers sign the same batch offline", () => {
    beforeEach(async () => {
      await relief.connect(gov).createBatch("Evacuation kits x500", 500);
    });

    it("first to sync wins custody; the loser is filed as a claim, not discarded", async () => {
      const t = await now();
      // Both workers hold the Government key, both offline, neither aware of the other.
      const workerA = await signVoucher(gov, { to: ngo.address, note: "handed to Red Cross truck", signedAt: t - 3600 });
      const workerB = await signVoucher(gov, { to: local.address, note: "handed to ESS van", signedAt: t - 1800 });

      const res = await relief.connect(relayer).relayHandovers.staticCall(
        [workerA.h, workerB.h], [workerA.signature, workerB.signature]
      );
      expect(res[0]).to.equal(1n); // one took custody
      expect(res[1]).to.equal(1n); // one conflicted

      await expect(
        relief.connect(relayer).relayHandovers(
          [workerA.h, workerB.h], [workerA.signature, workerB.signature]
        )
      ).to.emit(relief, "ConflictingClaimRecorded")
       .withArgs(1, gov.address, local.address, workerB.h.signedAt, NOT_CURRENT_HOLDER);

      // Custody went to the first voucher.
      expect((await relief.getBatch(1)).currentHolder).to.equal(ngo.address);
      expect((await relief.getCustodyHistory(1)).length).to.equal(1);

      // The losing handover survives, attributed and timestamped.
      const claims = await relief.getConflictingClaims(1);
      expect(claims.length).to.equal(1);
      expect(claims[0].claimedFrom).to.equal(gov.address);
      expect(claims[0].claimedTo).to.equal(local.address);
      expect(claims[0].note).to.equal("handed to ESS van");
      expect(claims[0].signedAt).to.equal(workerB.h.signedAt);
      expect(claims[0].reason).to.equal(NOT_CURRENT_HOLDER);
    });

    it("a conflict never aborts the relay — unrelated handovers still land", async () => {
      await relief.connect(gov).createBatch("Cots x200", 200); // batch 2, held by gov
      const t = await now();
      const winner   = await signVoucher(gov, { batchId: 1, to: ngo.address, signedAt: t - 5400 });
      const loser    = await signVoucher(gov, { batchId: 1, to: local.address, signedAt: t - 3600 });
      const unrelated = await signVoucher(gov, { batchId: 2, to: local.address, signedAt: t - 1800 });

      await relief.connect(relayer).relayHandovers(
        [winner.h, loser.h, unrelated.h],
        [winner.signature, loser.signature, unrelated.signature]
      );

      expect((await relief.getBatch(1)).currentHolder).to.equal(ngo.address);
      expect((await relief.getBatch(2)).currentHolder).to.equal(local.address); // unaffected
      expect((await relief.getConflictingClaims(1)).length).to.equal(1);
    });

    it("a handover signed before a delivery that synced first is filed as AlreadyDelivered", async () => {
      const t = await now();
      const late = await signVoucher(ngo, { to: local.address, note: "late arrival", signedAt: t - 60 });

      // Meanwhile the batch reached its destination and was closed out online.
      await relief.connect(gov).transferCustody(1, ngo.address, "online hop");
      await relief.connect(ngo).transferCustody(1, local.address, "online hop 2");
      await relief.connect(local).confirmDelivery(1, ethers.ZeroHash);

      await expect(relief.connect(relayer).transferCustodyWithSig(late.h, late.signature))
        .to.emit(relief, "ConflictingClaimRecorded")
        .withArgs(1, ngo.address, local.address, late.h.signedAt, ALREADY_DELIVERED);

      const claims = await relief.getConflictingClaims(1);
      expect(claims[0].reason).to.equal(ALREADY_DELIVERED);
      expect((await relief.getBatch(1)).status).to.equal(2); // still Delivered
    });

    it("a losing voucher is spent, so it cannot be filed twice", async () => {
      const t = await now();
      const winner = await signVoucher(gov, { to: ngo.address, signedAt: t - 3600 });
      const loser  = await signVoucher(gov, { to: local.address, signedAt: t - 1800 });

      await relief.connect(relayer).transferCustodyWithSig(winner.h, winner.signature);
      await relief.connect(relayer).transferCustodyWithSig(loser.h, loser.signature);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(loser.h, loser.signature)
      ).to.be.revertedWith("Voucher already used");

      expect((await relief.getConflictingClaims(1)).length).to.equal(1);
    });

    it("the online path still reverts on a losing race — the caller is there to see it", async () => {
      await relief.connect(gov).transferCustody(1, ngo.address, "gov -> ngo");
      await expect(
        relief.connect(gov).transferCustody(1, local.address, "gov again")
      ).to.be.revertedWith("Not current holder");
      expect((await relief.getConflictingClaims(1)).length).to.equal(0);
    });
  });
});
