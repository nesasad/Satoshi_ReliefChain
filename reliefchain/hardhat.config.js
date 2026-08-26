require("@nomicfoundation/hardhat-toolbox");

/**
 * Usage:
 *  - Local demo:   npx hardhat node   (in one terminal)
 *                  npx hardhat run scripts/deploy.js --network localhost
 *  - Testnet:      set SEPOLIA_RPC_URL + PRIVATE_KEY env vars, then
 *                  npx hardhat run scripts/deploy.js --network sepolia
 */
module.exports = {
  solidity: "0.8.24",
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    ...(process.env.SEPOLIA_RPC_URL
      ? {
          sepolia: {
            url: process.env.SEPOLIA_RPC_URL,
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
          },
        }
      : {}),
  },
};
