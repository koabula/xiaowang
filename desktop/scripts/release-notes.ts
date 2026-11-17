import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Release { tag_name: string; body: string | null; assets: Array<{ name: string }> }
const start = "<!-- xiaowang-downloads:start -->";
const end = "<!-- xiaowang-downloads:end -->";

export function releaseBody(release: Release, repository: string): string {
  const version = release.tag_name.replace(/^v/, "");
  const names = new Set(release.assets.map(asset => asset.name));
  function badge(os: string, arch: string, formats: string[], label: string, logo = ""): string {
    const filename = formats.map(format => `XiaoWang-${version}-${os}-${arch}.${format}`).find(name => names.has(name));
    if (!filename) return "";
    const format = filename.slice(filename.lastIndexOf(".") + 1);
    const titles: Record<string, string> = { exe: "Setup", deb: "DEB", dmg: "DMG", zip: "ZIP" };
    const title = titles[format] ?? format;
    const image = `https://img.shields.io/badge/${encodeURIComponent(title)}-${encodeURIComponent(label)}-2B59C3?style=for-the-badge${logo ? `&logo=${logo}&logoColor=white` : ""}`;
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(filename)}`;
    return `[![${title} ${label}](${image})](${url})`;
  }
  const rows = [
    ["macOS · Apple Silicon", badge("mac", "arm64", ["dmg", "zip"], "Apple Silicon", "apple")],
    ["macOS · Intel", badge("mac", "x64", ["dmg", "zip"], "Intel x64", "apple")],
    ["Windows", badge("win", "x64", ["exe"], "x64")],
    ["Linux", [badge("linux", "x86_64", ["AppImage"], "x64", "linux"), badge("linux", "amd64", ["deb"], "x64", "debian")].filter(Boolean).join(" ")],
  ].filter(([, links]) => links);
  if (!rows.length) throw new Error("Release has no supported installers to link.");
  const table = [start, "## Download", "", "| OS | Download |", "| --- | --- |", ...rows.map(([os, links]) => `| ${os} | ${links} |`), "", end].join("\n");
  const previous = release.body ?? "";
  const opening = previous.indexOf(start), closing = previous.indexOf(end, opening);
  const body = opening >= 0 && closing >= opening
    ? previous.slice(0, opening) + previous.slice(closing + end.length)
    : previous;
  return `${table}\n\n${body.trim()}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tag = process.argv[2], repository = process.argv[3] || process.env.GITHUB_REPOSITORY;
  if (!tag || !repository) throw new Error("Usage: node desktop/scripts/release-notes.ts <tag> <owner/repo>");
  // The REST lookup by tag can return 404 while the uploaded release is still a draft.
  const release = JSON.parse(execFileSync("gh", [
    "release", "view", tag, "--repo", repository, "--json", "tagName,body,assets",
    "--jq", "{tag_name: .tagName, body: .body, assets: [.assets[] | {name: .name}]}",
  ], { encoding: "utf8" })) as Release;
  const directory = mkdtempSync(path.join(tmpdir(), "xiaowang-release-notes-"));
  try {
    const file = path.join(directory, "notes.md");
    writeFileSync(file, releaseBody(release, repository));
    execFileSync("gh", ["release", "edit", tag, "--repo", repository, "--notes-file", file], { stdio: "inherit" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
