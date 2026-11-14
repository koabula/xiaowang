import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_ICON_INK, APP_ICON_NAME, beamHash, beamPalette, beamSvg } from "../src/beam.ts";

const libraryHash = Function(
  `"use strict"; return (${readFileSync(new URL("../node_modules/boring-avatars/dist/index.js", import.meta.url), "utf8").match(/const m = \(l\) => \{[\s\S]*?return Math\.abs\(r\);\n\}/)?.[0].replace(/^const m = /, "")});`,
)() as (name: string) => number;

function libraryPick(name: string, colors: string[]): { slab: string; paper: string } {
  const hash = beamHash(name);
  return { slab: colors[hash % colors.length] ?? "", paper: colors[(hash + 13) % colors.length] ?? "" };
}

test("a new face keeps the slab color, and a new color keeps the same slots for that face", () => {
  const faces = ["xiaowang", "xiaowang-a1b2", "speculative", "bot-ab12-k7q", "阿王"];
  for (const face of faces) assert.equal(beamHash(face), libraryHash(face));
  const inks = ["#18181B", "#177E6B", "#C44D34", "#F4F4F5"];
  for (const face of faces) {
    const first = libraryPick(face, beamPalette(face, "#177E6B"));
    for (const other of faces) {
      const picked = libraryPick(other, beamPalette(other, "#177E6B"));
      assert.equal(picked.slab, "#177E6B");
      assert.equal(picked.paper, "#F4F4F5");
    }
    assert.equal(first.slab, "#177E6B");
    for (const ink of inks) {
      const picked = libraryPick(face, beamPalette(face, ink));
      assert.equal(picked.slab, ink);
      assert.equal(picked.paper, "#F4F4F5");
      assert.notEqual(beamHash(face) % 5, (beamHash(face) + 13) % 5);
    }
  }
});

test("the app icon is a rounded dock tile with the tilted steward beam", () => {
  const svg = beamSvg(APP_ICON_NAME, beamPalette(APP_ICON_NAME, APP_ICON_INK));
  assert.equal(svg, beamSvg(APP_ICON_NAME, beamPalette(APP_ICON_NAME, APP_ICON_INK)));
  assert.match(svg, new RegExp(APP_ICON_INK));
  assert.match(svg, /#FFFFFF/);
  assert.match(svg, /rx="185"/);
  assert.doesNotMatch(svg, /<rect width="1024" height="1024"/);
});
