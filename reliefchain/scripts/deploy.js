const { ethers } = require("hardhat");

async function main() {
  const [admin, gov, ngo, local, , relayer] = await ethers.getSigners();

  const ReliefChain = await ethers.getContractFactory("ReliefChain");
  const relief = await ReliefChain.deploy();
  await relief.waitForDeployment();
  const addr = await relief.getAddress();
  console.log("ReliefChain deployed to:", addr);

  // Seed demo organizations for the scenario: a Canadian wildfire evacuation, where
  // fire takes out the cell towers before it takes out the road.
  // Local node only — on testnet, register the real org addresses.
  if (gov && ngo && local) {
    await (await relief.registerOrg(gov.address, "Public Safety Canada", 0)).wait();
    await (await relief.registerOrg(ngo.address, "Canadian Red Cross", 1)).wait();
    await (await relief.registerOrg(local.address, "Yellowknife ESS", 2)).wait();
    console.log("Demo orgs registered:");
    console.log("  Government :", gov.address, "Public Safety Canada");
    console.log("  NGO        :", ngo.address, "Canadian Red Cross");
    console.log("  Local      :", local.address, "Yellowknife ESS");

    console.log("  Relayer    :", relayer.address, "(pays gas for offline-signed handovers)");

    // Seed one demo batch so the dashboard isn't empty
    await (await relief.connect(gov).createBatch("Evacuation kits x500", 500)).wait();
    console.log("Demo batch #1 created (holder: Public Safety Canada)");
  }

  console.log("\nPut this address into frontend/src/config.js");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
