import { electron, launchPackaged, closeTestApp } from './launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(40); } throw new Error('Update UI did not reach the expected state'); }

const currentVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const nextVersion = currentVersion.replace(/\d+$/, value => String(Number(value) + 1));

test('desktop updates: version, icon-only offer, verified download, retry and deferral for unsaved settings', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-updates-')); const home = path.join(root, 'home'); const profile = path.join(root, 'profile'); await mkdir(profile);
  let release = 'absent'; let attempts = 0;
  const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const extension = platform === 'mac' ? 'zip' : platform === 'win' ? 'exe' : 'AppImage';
  const filename = `XiaoWang-${nextVersion}-${platform}-${process.arch}.${extension}`;
  const bytes = Buffer.alloc(400_000, 42); const sha512 = createHash('sha512').update(bytes).digest('base64');
  const server = createServer(async (request, response) => {
    if (request.url.includes('latest')) {
      if (release === 'absent') { response.writeHead(404); response.end('no release'); return; }
      const version = release === 'same' ? currentVersion : nextVersion;
      response.writeHead(200, { 'content-type': 'text/yaml' }); response.end(JSON.stringify({ version, ...(release === 'unsupported' ? { minimumSystemVersion: '999.0.0' } : {}), files: [{ url: filename, sha512, size: bytes.length }], path: filename, sha512 })); return;
    }
    if (request.url.split('?')[0].endsWith(filename)) {
      attempts++; response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      const payload = Buffer.from(bytes); if (attempts === 1) payload[0] = 0;
      for (let offset = 0; offset < payload.length; offset += 20_000) { if (response.destroyed) return; response.write(payload.subarray(offset, offset + 20_000)); await sleep(65); }
      response.end(); return;
    }
    response.writeHead(404); response.end();
  }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', locale: 'zh' }));
  const oldImage = path.join(root, 'old.AppImage'); await writeFile(oldImage, 'old');
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_UPDATE_TEST_FEED: `http://127.0.0.1:${server.address().port}/`, ...(process.platform === 'linux' ? { APPIMAGE: oldImage } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = process.env.XIAOWANG_E2E_EXECUTABLE ? await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, ['--no-sandbox'], env) : await electron.launch({ args: ['--no-sandbox', '.'], env });
  const cacheBase = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches') : process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local') : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const cache = path.join(cacheBase, `xiaowang-test-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}`);
  t.after(async () => { await page.evaluate(() => window.xiaowang.settingsDirty(false)).catch(() => {}); await closeTestApp(app); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.waitForSelector('.composer');
  const state = () => page.evaluate(() => window.xiaowang.getState());
  assert.equal((await state()).version, currentVersion);
  await until(async () => (await state()).update.phase === 'error');
  assert.equal(await page.locator('.update-button').count(), 0, 'A repository with no releases has no update button');
  release = 'same'; await page.evaluate(() => window.xiaowang.checkUpdate());
  assert.equal((await state()).update.phase, 'idle'); assert.equal(await page.locator('.update-button').count(), 0);
  release = 'unsupported'; await page.evaluate(() => window.xiaowang.checkUpdate());
  assert.equal((await state()).update.phase, 'idle'); assert.equal(await page.locator('.update-button').count(), 0, 'An incompatible release is not offered');
  release = 'new'; await page.evaluate(() => window.xiaowang.checkUpdate());
  const button = page.locator('.rail footer .update-button'); await button.waitFor();
  assert.equal(await button.textContent(), '', 'The circular update control has no visible text');
  assert.match(await button.getAttribute('aria-label'), new RegExp(nextVersion.replaceAll('.', '\\.')));
  const settingsBox = await page.locator('.rail footer .settings').boundingBox(); const updateBox = await button.boundingBox();
  assert.ok(updateBox.x >= settingsBox.x + settingsBox.width, 'The icon is to the right of Settings');
  await page.screenshot({ path: path.join(os.tmpdir(), 'xiaowang-update-offer.png') });
  await page.setViewportSize({ width: 850, height: 760 });
  const smallSettings = await page.locator('.rail footer .settings').boundingBox(); const smallUpdate = await button.boundingBox();
  assert.ok(smallUpdate.x >= smallSettings.x + smallSettings.width && Math.abs(smallUpdate.y - smallSettings.y) < 8, 'The icon remains to the right in the compact sidebar');
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.locator('.rail .settings').click(); await page.locator('.app-version').waitFor();
  const updatePanel = page.getByRole('region', { name: '应用更新', exact: true });
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await until(async () => (await state()).update.phase === 'available');
  assert.match(await page.getByRole('button', { name: '检查更新', exact: true }).getAttribute('title'), /上次检查/);
  assert.equal((await page.locator('.app-version').textContent()).trim(), `版本 ${currentVersion}`);
  const heading = await page.locator('.modal header').boundingBox(); const versionBox = await page.locator('.app-version').boundingBox();
  const checkBox = await page.getByRole('button', { name: '检查更新', exact: true }).boundingBox();
  assert.ok(checkBox.x >= versionBox.x + versionBox.width && Math.abs((checkBox.y + checkBox.height / 2) - (versionBox.y + versionBox.height / 2)) < 8, 'Manual check sits next to the version');
  assert.ok(versionBox.y >= heading.y && versionBox.y + versionBox.height <= heading.y + heading.height, 'Version is visible in the settings heading without scrolling');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await button.click(); await until(async () => (await state()).update.phase === 'downloading');
  await until(() => button.isDisabled());
  await until(async () => (await state()).update.phase === 'error');
  assert.match((await state()).update.error, /checksum|sha512|校验/i, 'Corrupt bytes must never reach installation');
  await until(async () => !(await button.isDisabled()));
  await button.click(); await until(async () => (await state()).update.phase === 'downloading');
  await page.locator('.rail .settings').click(); await page.locator('.modal input').first().fill('edited-setting');
  await updatePanel.getByRole('progressbar', { name: '更新进度' }).waitFor();
  await until(async () => (await state()).update.percent > 0);
  assert.match(await updatePanel.getByRole('status').innerText(), /正在下载更新.*%/);
  await until(async () => (await state()).update.phase === 'ready');
  await sleep(2200);
  assert.equal((await state()).update.phase, 'ready', 'Dirty settings block installation after download');
  assert.match(await button.getAttribute('aria-label'), /设置更改保存或放弃/);
  assert.match(await updatePanel.getByRole('status').innerText(), /等待设置更改保存或放弃/);
  assert.equal(attempts, 2); assert.equal(await page.locator('.composer').count(), 1);
  assert.deepEqual(errors, []);
  console.log('Verified real update feed, version in settings, icon-only placement, checksum failure/retry, download progress and unsaved-settings installation guard.');
});
