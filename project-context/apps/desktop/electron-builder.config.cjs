const { existsSync } = require("fs");
const { join } = require("path");

const docxBundlePath = join(
  __dirname,
  "..",
  "..",
  "services",
  "docx-renderer",
  "publish"
);

const extraResources = [];
if (existsSync(docxBundlePath)) {
  extraResources.push({
    from: docxBundlePath,
    to: "docx-renderer",
    filter: ["**/*"]
  });
}

module.exports = {
  appId: "com.bilomax.curator",
  productName: "Curator",
  directories: {
    output: "release"
  },
  files: ["dist/**", "package.json"],
  extraResources,
  mac: {
    target: ["dmg", "zip"]
  },
  win: {
    target: ["nsis", "zip"]
  },
  publish: [
    {
      provider: "github"
    }
  ]
};
