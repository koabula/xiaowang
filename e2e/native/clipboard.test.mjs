import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchNative, closeTestApp } from '../launch.mjs';

// Run only on a dedicated desktop: this deliberately exercises the OS clipboard.
test('native: real text/image clipboard shortcuts and image fallback', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-native-clipboard-')), profile = path.join(root, 'profile'); await mkdir(profile);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: 'http://localhost:1', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchNative({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); const draft = page.locator('.composer textarea'); await draft.waitFor();
  await app.evaluate(({ clipboard }) => clipboard.writeText('NATIVE-CLIPBOARD'));
  await draft.focus(); await draft.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  assert.equal(await draft.inputValue(), 'NATIVE-CLIPBOARD'); await draft.fill('');
  await app.evaluate(async ({ nativeImage, clipboard, ClipboardItem }) => {
    const image = nativeImage.createFromBitmap(Buffer.alloc(16, 255), { width: 2, height: 2 }).resize({ width: 256, height: 192 });
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
  });
  await draft.focus(); await draft.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await page.locator('.pending-attachments img').waitFor();
  assert.equal(await page.locator('.pending-attachments img').evaluate(img => img.complete && img.naturalWidth === 256), true);
  await page.locator('.attachment-remove').click();
  await draft.evaluate(node => node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })));
  await page.locator('.pending-attachments img').waitFor();
});
