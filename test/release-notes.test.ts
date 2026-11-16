import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseBody } from "../desktop/scripts/release-notes.ts";
const release = { tag_name: "v0.1.19", body: "## Changes\n\nKeep this update description.", assets: [
  "XiaoWang-0.1.19-mac-arm64.dmg", "XiaoWang-0.1.19-mac-arm64.zip", "XiaoWang-0.1.19-mac-x64.dmg",
  "XiaoWang-0.1.19-win-x64.exe", "XiaoWang-0.1.19-linux-x86_64.AppImage", "XiaoWang-0.1.19-linux-amd64.deb",
  "latest.yml", "SHA256SUMS.txt",
].map(name => ({ name })) };

test("release table links only existing installers and prefers DMG over update ZIP", () => {
  const body = releaseBody(release, "koabula/xiaowang");
  const urls = [...body.matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)].map(match => match[1]!);
  assert.equal(urls.length, 5);
  for (const url of urls) {
    assert.ok(url.startsWith("https://github.com/koabula/xiaowang/releases/download/v0.1.19/"));
    assert.ok(release.assets.some(asset => url.endsWith(asset.name)));
  }
  assert.doesNotMatch(body, /\.zip\)|latest\.yml|SHA256SUMS|首次打开/);
  assert.ok(body.indexOf("## 下载") < body.indexOf("## Changes"));
});

test("regeneration updates version and attachments without duplicating tables or losing notes", () => {
  const first = releaseBody(release, "koabula/xiaowang");
  assert.equal(releaseBody({ ...release, body: first }, "koabula/xiaowang"), first);
  const next = releaseBody({ tag_name: "v0.1.20", body: first, assets: [{ name: "XiaoWang-0.1.20-mac-arm64.zip" }] }, "koabula/xiaowang");
  assert.match(next, /\.zip\)/); assert.doesNotMatch(next, /v0\.1\.19|Windows|Intel|Linux/);
  assert.equal(next.match(/## 下载/g)?.length, 1);
  assert.match(next, /Keep this update description\./);
});

test("missing installers fail before updating a Release", () => {
  assert.throws(() => releaseBody({ ...release, assets: [{ name: "latest.yml" }] }, "koabula/xiaowang"), /no supported installers/);
});
