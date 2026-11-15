import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import asar from '@electron/asar';
import { chromium } from 'playwright';
import { Runtime } from '../src/runtime.ts';
import { launchPackaged, closeTestApp } from './launch.mjs';
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await sleep(80); } throw new Error('Installed update did not restart successfully'); }

// This test replaces only a disposable copy of the packaged app. User profiles
// and the real installed application are never selected as update targets.
test('packaged mac: click updates, replaces and restarts the app while preserving its isolated data', { skip: process.platform !== 'darwin' || !process.env.XIAOWANG_E2E_EXECUTABLE, timeout: 120000 }, async t => {
  const currentVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const nextVersion = currentVersion.replace(/\d+$/, value => String(Number(value) + 1));
  const root = await mkdtemp(path.join(os.tmpdir(), "xw-real-update's-"));
  const profile = path.join(root, 'profile'); const home = path.join(root, 'home'); await mkdir(profile);
  const source = path.resolve(path.dirname(process.env.XIAOWANG_E2E_EXECUTABLE), '../..');
  const installed = path.join(root, 'Installed 小王.app'); const candidate = path.join(root, 'Candidate 小王.app');
  await run('/usr/bin/ditto', [source, installed]); await run('/usr/bin/ditto', [source, candidate]);
  const archive = path.join(candidate, 'Contents/Resources/app.asar'); const unpacked = path.join(root, 'unpacked');
  asar.extractAll(archive, unpacked);
  const pkgPath = path.join(unpacked, 'package.json'); const pkg = JSON.parse(await readFile(pkgPath, 'utf8')); pkg.version = nextVersion; await writeFile(pkgPath, JSON.stringify(pkg));
  await rm(archive); await asar.createPackage(unpacked, archive);
  const plist = path.join(candidate, 'Contents/Info.plist');
  for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${nextVersion}`, plist]);
  const headerHash = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  await run('/usr/libexec/PlistBuddy', ['-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`, plist]);
  const filename = `XiaoWang-${nextVersion}-mac-${process.arch}.zip`; const zip = path.join(root, filename);
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', candidate, zip]);
  const hash = createHash('sha512'); for await (const chunk of createReadStream(zip)) hash.update(chunk);
  const sha512 = hash.digest('base64'); const size = (await stat(zip)).size;
  const seed = Runtime.open(home); seed.store.append(seed.activeBot().id, { type: 'user_text', channel: 'text', text: 'UPDATE-PRESERVE-DATA' }); seed.close();
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1/v1', locale: 'zh' }));
  const server = createServer((request, response) => {
    if (request.url.includes('latest')) { response.writeHead(200, { 'content-type': 'text/yaml' }); response.end(JSON.stringify({ version: nextVersion, files: [{ url: filename, sha512, size }], path: filename, sha512 })); }
    else if (request.url.split('?')[0].endsWith(filename)) { response.writeHead(200, { 'content-length': size }); createReadStream(zip).pipe(response); }
    else { response.writeHead(404); response.end(); }
  }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_UPDATE_TEST_FEED: `http://127.0.0.1:${server.address().port}/` }; delete env.ELECTRON_RUN_AS_NODE;
  const executable = path.join(installed, 'Contents/MacOS/xiaowang');
  const app = await launchPackaged(executable, ['--no-sandbox'], env); let restarted;
  const cache = path.join(os.homedir(), 'Library/Caches', `xiaowang-test-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}`);
  t.after(async () => {
    if (restarted) {
      try { const session = await restarted.newBrowserCDPSession(); const info = await session.send('SystemInfo.getProcessInfo'); const pid = info.processInfo.find(item => item.type === 'browser')?.id; if (pid) process.kill(Number(pid), 'SIGTERM'); } catch {}
      await restarted.close().catch(() => {});
    }
    await closeTestApp(app); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const page = await app.firstWindow(); await page.getByText('UPDATE-PRESERVE-DATA', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).version, currentVersion);
  const oldPort = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  await page.locator('.update-button').waitFor(); await page.locator('.update-button').click();
  const port = await until(async () => { const value = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return value !== oldPort && value; }, 60000);
  restarted = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const nextPage = await until(() => restarted.contexts().flatMap(context => context.pages()).find(item => item.url().includes('/renderer/index.html')));
  await nextPage.getByText('UPDATE-PRESERVE-DATA', { exact: true }).waitFor();
  const state = await nextPage.evaluate(() => window.xiaowang.getState());
  assert.equal(state.version, nextVersion); assert.equal(state.settings.model, 'fixture'); assert.equal(state.settings.ready, true);
  assert.equal(JSON.parse(asar.extractFile(path.join(installed, 'Contents/Resources/app.asar'), 'package.json').toString()).version, nextVersion);
  await nextPage.locator('.rail .settings').click(); assert.equal((await nextPage.locator('.app-version').textContent()).trim(), `版本 ${nextVersion}`);
  await nextPage.screenshot({ path: '/private/tmp/xiaowang-updated-version.png' });
  console.log(`Verified actual ${currentVersion} → ${nextVersion} download, SHA-512 verification, app replacement, relaunch, version display, saved settings and conversation preservation in an isolated install.`);
});
