import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_ICON_INK, APP_ICON_NAME, beamFace, beamHash, beamPalette, beamSvg } from "../src/beam.ts";

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

test("the default steward matches the requested blue dock face geometry", () => {
  assert.equal(APP_ICON_NAME, "xw-6udis");
  const colors = beamPalette(APP_ICON_NAME, APP_ICON_INK);
  assert.deepEqual(colors, ["#F4F4F5", "#F4F4F5", "#F4F4F5", "#F4F4F5", "#2B59C3"]);
  assert.deepEqual(beamFace(APP_ICON_NAME, colors), {
    wrapperColor: "#2B59C3", faceColor: "#FFFFFF", backgroundColor: "#F4F4F5",
    wrapperTranslateX: 9, wrapperTranslateY: 9, wrapperRotate: 199, wrapperScale: 1.1,
    isMouthOpen: false, isCircle: false, eyeSpread: 4, mouthSpread: 1,
    faceRotate: -9, faceTranslateX: 4.5, faceTranslateY: 4.5,
  });
});
