import { electron, closeTestApp } from './launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../src/runtime.ts';

// Real PDF annotation borders, including a quadrilateral SVG border, and enough
// links for PDF.js's annotation z-index to exceed the settings overlay's level.
function linkedPdf() {
  const objects = []; const add = text => { objects.push(text); return objects.length; };
  const catalog = add(''), pages = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const first = add(''), content = add('<< /Length 0 >>\nstream\n\nendstream');
  const annotations = [];
  for (let i = 0; i < 12; i++) annotations.push(add(''));
  const second = add('');
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${first} 0 R ${second} 0 R] /Count 2 >>`;
  const page = (annots = '') => `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> ${annots} >>`;
  objects[first - 1] = page(`/Annots [${annotations.map(id => `${id} 0 R`).join(' ')}]`);
  objects[second - 1] = page();
  annotations.forEach((id, i) => {
    const x = 70 + (i % 3) * 150, y = 650 - Math.floor(i / 3) * 45;
    const color = ['0 1 0', '1 0 0', '0 0 1'][i % 3];
    const action = i === 11 ? '/A << /S /URI /URI (https://example.test/paper) >>' : `/Dest [${second} 0 R /Fit]`;
    const quad = i === 11 ? `/QuadPoints [${x} ${y + 16} ${x + 45} ${y + 16} ${x} ${y} ${x + 45} ${y} ${x + 55} ${y + 16} ${x + 100} ${y + 16} ${x + 55} ${y} ${x + 100} ${y}]` : '';
    objects[id - 1] = `<< /Type /Annot /Subtype /Link /Rect [${x} ${y} ${x + 100} ${y + 16}] /Border [0 0 1] /C [${color}] ${quad} ${action} >>`;
  });
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('PDF links have no permanent frames, stay below settings, and notices expire three seconds after the latest event', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-pdf-notices-')); const profile = path.join(root, 'profile'); await mkdir(profile);
  const runtime = Runtime.open(path.join(root, 'home'));
  const ref = runtime.store.addLibraryBytes(runtime.activeBot().id, 'links.pdf', linkedPdf()).ref; runtime.close();
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: 'local', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer');
  await page.evaluate(id => window.xiaowang.openReference('xiaowang', id, 1), ref.id);
  const links = page.locator('.pdfViewer .page').first().locator('.annotationLayer .linkAnnotation');
  await links.nth(11).waitFor();
  const decoration = await links.evaluateAll(nodes => nodes.map(node => ({ border: getComputedStyle(node).borderColor, background: getComputedStyle(node).backgroundImage, originalBorder: node.style.borderColor, originalBackground: node.style.backgroundImage, z: Number(node.style.zIndex) })));
  assert.equal(decoration.length, 12);
  assert.ok(decoration.every(item => item.border === 'rgba(0, 0, 0, 0)' && item.background === 'none'));
  assert.ok(decoration.some(item => item.originalBorder), 'The fixture really contains PDF border styling');
  assert.ok(decoration.some(item => item.originalBackground.includes('svg')), 'Quadrilateral SVG borders are covered too');
  assert.ok(Math.max(...decoration.map(item => item.z)) > 6);
  const internal = links.first().locator('a'); await internal.focus();
  assert.equal(await internal.evaluate(node => getComputedStyle(node).outlineWidth), '2px', 'Keyboard link focus remains visible');
  await internal.click();
  await page.waitForFunction(() => document.querySelector('.pdf-controls input')?.value === '2');
  const input = page.getByRole('textbox', { name: 'PDF page / PDF页码', exact: true }); await input.fill('1'); await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('.pdf-controls input')?.value === '1');
  assert.equal(await links.last().locator('a').getAttribute('href'), 'https://example.test/paper');
  await page.locator('button.settings').click();
  const settings = page.getByRole('form', { name: '设置', exact: true }); await settings.waitFor();
  const overlap = await page.evaluate(() => {
    const form = document.querySelector('.settings-modal form').getBoundingClientRect();
    return [...document.querySelectorAll('.pdfViewer .linkAnnotation')].filter(node => Number(node.style.zIndex) > 6).flatMap(node => {
      const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      return x > form.left && x < form.right && y > form.top && y < form.bottom ? [{ topIsSettings: !!document.elementFromPoint(x, y)?.closest('.settings-modal') }] : [];
    });
  });
  assert.ok(overlap.length, 'Actual link coordinates overlap the settings form');
  assert.ok(overlap.every(point => point.topIsSettings), 'High annotation z-index must remain inside the PDF stacking context');
  if (process.env.XIAOWANG_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.XIAOWANG_SCREENSHOT_DIR, 'pdf-settings-layers.png') });
  await settings.getByRole('button', { name: '关闭', exact: true }).click();

  // Drive the application's real notification listener, using a fake clock only
  // after the PDF has finished rendering so the timer assertions stay precise.
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  // install() still advances with wall time; pause before checking exact 3s boundaries.
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  async function notify(filename) {
    await app.evaluate(({ BrowserWindow }, filename) => BrowserWindow.getAllWindows()[0].webContents.send('download', { slug: 'xiaowang', filename }), filename);
    await page.locator('.toast').filter({ hasText: filename }).waitFor();
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await notify('first.txt'); await page.clock.runFor(2900); assert.equal(await page.locator('.toast').count(), 1);
  await page.clock.runFor(150); await page.locator('.toast').waitFor({ state: 'detached' });
  await notify('old.txt'); await page.clock.runFor(2000); await notify('new.txt');
  await page.clock.runFor(1100); assert.match(await page.locator('.toast').innerText(), /new.txt/);
  await page.clock.runFor(1950); await page.locator('.toast').waitFor({ state: 'detached' });
  await notify('repeat.txt'); await page.clock.runFor(2000); await notify('repeat.txt');
  await page.clock.runFor(1100); assert.match(await page.locator('.toast').innerText(), /repeat.txt/);
  await page.clock.runFor(1950); await page.locator('.toast').waitFor({ state: 'detached' });
  await notify('manual.txt'); await page.locator('.toast').click(); await page.locator('.toast').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.annotationLayer .linkAnnotation').count(), 12, 'Toast cleanup does not remove PDF links');
});
