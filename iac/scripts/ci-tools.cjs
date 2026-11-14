const forgejoVersion = "1.7.0";
// Pins come from the official v1.7.0 SHA256SUMS release asset.
const forgejoAssets = {
  linux_amd64: "1234b9b826c205be582fca1c93c51b6220dbcba67cff46cecad1aa9ce90fa056",
  linux_arm64: "5d0b391e69113efe4cc5fd18c3faa1c4771f81c48dc18514f49b3972770d7a49",
  darwin_amd64: "9398f8a9900390f218ef11342330f4883e18a42b619af1cdcfc82df501867897",
  darwin_arm64: "812c66aa4b67ff8d3460e4c53097642f2a4657c3de07f1b3d69611ddd6036469",
};

module.exports = { pulumiVersion: "3.228.0", forgejoVersion, forgejoAssets };
