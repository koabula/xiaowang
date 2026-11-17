// Actual installers and native update/relaunch: disposable GitHub runners only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Runtime } from '../src/runtime.ts';
import { launchPackaged, closeTestApp } from '../e2e/launch.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run installers only on disposable CI runners, never on the working desktop');
const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
const previous = '0.1.19', candidateDir = path.resolve(process.env.XIAOWANG_CANDIDATE_DIR), oldDir = path.resolve(process.env.XIAOWANG_PREVIOUS_DIR);
const reportDir = path.resolve(process.env.XIAOWANG_QA_REPORT_DIR || 'qa-report'); await mkdir(reportDir, { recursive: true });
const report = { version, previous, platform: process.platform, arch: process.arch, status: 'running', checks: [], stage: 'setup' };
const root = await mkdtemp(path.join(os.tmpdir(), 'xw-candidate-'));
const home = path.join(os.homedir(), '.xiaowang');
const appData = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const exists = file => access(file).then(() => true, () => false);
const digest = async (file, algorithm = 'sha256') => { const hash = createHash(algorithm); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex'); };
const checked = label => { report.checks.push(label); console.log(label); };
async function until(check, label, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(100); } throw new Error(label); }
async function verified(directory, name) {
  const manifest = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  const entry = manifest.split(/\r?\n/).find(line => line.slice(66) === name);
  assert.ok(entry, 'Missing checksum: ' + name);
  const file = path.join(directory, name); assert.equal(await digest(file), entry.slice(0, 64), name);
  return file;
}
async function extractMac(file, destination) {
  const unpacked = await mkdtemp(path.join(root, 'unpack-')); let mounted = false;
  try {
    if (file.endsWith('.dmg')) { await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', unpacked, file]); mounted = true; }
    else await run('/usr/bin/ditto', ['-x', '-k', file, unpacked]);
    const bundles = (await readdir(unpacked)).filter(name => name.endsWith('.app')); assert.equal(bundles.length, 1);
    await run('/usr/bin/ditto', [path.join(unpacked, bundles[0]), destination]);
  } finally { if (mounted) await run('/usr/bin/hdiutil', ['detach', unpacked]); await rm(unpacked, { recursive: true, force: true }); }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
  return path.join(destination, 'Contents/MacOS/xiaowang');
}
async function install(file, destination) {
  if (process.platform === 'darwin') return extractMac(file, destination + '.app');
  if (process.platform === 'win32') { await run(file, ['/S', '/D=' + destination]); return path.join(destination, 'xiaowang.exe'); }
  if (file.endsWith('.AppImage')) { await cp(file, destination); await chmod(destination, 0o755); return destination; }
  await run('sudo', ['apt-get', 'install', '-y', '--allow-downgrades', file]);
  const pkg = (await run('dpkg-deb', ['--field', file, 'Package'])).stdout.trim();
  const files = (await run('dpkg', ['-L', pkg])).stdout.split('\n');
  const binary = files.find(name => name.startsWith('/opt/') && name.endsWith('/xiaowang'));
  assert.ok(binary, 'Installed DEB executable missing'); return binary;
}
async function profileForApp() {
  const matches = [];
  for (const entry of await readdir(appData, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(appData, entry.name);
    if (await exists(path.join(directory, 'secrets.bin')) && await exists(path.join(directory, 'DevToolsActivePort'))) matches.push(directory);
  }
  assert.equal(matches.length, 1, 'The disposable runner must have exactly one seeded app profile'); return matches[0];
}
async function killRestarted(profile, binary, oldPid) {
  const canonicalBinary = process.platform === 'win32' ? await realpath(binary) : binary;
  const pid = await until(async () => {
    if (process.platform === 'win32') {
      const script = '$p=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:XW_QA_BINARY -and $_.CommandLine -notmatch "--type=" }; @($p.ProcessId) | ConvertTo-Json -Compress';
      const value = (await run('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, XW_QA_BINARY: canonicalBinary } })).stdout.trim();
      return (value ? [].concat(JSON.parse(value)) : []).find(value => value && value !== oldPid);
    }
    try { const lock = await readlink(path.join(profile, 'SingletonLock')); const value = Number(lock.slice(lock.lastIndexOf('-') + 1)); if (value !== oldPid && value > 0) { process.kill(value, 0); return value; } } catch {}
    return false;
  }, 'The updater did not automatically relaunch the installed app');
  checked('Updater automatically relaunched process ' + pid);
  if (process.platform === 'win32') await run('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Id ' + pid + ' -Force']);
  else process.kill(pid, 'SIGTERM');
  await sleep(1000);
}
function pdf() {
  const stream = 'BT /F1 16 Tf 40 700 Td (UPGRADE-PDF-EVIDENCE) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(body); body += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) body += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(body + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

let app, page, restarted, profile, model, feed, activeBinary; let requests = 0, offer = false, download;
try {
  assert.equal(await exists(home), false, 'Refuse to overwrite an existing profile, even on a CI runner');
  model = createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end('{"data":[{"id":"fixture"}]}'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw); requests++;
    const answer = 'UPGRADE-ANSWER-PRESERVED';
    response.setHeader('content-type', input.stream ? 'text/event-stream' : 'application/json');
    response.end(input.stream ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' : JSON.stringify({ choices: [{ message: { content: answer } }] }));
  }); await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelUrl = 'http://127.0.0.1:' + model.address().port + '/v1';
  feed = createServer((request, response) => {
    if (request.url.includes('latest')) {
      response.setHeader('content-type', 'text/yaml');
      response.end(JSON.stringify({ version: offer ? version : previous, files: [download], path: download.url, sha512: download.sha512 })); return;
    }
    if (request.url.split('?')[0] === '/' + download.url) { response.setHeader('content-length', download.size); createReadStream(download.file).pipe(response); return; }
    response.writeHead(404); response.end();
  }); await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve));
  const baseEnv = { ...process.env };
  for (const name of Object.keys(baseEnv)) if (name.startsWith('XIAOWANG_') || /^(ELECTRON_RUN_AS_NODE|GEMINI_API_KEY|GOOGLE_API_KEY|MOSS_API_KEY|APPIMAGE)$/.test(name)) delete baseEnv[name];
  const variants = process.platform === 'linux' ? ['AppImage', 'deb'] : [process.platform === 'darwin' ? 'mac' : 'win'];
  for (const variant of variants) {
    report.stage = variant + ': verify artifacts';
    const prefix = process.platform === 'darwin' ? 'mac-' + process.arch : process.platform === 'win32' ? 'win-x64' : variant === 'deb' ? 'linux-amd64' : 'linux-x86_64';
    const extension = variant === 'mac' ? 'zip' : variant === 'win' ? 'exe' : variant;
    const name = 'XiaoWang-' + version + '-' + prefix + '.' + extension;
    const candidate = await verified(candidateDir, name), old = await verified(oldDir, name.replace(version, previous));
    checked(variant + ': original release and candidate SHA-256 checks passed');
    const nativeEnv = { ...baseEnv, ...(variant === 'AppImage' ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}) };
    const fresh = variant === 'mac' ? await verified(candidateDir, name.replace('.zip', '.dmg')) : candidate;
    activeBinary = await install(fresh, path.join(root, variant + '-fresh'));
    app = await launchPackaged(activeBinary, ['--no-sandbox'], { ...nativeEnv, XIAOWANG_HOME: path.join(root, variant + '-fresh-home'), XIAOWANG_USER_DATA: path.join(root, variant + '-fresh-profile') }, { native: true });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForFunction(() => Boolean(window.xiaowang));
    let state = await page.evaluate(() => window.xiaowang.getState());
    assert.equal(state.version, version); assert.equal(state.settings.ready, false); await page.getByRole('form', { name: '设置', exact: true }).waitFor();
    await closeTestApp(app); app = undefined; checked(variant + ': fresh installation launches with a clean profile');

    report.stage = variant + ': seed original installation';
    activeBinary = await install(old, path.join(root, variant + '-installed'));
    download = { file: candidate, url: name, sha512: await digest(candidate, 'sha512'), size: (await stat(candidate)).size }; offer = false;
    const env = { ...nativeEnv, XIAOWANG_UPDATE_TEST_FEED: 'http://127.0.0.1:' + feed.address().port + '/' };
    app = await launchPackaged(activeBinary, ['--no-sandbox'], env, { native: true });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForFunction(() => Boolean(window.xiaowang));
    assert.equal((await page.evaluate(() => window.xiaowang.getState())).version, previous);
    await page.evaluate(baseUrl => window.xiaowang.saveSettings({ baseUrl, model: 'fixture', apiKey: 'fixture-text-0120', realtimeService: 'openai', realtimeKey: 'fixture-voice-0120', locale: 'zh' }), modelUrl);
    const slug = await page.evaluate(() => window.xiaowang.createBot('Upgrade preservation', 'Synthetic acceptance data only'));
    // The returned slug is authoritative; do not infer it from the display name.
    const source = await page.evaluate(({ slug, bytes }) => window.xiaowang.attach(slug, 'original.pdf', Uint8Array.from(bytes)), { slug, bytes: [...pdf()] });
    await page.evaluate(slug => { void window.xiaowang.ask(slug, 'UPGRADE-QUESTION-PRESERVED'); }, slug);
    await until(async () => (await page.evaluate(() => window.xiaowang.getState())).jobs.some(job => job.status === 'succeeded' && job.result === 'UPGRADE-ANSWER-PRESERVED'), 'Original app did not finish its seeded task');
    const runtime = Runtime.open(home), bot = runtime.store.requireBot(slug); runtime.close();
    await mkdir(path.join(bot.workspaceDir, 'notes'), { recursive: true });
    const note = path.join(bot.workspaceDir, 'notes/keep.md');
    await writeFile(note, '# Preserved note\n[Open original](xwref://' + source.refId + '?page=1)\nUPGRADE-FILE-PRESERVED\n');
    const noteHash = await digest(note);
    const originalEvents = await page.evaluate(slug => window.xiaowang.events(slug), slug);
    const originalLibrary = await page.evaluate(slug => window.xiaowang.library(slug), slug);
    state = await page.evaluate(() => window.xiaowang.getState());
    const originalJob = state.jobs.find(job => job.result === 'UPGRADE-ANSWER-PRESERVED');
    assert.equal(requests, 1); profile = await profileForApp();
    const oldPort = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], oldPid = app.process().pid;
    report.stage = variant + ': actual automatic update';
    offer = true; await page.evaluate(() => window.xiaowang.checkUpdate()); await page.locator('.update-button').waitFor(); await page.locator('.update-button').click();
    await until(async () => {
      if (app.process().exitCode !== null || app.process().signalCode !== null) return true;
      const value = await page.evaluate(() => window.xiaowang.getState()).catch(() => null);
      if (value?.update.phase === 'error') throw new Error(value.update.error);
      return false;
    }, 'The original app did not exit for installation', 120000);
    if (variant === 'mac' || variant === 'deb') {
      const port = await until(async () => { try { const value = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return value !== oldPort && value; } catch { return false; } }, 'Updated app did not restart with its profile', 90000);
      restarted = await chromium.connectOverCDP('http://127.0.0.1:' + port);
      page = await until(() => restarted.contexts().flatMap(context => context.pages()).find(item => item.url().includes('/renderer/index.html')), 'Updated renderer missing');
    } else {
      await killRestarted(profile, activeBinary, oldPid);
      await closeTestApp(app); app = undefined;
      app = await launchPackaged(activeBinary, ['--no-sandbox'], { ...nativeEnv, XIAOWANG_DISABLE_UPDATES: '1' }, { native: true }); page = await app.firstWindow();
    }
    await page.waitForFunction(() => Boolean(window.xiaowang)); state = await page.evaluate(() => window.xiaowang.getState());
    if (state.settings.pendingMigration) {
      await page.evaluate(() => window.xiaowang.restoreSettings());
      state = await page.evaluate(() => window.xiaowang.getState());
    }
    assert.equal(state.version, version); assert.equal(state.settings.ready, true); assert.equal(state.settings.model, 'fixture');
    assert.match(state.settings.keyHint, /0120/); assert.match(state.settings.realtimeKeyHint, /0120/);
    assert.equal(state.activeSlug, slug); assert.equal(state.jobs.find(job => job.id === originalJob.id).status, 'succeeded');
    assert.equal(state.jobs.find(job => job.id === originalJob.id).attempts, originalJob.attempts);
    assert.deepEqual(await page.evaluate(slug => window.xiaowang.events(slug), slug), originalEvents);
    assert.deepEqual((await page.evaluate(slug => window.xiaowang.library(slug), slug)).map(item => item.id), originalLibrary.map(item => item.id));
    assert.equal(await digest(note), noteHash); assert.equal(requests, 1, 'Completed work must not execute again after upgrading');
    await page.evaluate(slug => window.xiaowang.openArtifact(slug, 'notes/keep.md'), slug);
    await page.locator('.prose').getByRole('link', { name: 'Open original', exact: true }).click();
    await page.locator('.textLayer').filter({ hasText: 'UPGRADE-PDF-EVIDENCE' }).waitFor();
    await page.screenshot({ path: path.join(reportDir, variant + '-' + process.arch + '-preserved.png') });
    checked(variant + ': actual ' + previous + ' -> ' + version + ' update, relaunch, keys, bot, history, completed job, files and PDF reference preserved');
    if (restarted) {
      const session = await restarted.newBrowserCDPSession(), info = await session.send('SystemInfo.getProcessInfo');
      const pid = info.processInfo.find(item => item.type === 'browser')?.id; if (pid) process.kill(Number(pid), 'SIGTERM');
      await restarted.close().catch(() => {}); restarted = undefined;
    }
    if (app) { await closeTestApp(app); app = undefined; }
    await sleep(500); await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); profile = undefined;
    await rm(home, { recursive: true, force: true }); requests = 0;
  }
  report.status = 'passed'; report.stage = 'complete';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error);
  if (page && activeBinary) {
    const resources = process.platform === 'darwin' ? path.resolve(path.dirname(activeBinary), '../Resources') : path.join(path.dirname(activeBinary), 'resources');
    report.diagnostic = { renderer: page.url(), executable: activeBinary, canonicalExecutable: await realpath(activeBinary).catch(() => ''),
      expectedPage: pathToFileURL(path.join(resources, 'app.asar/desktop/dist/renderer/index.html')).href,
      canonicalPage: pathToFileURL(path.join(await realpath(resources).catch(() => resources), 'app.asar/desktop/dist/renderer/index.html')).href };
    console.error(JSON.stringify(report.diagnostic));
  }
  console.error(report.error); process.exitCode = 1;
  await writeFile(path.join(reportDir, process.platform + '-' + process.arch + '.json'), JSON.stringify(report, null, 2) + '\n');
}
finally {
  if (restarted) await restarted.close().catch(() => {});
  if (app) await closeTestApp(app);
  if (model) await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); });
  if (feed) await new Promise(resolve => { feed.close(resolve); feed.closeAllConnections(); });
  await writeFile(path.join(reportDir, process.platform + '-' + process.arch + '.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log('Acceptance cleanup complete:', report.status);
}
