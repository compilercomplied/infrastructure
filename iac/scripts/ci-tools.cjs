const forgejoVersion = "1.7.0";
// Pins come from the official v1.7.0 SHA256SUMS release asset.
const forgejoAssets = {
  linux_amd64: "1234b9b826c205be582fca1c93c51b6220dbcba67cff46cecad1aa9ce90fa056",
  linux_arm64: "5d0b391e69113efe4cc5fd18c3faa1c4771f81c48dc18514f49b3972770d7a49",
  darwin_amd64: "9398f8a9900390f218ef11342330f4883e18a42b619af1cdcfc82df501867897",
  darwin_arm64: "812c66aa4b67ff8d3460e4c53097642f2a4657c3de07f1b3d69611ddd6036469",
};

const androidArchives = [
  {
    path: "android/ndk/27.0.12077973/android-ndk-r27-linux.zip",
    url: "https://dl.google.com/android/repository/android-ndk-r27-linux.zip",
    sha256: "2f17eb8bcbfdc40201c0b36e9a70826fcd2524ab7a2a235e2c71186c302da1dc"
  },
  {
    path: "android/ndk/27.0.12077973/android-ndk-r27-darwin.zip",
    url: "https://dl.google.com/android/repository/android-ndk-r27-darwin.zip",
    sha256: "2f2ef00b22fe22c1c9c78fda1b38ea7ffa6528e25eac0b70a92f8cb0093143be"
  },
  {
    path: "gradle/8.11.1/gradle-8.11.1-bin.zip",
    url: "https://downloads.gradle.org/distributions/gradle-8.11.1-bin.zip",
    sha256: "f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6"
  },
  {
    path: "gradle/8.13/gradle-8.13-bin.zip",
    url: "https://downloads.gradle.org/distributions/gradle-8.13-bin.zip",
    sha256: "20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78"
  },
  {
    path: "maestro/2.5.0/maestro.zip",
    url: "https://github.com/mobile-dev-inc/Maestro/releases/download/cli-2.5.0/maestro.zip",
    sha256: "9c9a7617b47e21d4a9add205e0a2ec45f71f9fb0cb651051281afbc3f87158ea"
  }
];

module.exports = { pulumiVersion: "3.228.0", forgejoVersion, forgejoAssets, androidArchives };
