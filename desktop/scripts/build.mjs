import { cpSync, mkdirSync } from "node:fs";
import { build } from "esbuild";
import { build as buildRenderer } from "vite";

export async function buildMain() {
  mkdirSync("desktop/dist", { recursive: true });
  await build({
    entryPoints: { main: "desktop/main/index.ts", "document-worker": "src/document-worker.ts" },
    bundle: true, platform: "node", target: "node24", format: "esm", outdir: "desktop/dist",
    external: ["electron", "unpdf"], sourcemap: true,
    banner: { js: 'import { createRequire as __xwCreateRequire } from "node:module"; const require = __xwCreateRequire(import.meta.url);' },
  });
  cpSync("desktop/main/preload.cjs", "desktop/dist/preload.cjs");
  cpSync("desktop/icon.png", "desktop/dist/icon.png");
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("desktop/scripts/build.mjs")) {
  await buildMain();
  await buildRenderer({ configFile: "desktop/vite.config.ts" });
}
