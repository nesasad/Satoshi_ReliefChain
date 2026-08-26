const { ethers } = require("hardhat");

async function main() {
  const [admin, gov, ngo, local, , relayer] = await ethers.getSigners();

  const ReliefChain = await ethers.getContractFactory("ReliefChain");
  const relief = await ReliefChain.deploy();
  await relief.waitForDeployment();
  const addr = await relief.getAddress();
  console.log("ReliefChain deployed to:", addr);

  // Seed demo organizations (local node only — on testnet, register real addresses)
  if (gov && ngo && local) {
    await (await relief.registerOrg(gov.address, "Ministry of Interior & Safety", 0)).wait();
    await (await relief.registerOrg(ngo.address, "Global Relief NGO", 1)).wait();
    await (await relief.registerOrg(local.address, "Local Relief Group", 2)).wait();
    console.log("Demo orgs registered:");
    console.log("  Government :", gov.address);
    console.log("  NGO        :", ngo.address);
    console.log("  Local      :", local.address);

    console.log("  Relayer    :", relayer.address, "(pays gas for offline-signed handovers)");

    // Seed one demo batch so the dashboard isn't empty
    await (await relief.connect(gov).createBatch("Emergency food kits x500", 500)).wait();
    console.log("Demo batch #1 created (holder: Government)");
  }

  console.log("\nPut this address into frontend/src/config.js");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
