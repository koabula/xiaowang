import { chromium } from "playwright";
import { spawn } from "node:child_process";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout=15000) {const end=Date.now()+timeout;while(Date.now()<end){const result=await predicate();if(result)return result;await sleep(50);}throw new Error("Packaged renderer did not appear");}

export async function launchPackaged(executablePath, args, env) {
  // Packaged executables do not install Playwright's development-only Electron hook.
  // Attach to their real renderer over CDP and exercise the same public IPC surface.
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
      await browser.close().catch(() => {}); child.kill("SIGTERM");
      await Promise.race([exited, sleep(3000).then(() => child.kill("SIGKILL"))]);
    },
  };
}
