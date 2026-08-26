const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ReliefChain", function () {
  let relief, addr, chainId;
  let admin, gov, ngo, local, donor, stranger, relayer;

  const HANDOVER_TYPES = {
    Handover: [
      { name: "batchId", type: "uint256" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "note", type: "string" },
      { name: "signedAt", type: "uint256" },
      { name: "nonce", type: "uint256" },
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
      nonce: await relief.nonces(signer.address),
      deadline: t + 3600,
      ...overrides,
    };
    const domain = { name: "ReliefChain", version: "1", chainId, verifyingContract: addr };
    const signature = await signer.signTypedData(domain, HANDOVER_TYPES, h);
    return { h, signature };
  }

  beforeEach(async () => {
    [admin, gov, ngo, local, donor, stranger, relayer] = await ethers.getSigners();
    const ReliefChain = await ethers.getContractFactory("ReliefChain");
    relief = await ReliefChain.deploy();
    addr = await relief.getAddress();
    chainId = (await ethers.provider.getNetwork()).chainId;

    await relief.registerOrg(gov.address, "Ministry of Interior", 0);   // Government
    await relief.registerOrg(ngo.address, "Global Relief NGO", 1);      // NGO
    await relief.registerOrg(local.address, "Local Relief Group", 2);   // LocalRelief
  });

  // ---------------- Core flow ----------------

  it("full flow: donate -> create -> transfer x2 -> deliver", async () => {
    // Government creates a batch (QR issued with batchId = 1)
    await expect(relief.connect(gov).createBatch("Emergency food kits x500", 500))
      .to.emit(relief, "BatchCreated").withArgs(1, gov.address, "Emergency food kits x500", 500);

    // Donor attaches funds
    await expect(relief.connect(donor).donate(1, { value: ethers.parseEther("1.0") }))
      .to.emit(relief, "DonationReceived").withArgs(1, donor.address, ethers.parseEther("1.0"));

    // Gov -> NGO (QR scanned at warehouse, online)
    await expect(relief.connect(gov).transferCustody(1, ngo.address, "Central warehouse handover"))
      .to.emit(relief, "CustodyTransferred")
      .withArgs(1, gov.address, ngo.address, "Central warehouse handover", false, anyUint());

    // NGO -> Local relief group
    await relief.connect(ngo).transferCustody(1, local.address, "Regional depot handover");

    // Local group confirms final delivery with off-chain proof hash
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

  // ---------------- Offline handover vouchers (EIP-712) ----------------

  describe("offline handover vouchers", () => {
    beforeEach(async () => {
      await relief.connect(gov).createBatch("Emergency food kits x500", 500);
    });

    it("a relayer can submit a handover signed offline, and the org spends no gas", async () => {
      const { h, signature } = await signVoucher(gov, { note: "Handover at Pohang camp (offline)" });
      const govBalanceBefore = await ethers.provider.getBalance(gov.address);

      await expect(relief.connect(relayer).transferCustodyWithSig(h, signature))
        .to.emit(relief, "CustodyTransferred")
        .withArgs(1, gov.address, ngo.address, "Handover at Pohang camp (offline)", true, h.signedAt);

      // The signing org never touched the network — its balance is untouched.
      expect(await ethers.provider.getBalance(gov.address)).to.equal(govBalanceBefore);

      const batch = await relief.getBatch(1);
      expect(batch.currentHolder).to.equal(ngo.address);
      expect(batch.status).to.equal(1); // InTransit

      const [rec] = await relief.getCustodyHistory(1);
      expect(rec.offline).to.equal(true);
      expect(rec.signedAt).to.equal(h.signedAt);           // when it physically happened
      expect(rec.recordedAt).to.be.gte(rec.signedAt);      // when the chain heard about it
      expect(await relief.nonces(gov.address)).to.equal(1);
    });

    it("relays a whole offline queue in a single transaction", async () => {
      // Two handovers signed hours apart in the field, both with no connectivity.
      const first = await signVoucher(gov, { to: ngo.address, note: "Camp -> NGO truck" });
      const second = await signVoucher(ngo, { to: local.address, note: "NGO truck -> village" });

      const tx = await relief
        .connect(relayer)
        .relayHandovers([first.h, second.h], [first.signature, second.signature]);
      await tx.wait();

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

      // Same voucher, submitted again — nonce has already moved on.
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Bad nonce");
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
      // stranger signs, but the voucher claims to come from the Government
      const t = await now();
      const h = {
        batchId: 1,
        from: gov.address,
        to: ngo.address,
        note: "forged",
        signedAt: t,
        nonce: await relief.nonces(gov.address),
        deadline: t + 3600,
      };
      const domain = { name: "ReliefChain", version: "1", chainId, verifyingContract: addr };
      const signature = await stranger.signTypedData(domain, HANDOVER_TYPES, h);

      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Bad signature");
    });

    it("rejects a validly signed voucher from an org that isn't holding the batch", async () => {
      const { h, signature } = await signVoucher(ngo, { to: local.address, note: "not mine to give" });
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Not current holder");
    });

    it("rejects a voucher signed for a different chain", async () => {
      const t = await now();
      const h = {
        batchId: 1, from: gov.address, to: ngo.address, note: "wrong chain",
        signedAt: t, nonce: await relief.nonces(gov.address), deadline: t + 3600,
      };
      const domain = { name: "ReliefChain", version: "1", chainId: 999999n, verifyingContract: addr };
      const signature = await gov.signTypedData(domain, HANDOVER_TYPES, h);

      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Bad signature");
    });

    it("invalidateVouchers burns every outstanding voucher (lost phone)", async () => {
      const { h, signature } = await signVoucher(gov);

      await expect(relief.connect(gov).invalidateVouchers())
        .to.emit(relief, "VouchersInvalidated").withArgs(gov.address, 1);

      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, signature)
      ).to.be.revertedWith("Bad nonce");
    });

    it("a bad voucher reverts the entire relay, never silently dropped", async () => {
      const good = await signVoucher(gov, { to: ngo.address, note: "ok" });
      const bad = await signVoucher(ngo, { to: local.address, note: "expired", deadline: 1 });

      await expect(
        relief.connect(relayer).relayHandovers([good.h, bad.h], [good.signature, bad.signature])
      ).to.be.revertedWith("Voucher expired");

      // Nothing was written — the good voucher is still spendable.
      expect((await relief.getCustodyHistory(1)).length).to.equal(0);
      expect(await relief.nonces(gov.address)).to.equal(0);
    });

    it("rejects a malformed signature and a mismatched relay", async () => {
      const { h } = await signVoucher(gov);
      await expect(
        relief.connect(relayer).transferCustodyWithSig(h, "0x1234")
      ).to.be.revertedWith("Bad sig length");
      await expect(
        relief.connect(relayer).relayHandovers([h], [])
      ).to.be.revertedWith("Length mismatch");
    });

    it("the on-chain digest matches what a phone signs offline", async () => {
      const { h, signature } = await signVoucher(gov);
      const domain = { name: "ReliefChain", version: "1", chainId, verifyingContract: addr };

      // The phone can verify, with no node, that it is signing the right thing.
      expect(await relief.hashHandover(h)).to.equal(
        ethers.TypedDataEncoder.hash(domain, HANDOVER_TYPES, h)
      );
      expect(ethers.verifyTypedData(domain, HANDOVER_TYPES, h, signature)).to.equal(gov.address);
    });
  });
});

/** chai matcher helper: accept any uint (block timestamps we don't control) */
function anyUint() {
  const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
  return anyValue;
}
