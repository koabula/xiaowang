import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electron = require("electron");

mkdirSync("desktop/dist", { recursive: true });
await build({
  entryPoints: ["desktop/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "desktop/dist/main.js",
  external: ["electron", "unpdf"],
  sourcemap: true,
});
cpSync("desktop/main/preload.cjs", "desktop/dist/preload.cjs");

const server = await createServer({ configFile: "desktop/vite.config.ts" });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error("界面开发服务器没有地址。");

const child = spawn(electron, ["desktop/dist/main.js"], {
  stdio: "inherit",
  env: { ...process.env, XIAOWANG_DESKTOP_URL: url },
});
child.on("exit", (code) => {
  void server.close().then(() => process.exit(code ?? 0));
});
