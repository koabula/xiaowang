import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electron, closeTestApp } from './launch.mjs';

test('background desktop stays hidden and renders light/dark screenshots without OS focus or clipboard access', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-background-')), profile = path.join(root, 'profile'); await mkdir(profile);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: 'http://localhost:1', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer textarea');
  const settings = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.focusable, throttled: window.webContents.getBackgroundThrottling(), muted: window.webContents.isAudioMuted() };
  });
  assert.deepEqual(settings, { visible: false, focused: false, focusable: false, throttled: false, muted: true });
  await page.locator('.composer textarea').fill('第一行\n第二行'); await page.locator('.composer.multiline').waitFor();
  const shots = process.env.XIAOWANG_SCREENSHOT_DIR ?? root; await mkdir(shots, { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const png = await page.screenshot({ path: path.join(shots, `background-${colorScheme}.png`), animations: 'disabled' });
    const colors = await app.evaluate(({ nativeImage }, encoded) => {
      const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64')), pixels = image.toBitmap(), colors = new Set();
      for (let i = 0; i < pixels.length; i += 400) colors.add(pixels.subarray(i, i + 3).toString('hex'));
      return colors.size;
    }, png.toString('base64'));
    assert.ok(colors > 8, 'A hidden-window screenshot must contain rendered UI rather than a blank surface');
  }
  assert.deepEqual(await app.evaluate(() => globalThis.__xwBackgroundAudit), { shown: [], focused: [], clipboard: [] });
});
