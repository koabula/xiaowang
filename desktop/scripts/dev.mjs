import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import { buildMain } from "./build.mjs";

await buildMain();
const require = createRequire(import.meta.url);
const server = await createServer({ configFile: "desktop/vite.config.ts" });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error("界面开发服务器没有地址。");
const env = { ...process.env, XIAOWANG_DESKTOP_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), ["desktop/dist/main.js"], { stdio: "inherit", env });
child.on("exit", code => { void server.close().then(() => process.exit(code ?? 0)); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
