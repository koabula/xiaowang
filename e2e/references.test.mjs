import { electron, closeTestApp } from './launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { executeTool } from '../src/tools.ts';

function paper(marker) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let page = 1; page <= 7; page++) {
    const id = objects.length + 1; kids.push(`${id} 0 R`);
    const content = `BT /F1 18 Tf 72 720 Td (${marker}-PAGE-${page}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 7 >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('references: same-name PDFs open the exact page from chat and reopened notes; workspace images preview', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-references-')), home = path.join(root, 'home'), profile = path.join(root, 'profile');
  await mkdir(profile);
  const runtime = Runtime.open(home), bot = runtime.activeBot();
  runtime.store.addLibraryBytes(bot.id, 'paper.pdf', paper('WRONG'));
  const target = runtime.store.addLibraryBytes(bot.id, 'paper.pdf', paper('CORRECT')).ref;
  const read = await executeTool('read_document', { file: target.id, start_page: 7 }, { store: runtime.store, bot, enqueueKickoff() {} });
  assert.equal(read.isError, false); assert.ok(read.output.includes(`[第 7 页](xwref://${target.id}?page=7)`));
  const link = `[核对第七页](xwref://${target.id}?page=7)`;
  runtime.store.append(bot.id, { type: 'user_text', channel: 'text', text: '核对出处' });
  runtime.store.append(bot.id, { type: 'assistant_turn', channel: 'text', text: link, toolCalls: [] });
  await writeFile(path.join(bot.workspaceDir, 'notes.md'), `# 核对笔记\n\n${link}\n\n[网站](https://example.com/research)`);
  runtime.close();
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: 'http://localhost:1', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); await rm(root, { recursive: true, force: true }); });
  let page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const checkPage = async () => {
    await page.waitForFunction(() => document.querySelector('[aria-label="PDF page / PDF页码"]')?.value === '7');
    await page.locator('.page[data-page-number="7"] .textLayer').filter({ hasText: 'CORRECT-PAGE-7' }).waitFor();
    assert.equal(await page.locator('.textLayer').filter({ hasText: 'WRONG-PAGE' }).count(), 0);
  };
  await page.locator('.messages').getByRole('link', { name: '核对第七页' }).click(); await checkPage();
  await page.evaluate(() => window.xiaowang.openArtifact('xiaowang', 'notes.md'));
  await app.evaluate(({ shell }) => { globalThis.openedLinks = []; shell.openExternal = async url => { globalThis.openedLinks.push(url); }; });
  await page.locator('.prose').getByRole('link', { name: '网站', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), ['https://example.com/research']);
  assert.ok(page.url().includes('/renderer/index.html'));
  await page.locator('.prose').getByRole('link', { name: '核对第七页' }).click(); await checkPage();
  await closeTestApp(app); app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer');
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluate(() => window.xiaowang.openArtifact('xiaowang', 'notes.md'));
  await page.locator('.prose').getByRole('link', { name: '核对第七页' }).click(); await checkPage();
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(16, 255), { width: 2, height: 2 }).toPNG().toString('base64'));
  await writeFile(path.join(bot.workspaceDir, 'image.png'), Buffer.from(png, 'base64'));
  await page.evaluate(() => window.xiaowang.openArtifact('xiaowang', 'image.png'));
  await page.waitForFunction(() => { const img = document.querySelector('.image-reader img'); return img?.complete && img.naturalWidth === 2; });
  const image = await page.evaluate(data => window.xiaowang.attach('xiaowang', 'original.png', Uint8Array.from(atob(data), c => c.charCodeAt(0))), png);
  await page.evaluate(id => window.xiaowang.openReference('xiaowang', id, 1), image.refId);
  await page.waitForFunction(filename => { const img = document.querySelector('.image-reader img'); return img?.alt === filename && img.complete && img.naturalWidth === 2; }, image.filename);
  await assert.rejects(page.evaluate(() => window.xiaowang.openArtifact('xiaowang', '../outside.png')), /工作区/);
  assert.deepEqual(errors, []);
});
