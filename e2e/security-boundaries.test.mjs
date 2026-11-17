import { electron, closeTestApp } from './launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = ['--no-sandbox', '--use-mock-keychain', '--use-fake-device-for-media-stream', 'desktop/dist/main.js'];
async function until(check) { const end = Date.now() + 10000; while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Native event did not arrive'); }
function cleanEnv(home, profile) {
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'XIAOWANG_MODEL', 'XIAOWANG_BASE_URL', 'XIAOWANG_API_STYLE', 'XIAOWANG_API_KEY', 'XIAOWANG_REALTIME_KEY', 'XIAOWANG_REALTIME_SERVICE', 'XIAOWANG_REALTIME_MODEL', 'XIAOWANG_DESKTOP_URL']) delete env[name];
  return env;
}
async function serve(handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('credentials stay with their service; environment overrides and session-only keys never enter disk settings', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-credentials-')), profile = path.join(root, 'profile'); await mkdir(profile);
  const captured = [];
  const handler = async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    captured.push({ url: req.url, key: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json'); res.end(req.url.endsWith('/models') ? '{"data":[{"id":"fixture"}]}' : '{"choices":[{"message":{"content":"好"}}]}');
  };
  const a = await serve(handler), b = await serve(handler);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'stored-model', baseUrl: a.url + '/v1', apiKey: 'stored-A', realtimeService: 'openai', realtimeKey: 'stored-voice', locale: 'zh' }));
  const env = cleanEnv(path.join(root, 'home'), profile);
  let app = await electron.launch({ args, env: { ...env, XIAOWANG_MODEL: 'temporary-model', XIAOWANG_API_KEY: 'temporary-text', XIAOWANG_REALTIME_KEY: 'temporary-voice' } });
  t.after(async () => { await closeTestApp(app); await stop(a.server); await stop(b.server); await rm(root, { recursive: true, force: true }); });
  let page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer');
  const original = (await page.evaluate(() => window.xiaowang.getState())).settings;
  assert.match(original.keyHint, /仅本次使用/); assert.match(original.realtimeKeyHint, /仅本次使用/);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const keyField = page.getByLabel('模型密钥', { exact: true }), address = page.getByLabel('接口地址', { exact: true });
  await keyField.fill('typed-A');
  await address.fill(a.url + '/another-path'); assert.equal(await keyField.inputValue(), 'typed-A');
  await address.fill(b.url + '/v1'); assert.equal(await keyField.inputValue(), ''); assert.equal(await keyField.getAttribute('placeholder'), '····');
  await page.getByRole('button', { name: '获取模型', exact: true }).click();
  await page.getByText('拿到 1 个模型', { exact: true }).waitFor();
  await address.fill(a.url + '/v1'); assert.equal(await keyField.inputValue(), 'typed-A');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.locator('.settings-modal').waitFor({ state: 'detached' });
  await page.evaluate(async baseUrl => {
    await window.xiaowang.listModels({ baseUrl, apiKey: '' });
    await window.xiaowang.checkSettings({ baseUrl, apiKey: '' });
  }, b.url + '/v1');
  for (const request of captured) assert.ok(!request.key?.includes('stored-A') && !request.key?.includes('temporary-text'));
  await page.evaluate(async () => {
    const { settings } = await window.xiaowang.getState();
    await window.xiaowang.saveSettings({ ...settings, apiKey: '', realtimeKey: '', locale: 'en', realtimeProfiles: Object.fromEntries(Object.entries(settings.realtimeProfiles).map(([id, value]) => [id, { ...value, key: '' }])) });
  });
  const storedFile = process.platform === 'darwin' ? 'settings.local.json' : 'secrets.bin';
  const disk = async () => app.evaluate(({ safeStorage }, data) => {
    const bytes = Buffer.from(data, 'base64'); try { return JSON.parse(bytes.toString()); } catch { return JSON.parse(safeStorage.decryptString(bytes)); }
  }, (await readFile(path.join(profile, storedFile))).toString('base64'));
  let saved = await disk(); assert.equal(saved.locale, 'en'); assert.equal(saved.model, 'stored-model');
  assert.ok(!JSON.stringify(saved).includes('temporary-'));
  await page.evaluate(baseUrl => window.xiaowang.saveSettings({ baseUrl, apiKey: 'stored-B' }), b.url + '/v1');
  saved = await disk(); assert.equal(saved.apiKey, 'stored-B'); assert.equal(saved.textKeys[new URL(a.url).origin], 'stored-A');
  assert.ok(!JSON.stringify(saved).includes('temporary-'));
  await closeTestApp(app); app = await electron.launch({ args, env }); page = await app.firstWindow(); await page.waitForSelector('.composer');
  captured.length = 0;
  await page.evaluate(baseUrl => window.xiaowang.listModels({ baseUrl, apiKey: '' }), a.url + '/other-path');
  await page.evaluate(() => window.xiaowang.listModels({ apiKey: '' }));
  assert.deepEqual(captured.map(item => item.key), ['Bearer stored-A', 'Bearer stored-B']);
  await app.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = () => false; });
  await page.evaluate(() => window.xiaowang.saveSettings({ apiKey: 'session-text', realtimeKey: 'session-voice' }));
  saved = await disk();
  const localMac = process.platform === 'darwin';
  assert.equal(saved.apiKey, localMac ? 'session-text' : '');
  if (!localMac) { assert.deepEqual(saved.textKeys, {}); assert.ok(!JSON.stringify(saved).includes('session-')); }
  const session = (await page.evaluate(() => window.xiaowang.getState())).settings;
  assert.match(session.keyHint, localMac ? /已保存/ : /仅本次使用/);
  assert.match(session.realtimeKeyHint, localMac ? /已保存/ : /仅本次使用/);
  captured.length = 0; await page.evaluate(() => window.xiaowang.listModels({}));
  assert.equal(captured[0].key, 'Bearer session-text');
  await closeTestApp(app); app = await electron.launch({ args, env }); page = await app.firstWindow(); await page.waitForSelector('.composer');
  assert.equal(Boolean((await page.evaluate(() => window.xiaowang.getState())).settings.keyHint), localMac);
});

test('only the app document can invoke native actions or use microphone; remote pages cannot navigate the app or use devices', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-pages-')), profile = path.join(root, 'profile'); await mkdir(profile);
  const remote = await serve((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Remote research</title><h1>REMOTE</h1>'); });
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: remote.url + '/v1', locale: 'zh' }));
  const app = await electron.launch({ args, env: cleanEnv(path.join(root, 'home'), profile) });
  t.after(async () => { await closeTestApp(app); await stop(remote.server); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer'); const entry = page.url();
  const audio = await page.evaluate(async () => { try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); return true; } catch (error) { return error.name; } });
  assert.equal(audio, true);
  assert.equal(await page.evaluate(async () => { try { const stream = await navigator.mediaDevices.getUserMedia({ video: true }); stream.getTracks().forEach(track => track.stop()); return false; } catch { return true; } }), true);
  await app.evaluate(({ shell, BrowserWindow }) => {
    globalThis.externalLinks = []; shell.openExternal = async url => { globalThis.externalLinks.push(url); };
    globalThis.navigationAttempts = 0; BrowserWindow.getAllWindows()[0].webContents.on('will-navigate', () => { globalThis.navigationAttempts++; });
  });
  await page.evaluate(url => { location.href = url; }, remote.url);
  await until(() => app.evaluate(() => globalThis.navigationAttempts === 1));
  assert.equal(await app.evaluate(() => globalThis.navigationAttempts), 1); assert.equal(page.url(), entry);
  await page.evaluate(() => { window.open('https://example.com/research'); window.open('file:///tmp/untrusted.html'); });
  await until(() => app.evaluate(() => globalThis.externalLinks.length === 1));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => ({ links: globalThis.externalLinks, count: BrowserWindow.getAllWindows().length })), { links: ['https://example.com/research'], count: 1 });
  const denied = await app.evaluate(async ({ BrowserWindow }, url) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const probe = new BrowserWindow({ show: false, webPreferences: { preload: owner.webContents.getLastWebPreferences().preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await probe.loadURL(url);
      return await probe.webContents.executeJavaScript(`(async () => {
        let ipcDenied = false, microphoneDenied = false;
        try { await window.xiaowang.saveSettings({ locale: 'en' }); } catch { ipcDenied = true; }
        try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); } catch { microphoneDenied = true; }
        return { ipcDenied, microphoneDenied };
      })()`);
    } finally { probe.destroy(); }
  }, remote.url);
  assert.deepEqual(denied, { ipcDenied: true, microphoneDenied: true });
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).settings.locale, 'zh');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.composer');
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await page.evaluate(() => window.xiaowang.browserHolder('user'));
  await page.evaluate(url => window.xiaowang.browserGo(url), remote.url);
  const browserDenied = await app.evaluate(async ({ webContents }) => {
    const view = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:'));
    return view.executeJavaScript(`navigator.mediaDevices.getUserMedia({audio:true}).then(stream => { stream.getTracks().forEach(t => t.stop()); return false; }, () => true)`);
  });
  assert.equal(browserDenied, true); assert.equal(page.url(), entry);
});

test('Mac legacy profile opens without decryption and migrates on the first user action', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-migration-'));
  const profile = path.join(root, 'profile');
  const env = cleanEnv(path.join(root, 'home'), profile);
  const launch = () => electron.launch({ args, env });
  let app = await launch();
  t.after(async () => { await closeTestApp(app); await rm(root, { recursive: true, force: true }); });
  const raw = await app.evaluate(({ safeStorage }) => safeStorage.encryptString(JSON.stringify({ model: 'old-model', apiKey: 'old-key-0120' })).toString('base64'));
  await closeTestApp(app);
  const oldFile = path.join(profile, 'secrets.bin'), newFile = path.join(profile, 'settings.local.json');
  await writeFile(oldFile, Buffer.from(raw, 'base64'));
  app = await launch();
  const page = await app.firstWindow();
  await page.waitForSelector('.composer');
  assert.equal(await page.locator('.settings-modal').count(), 0);
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).settings.pendingMigration, true);
  await assert.rejects(readFile(newFile), { code: 'ENOENT' });
  await app.evaluate(({ safeStorage }) => {
    globalThis.restoreDecrypt = safeStorage.decryptString.bind(safeStorage);
    safeStorage.decryptString = () => { throw Error('denied'); };
  });
  await assert.rejects(page.evaluate(() => window.xiaowang.restoreSettings()), /旧密钥/);
  await assert.rejects(page.evaluate(() => window.xiaowang.saveSettings({ locale: 'en' })), /旧密钥/);
  assert.equal((await readFile(oldFile)).toString('base64'), raw);
  await assert.rejects(readFile(newFile), { code: 'ENOENT' });
  await app.evaluate(({ safeStorage }) => { safeStorage.decryptString = globalThis.restoreDecrypt; });
  await page.locator('button.settings').click();
  await page.getByPlaceholder('deepseek-chat').waitFor();
  assert.equal(await page.getByPlaceholder('deepseek-chat').inputValue(), 'old-model');
  assert.equal(JSON.parse(await readFile(newFile)).apiKey, 'old-key-0120');
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(newFile)).mode & 0o777, 0o600);
  await closeTestApp(app); app = await launch();
  const restored = await (await app.firstWindow()).evaluate(() => window.xiaowang.getState());
  assert.equal(restored.settings.pendingMigration, false); assert.match(restored.settings.keyHint, /0120/);

  // Return this disposable profile to its pre-migration state and replace the key manually.
  await closeTestApp(app); await rm(newFile); app = await launch();
  await app.evaluate(({ safeStorage }) => { safeStorage.decryptString = () => { throw Error('denied'); }; });
  const replacement = await app.firstWindow();
  await replacement.locator('button.settings').click();
  await replacement.getByPlaceholder('deepseek-chat').fill('new-model');
  await replacement.getByLabel('模型密钥', { exact: true }).fill('replacement-4321');
  await replacement.getByRole('button', { name: '保存并进入' }).click();
  await replacement.locator('.settings-modal').waitFor({ state: 'detached' });
  assert.match((await replacement.evaluate(() => window.xiaowang.getState())).settings.keyHint, /4321/);
  assert.equal((await readFile(oldFile)).toString('base64'), raw);
});
