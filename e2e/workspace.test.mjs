import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { Runtime } from '../src/runtime.ts';
import { closeTestApp } from './launch.mjs';

function twoPages() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('unified workspace: mixed resources, overflow keyboard/menu, closing, themes, capsule drafts and native overlays', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-unified-workspace-'));
  const home = path.join(root, 'home'); const profile = path.join(root, 'profile');
  await mkdir(profile);
  const runtime = Runtime.open(home); const bot = runtime.activeBot();
  const pdf = runtime.store.addLibraryBytes(bot.id, '研究原文.pdf', twoPages()).ref;
  const notes = Array.from({ length: 8 }, (_, index) => runtime.store.addLibraryBytes(bot.id, `研究笔记-${index + 1}-长文件名.md`, Buffer.from(`# 研究笔记 ${index + 1}\n\n原文、方法与实验。\n`)).ref);
  await writeFile(path.join(bot.workspaceDir, '讲解.html'), '<style>.slide{display:none;padding:24px;font:20px sans-serif}.slide.active{display:block}</style><section class="slide active">讲解第一页</section><section class="slide">讲解第二页</section>');
  runtime.close();
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>研究网页</title><h1>WEB-CONTENT</h1><input aria-label="entry">'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: url, apiKey: 'local', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.composer');
  const shots = process.env.XIAOWANG_SCREENSHOT_DIR || root; await mkdir(shots, { recursive: true });
  const open = ref => page.evaluate(id => window.xiaowang.openReference('xiaowang', id, 1), ref.id);
  await open(pdf);
  await page.getByRole('textbox', { name: 'PDF page / PDF页码', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-header').evaluate(node => node.getBoundingClientRect().height), 40);
  assert.ok(await page.locator('.pdf-viewer-host').evaluate(node => node.getBoundingClientRect().top - node.closest('.stage').getBoundingClientRect().top) <= 80);
  await page.getByRole('button', { name: 'Next page / 下一页', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="PDF page / PDF页码"]').value === '2');
  for (const note of notes) await open(note);
  await page.locator('.prose').filter({ hasText: '研究笔记 8' }).waitFor();
  assert.ok(await page.locator('.resource-tabs').evaluate(node => node.scrollWidth > node.clientWidth), 'Many resources remain one scrolling row');
  await page.getByRole('button', { name: '资源列表', exact: true }).click();
  await page.getByRole('menuitem', { name: '研究原文.pdf', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="PDF page / PDF页码"]')?.value === '2');
  const selected = page.getByRole('tab', { name: '研究原文.pdf', exact: true });
  await selected.focus(); await selected.press('ArrowRight');
  await page.locator('.prose').filter({ hasText: '研究笔记 1' }).waitFor();
  await page.getByRole('button', { name: '关闭 研究笔记-1-长文件名.md', exact: true }).click();
  await page.getByRole('tab', { name: '研究笔记-1-长文件名.md', exact: true }).waitFor({ state: 'detached' });
  await page.locator('.pdf-controls').waitFor();
  await page.evaluate(() => window.xiaowang.openPage('xiaowang', '讲解.html', 1));
  await page.locator('.canvas-stage .reader-pager').filter({ hasText: '1 / 2' }).waitFor();
  assert.equal(await page.locator('.canvas-stage .reader-toolbar').innerText(), '1 / 2');
  await page.getByRole('button', { name: 'Next page / 下一页', exact: true }).click();
  await page.locator('.canvas-stage .reader-pager').filter({ hasText: '2 / 2' }).waitFor();
  await page.getByRole('button', { name: '展开阅读区', exact: true }).click();
  assert.equal(await page.locator('.thread').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.thread').isVisible(), true);
  const composer = page.locator('.composer textarea');
  await composer.fill('短问题');
  await page.locator('.composer:not(.multiline)').waitFor();
  assert.ok(await page.locator('.composer-row').evaluate(node => parseFloat(getComputedStyle(node).borderTopLeftRadius) >= node.getBoundingClientRect().height / 2));
  await composer.press('Shift+Enter');
  await page.locator('.composer.multiline').waitFor();
  await composer.fill('自动换行测试内容'.repeat(30));
  await page.locator('.composer.multiline').waitFor();
  await composer.fill('短问题');
  await page.locator('.composer:not(.multiline)').waitFor();
  await composer.fill('第一行研究目标\n第二行补充条件\n第三行输出要求');
  await page.locator('.attachment-picker').setInputFiles({ name: '要求.txt', mimeType: 'text/plain', buffer: Buffer.from('附件正文') });
  await page.locator('.pending-attachments .attachment-remove').waitFor();
  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 840 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(() => {
        const list = document.querySelector('.resource-tabs').getBoundingClientRect();
        const selected = document.querySelector('.resource-trigger[data-state="active"]').getBoundingClientRect();
        return selected.left >= list.left - 1 && selected.right <= list.right + 1;
      });
      const geometry = await page.locator('.composer').evaluate(node => {
        const row = node.querySelector('.composer-row'), text = node.querySelector('textarea'), attachments = node.querySelector('.pending-attachments');
        const rect = row.getBoundingClientRect(), textRect = text.getBoundingClientRect();
        return { radius: parseFloat(getComputedStyle(row).borderTopLeftRadius), height: rect.height, textHeight: textRect.height, textFits: textRect.left >= rect.left && textRect.right <= rect.right && textRect.top >= rect.top && textRect.bottom <= rect.bottom, attachmentAbove: attachments.getBoundingClientRect().bottom <= rect.top, pageFits: document.documentElement.scrollWidth <= innerWidth };
      });
      assert.ok(geometry.radius > 0 && geometry.radius <= 24 && geometry.radius < geometry.height / 2);
      assert.ok(geometry.textHeight > 38 && geometry.textFits && geometry.attachmentAbove && geometry.pageFits);
      assert.notEqual(await page.locator('.thread + .split').evaluate(node => getComputedStyle(node).backgroundImage), 'none');
      assert.equal(await page.locator('.resource-actions').evaluate(node => node.getBoundingClientRect().right <= innerWidth), true);
      await page.screenshot({ path: path.join(shots, `workspace-${width}-${colorScheme}.png`), animations: 'disabled' });
    }
  }
  await page.locator('.attachment-remove').click();
  await composer.fill('');
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await page.getByRole('button', { name: '取得控制权', exact: true }).click();
  await page.getByRole('textbox', { name: '网页地址', exact: true }).fill(url);
  await page.getByRole('textbox', { name: '网页地址', exact: true }).press('Enter');
  const browserVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(view => view.getVisible()));
  await page.waitForFunction(() => document.querySelector('.url input').value.includes('127.0.0.1'));
  assert.equal(await browserVisible(), true);
  await page.getByRole('button', { name: '资源列表', exact: true }).click();
  assert.equal(await browserVisible(), false, 'Native webpage yields to the Radix menu');
  await page.getByRole('menuitem', { name: '研究原文.pdf', exact: true }).click();
  await page.locator('.pdf-controls').waitFor();
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  assert.equal(await browserVisible(), true);
  await page.getByRole('button', { name: '从资料库打开', exact: true }).click();
  await page.getByRole('dialog', { name: '浏览任务资料', exact: true }).waitFor();
  assert.equal(await browserVisible(), false, 'File browser stays above the native page');
  await page.getByRole('button', { name: '关闭资料浏览器', exact: true }).click();
  await page.reload(); await page.waitForSelector('.composer');
  await page.getByRole('tab', { name: '研究笔记-8-长文件名.md', exact: true }).click();
  await page.locator('.prose').filter({ hasText: '研究笔记 8' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '研究笔记-1-长文件名.md', exact: true }).count(), 0, 'Closed tabs stay closed after reload');
  assert.deepEqual(errors, []);
});
