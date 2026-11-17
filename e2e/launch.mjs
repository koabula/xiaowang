import { chromium, _electron } from "playwright";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout=15000) {const end=Date.now()+timeout;while(Date.now()<end){const result=await predicate();if(result)return result;await sleep(50);}throw new Error("Packaged renderer did not appear");}

/** Background is the default even for direct execution of an individual test file. */
export const electron = {
  launch(options = {}) {
    const env = { ...(options.env ?? process.env), XIAOWANG_E2E_MODE: "background" }; delete env.ELECTRON_RUN_AS_NODE;
    return _electron.launch({ ...options, env });
  },
};

export function launchNative(options = {}) {
  const env = { ...(options.env ?? process.env), XIAOWANG_E2E_MODE: "native" }; delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ ...options, env });
}

export async function launchPackaged(executablePath, args, env, { native = false } = {}) {
  // Packaged executables do not install Playwright's development-only Electron hook.
  // Attach to their real renderer over CDP and exercise the same public IPC surface.
  env = { ...env, XIAOWANG_E2E_MODE: native ? "native" : "background", XIAOWANG_DISABLE_UPDATES: env.XIAOWANG_UPDATE_TEST_FEED ? "0" : "1" };
  const child = spawn(executablePath, ["--remote-debugging-port=0", "--use-mock-keychain", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Packaged app did not expose its renderer: ${log}`)); }, 15000);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Packaged app exited (${code}): ${log}`)); });
    child.stderr.on("data", chunk => {
      log += chunk.toString();
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  return {
    process: () => child,
    firstWindow: () => until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes("/renderer/index.html")), 15000),
    async close() {
      const exited = new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
      try {
        await browser.close().catch(() => {}); child.kill("SIGTERM");
        await Promise.race([exited, sleep(3000).then(() => child.kill("SIGKILL"))]);
      } finally {
        // Updater descendants can inherit the original process's pipes after it exits.
        child.stdout.destroy(); child.stderr.destroy();
      }
    },
  };
}


/** Fixtures must exit even if a failed assertion left an unsaved-settings dialog. */
export async function closeTestApp(app) {
  let timer;
  const audit = typeof app.evaluate === "function" ? await app.evaluate(() => globalThis.__xwBackgroundAudit).catch(() => undefined) : undefined;
  try {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(() => { app.process().kill('SIGKILL'); resolve(); }, 3000); }),
    ]);
  } finally { clearTimeout(timer); }
  if (audit) assert.deepEqual(audit, { shown: [], focused: [], clipboard: [] }, "Background tests must not show/focus windows or access the system clipboard");
}
