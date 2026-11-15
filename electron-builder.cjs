/** v26 configuration. Credentials are optional; ordinary CI creates unsigned installers. */
const repository = "koabula/xiaowang";
const homepage = repository ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}` : undefined;
module.exports = {
  appId: "com.xiaowang.assistant",
  productName: "小王同学",
  executableName: "xiaowang",
  directories: { output: "release", buildResources: "desktop/build" },
  files: ["desktop/dist/**/*", "package.json", "!**/*.map"],
  asar: true,
  npmRebuild: false,
  artifactName: "XiaoWang-${version}-${os}-${arch}.${ext}",
  mac: {
    target: ["dmg", "zip"], category: "public.app-category.productivity",
    icon: "desktop/icon.png", hardenedRuntime: true,
    identity: process.env.CSC_LINK ? undefined : null,
    entitlements: "desktop/build/entitlements.mac.plist",
    entitlementsInherit: "desktop/build/entitlements.mac.plist",
    notarize: Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID),
    extendInfo: { NSMicrophoneUsageDescription: "小王同学需要使用麦克风与你实时语音交流。XiaoWang uses your microphone for voice conversations." },
  },
  win: { target: ["nsis"], icon: "desktop/icon.png" },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true },
  linux: { target: ["AppImage", "deb"], category: "Education", icon: "desktop/icon.png", maintainer: "XiaoWang contributors" },
  publish: { provider: "github", owner: "koabula", repo: "xiaowang", releaseType: "release" },
  ...(homepage ? { extraMetadata: { homepage, repository: { type: "git", url: `${homepage}.git` } } } : {}),
};
