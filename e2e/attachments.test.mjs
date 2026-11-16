import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { closeTestApp } from './launch.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 200; n++) { const value = await check(); if (value) return value; await sleep(30); } throw Error('Attachment condition timed out'); }

function tinyPdf(sentence, pages = 3) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids=[];
  for(let page=1;page<=pages;page++) {
    const id=objects.length+1; kids.push(`${id} 0 R`);
    const content=`BT /F1 18 Tf 72 720 Td (${page===1?sentence:`PAGE-${page}-UNIQUE-SEARCH`}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id+1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let pdf="%PDF-1.4\n";const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset=>{pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;});
  return Buffer.from(pdf+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('actual clipboard paste, attachments, vision payloads, bot isolation, errors and restart', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-attachment-')), profile = path.join(root, 'profile'); await mkdir(profile);
  const requests = []; let failure = false;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.ok(body.tools?.some(tool => (tool.function?.name ?? tool.name) === "inspect_event"), "Only task requests are sent; history lookup is available");
    if (failure) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'image input is not supported by this model' })); return; }
    const last = body.messages.findLast(m => m.role === 'user');
    const text = typeof last.content === 'string' ? last.content : last.content.filter(p => p.type === 'text').map(p => p.text).join(' ');
    const toolDone = body.messages.at(-1).role === 'tool';
    const document = text.match(/\{"id":"([^"]+)","filename":"(?:attached.md|attachment.pdf)"/);
    if (req.url.endsWith('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'ANTHROPIC-IMAGE-OK' }] })); return; }
    const delta = document && !toolDone ? { tool_calls: [{ index: 0, id: `read-attachment-${requests.length}`, function: { name: 'read_document', arguments: JSON.stringify({ file: document[1] }) } }] } : { content: toolDone ? (body.messages.at(-1).content.includes('PDF-ATTACHMENT-42') ? 'PDF-BYTES-OK' : '## 结论\n\n**文档已读** ATTACHED-CONTENT-42') : '## 结论\n\n**图片已收到** VISION-OK' };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'vision-fixture', apiKey: 'local', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 10 }); });
  let page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer textarea');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(async ({ clipboard }) => clipboard.writeText('plain clipboard'));
  await page.locator('.composer textarea').focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  assert.equal(await page.locator('.composer textarea').inputValue(), 'plain clipboard'); await page.locator('.composer textarea').fill('');
  const slug = await page.evaluate(() => window.xiaowang.createBot('Attachment research', 'Separate attachments'));
  await until(async () => (await page.evaluate(() => window.xiaowang.getState())).activeSlug === slug);
  await until(async () => await page.locator('.bot-title-name').innerText() === 'Attachment research');
  await page.evaluate(() => { window.pasteTrace = []; document.addEventListener('keydown', e => window.pasteTrace.push({ type: 'key', key: e.key, control: e.ctrlKey, meta: e.metaKey, target: e.target.tagName })); document.addEventListener('paste', e => window.pasteTrace.push({ type: 'paste', files: e.clipboardData.files.length, formats: [...e.clipboardData.types], target: e.target.tagName })); window.xiaowang.onPasteShortcut(() => window.pasteTrace.push({ type: 'native', target: document.activeElement?.tagName })); });
  const png = await app.evaluate(async ({ nativeImage, clipboard, ClipboardItem }) => { const image = nativeImage.createFromBitmap(Buffer.from([0,0,255,255,0,255,0,255,255,0,0,255,255,255,255,255]), { width: 2, height: 2 }).resize({ width: 256, height: 192 }); await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]); return image.toPNG().toString('base64'); });
  const textarea = () => page.locator('.composer textarea');
  await textarea().focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  try { await page.locator('.pending-attachments .attachment-chip img').waitFor(); } catch (error) { console.log('Clipboard failure diagnostic', { platform: process.platform, clipboard: await app.evaluate(async ({ clipboard }) => (await clipboard.read()).map(item => item.types)), pending: await page.locator('.pending-attachments').allTextContents(), draft: await textarea().inputValue(), trace: await page.evaluate(() => window.pasteTrace), library: await page.evaluate(slug => window.xiaowang.library(slug), slug) }); throw error; }
  assert.equal(await page.locator('.pending-attachments .attachment-chip').count(), 1);
  await page.evaluate(() => window.xiaowang.setActive('xiaowang')); await page.locator('.pending-attachments').waitFor({ state: 'detached' });
  await page.evaluate(slug => window.xiaowang.setActive(slug), slug); await page.locator('.pending-attachments img').waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.bubble.assistant').filter({ hasText: 'VISION-OK' }).waitFor();
  const imageBlock = requests[0].messages.findLast(m => m.role === 'user').content.find(p => p.type === 'image_url');
  assert.ok(imageBlock.image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(await app.evaluate(({ nativeImage }, { url, png }) => nativeImage.createFromDataURL(url).toBitmap().equals(nativeImage.createFromBuffer(Buffer.from(png, 'base64')).toBitmap()), { url: imageBlock.image_url.url, png }), true, 'System clipboard may re-encode PNG, but model pixels must match exactly');
  const attached = (await page.evaluate(slug => window.xiaowang.events(slug), slug)).find(item => item.kind === 'user').attachments[0];
  await page.locator('.message-attachments .attachment-open').click(); await page.locator('.image-reader .image-scroll img').waitFor();
  assert.equal(await page.locator('.image-reader img').evaluate(img => img.complete && img.naturalWidth === 256), true);
  assert.equal(await page.locator('.bot.on em').innerText(), '结论 图片已收到 VISION-OK');
  await page.locator('.bot-title').focus();
  const titleStyle = await page.locator('.bot-title').evaluate(n => ({ shadow: getComputedStyle(n).boxShadow, radius: getComputedStyle(n).borderRadius, width: n.getBoundingClientRect().width }));
  assert.equal(titleStyle.shadow, 'none', 'The editorial title uses a flat surface'); assert.ok(parseFloat(titleStyle.radius) <= 8); assert.equal(await page.locator('.bot-title').getAttribute('aria-expanded'), 'false');
  await page.locator('.bot-title').click(); assert.equal(await page.locator('.bot-title').getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: path.join(os.tmpdir(), 'xiaowang-attachments-title.png') });
  await page.evaluate(slug => window.xiaowang.renameBot(slug, '很长的研究主题名称'.repeat(8)), slug);
  assert.equal(await page.locator('.bot-title-name').evaluate(n => n.scrollWidth > n.clientWidth), true);
  const noOverlap = await page.locator('.thread > header').evaluate(n => n.querySelector('.bot-title').getBoundingClientRect().right < n.querySelector('.stage-toggle').getBoundingClientRect().left); assert.equal(noOverlap, true);
  await page.evaluate(slug => window.xiaowang.renameBot(slug, 'Attachment research'), slug);
  await page.locator('.attachment-picker').setInputFiles([{ name: 'attached.md', mimeType: 'text/markdown', buffer: Buffer.from('# Input\nATTACHED-CONTENT-42') }, { name: 'other.txt', mimeType: 'text/plain', buffer: Buffer.from('other text') }]);
  await until(async () => await page.locator('.pending-attachments .attachment-open').count() === 2);
  await textarea().fill('Read the attached document'); await textarea().press('Enter');
  await page.locator('.bubble.assistant').filter({ hasText: 'ATTACHED-CONTENT-42' }).waitFor();
  assert.ok(requests.some(body => body.messages.some(m => m.role === 'tool' && m.content.includes('ATTACHED-CONTENT-42'))), 'Actual document bytes returned through read_document');
  assert.equal(await page.locator('.pending-attachments').count(), 0);
  await page.locator('.attachment-picker').setInputFiles({ name: 'attachment.pdf', mimeType: 'application/pdf', buffer: tinyPdf('PDF-ATTACHMENT-42', 1) });
  await page.locator('.pending-attachments .attachment-open').waitFor(); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.bubble.assistant').filter({ hasText: 'PDF-BYTES-OK' }).waitFor();
  assert.ok(requests.some(body => body.messages.some(m => m.role === 'tool' && m.content.includes('PDF-ATTACHMENT-42'))));
  await page.screenshot({ path: path.join(os.tmpdir(), 'xiaowang-attachments-flat.png') });
  assert.equal(await page.locator('.user-message .bubble.user .attachment-chip').count(), 0, 'Attachments do not nest inside colored message bubbles');
  // Drag/drop uses the same attachment path; remove before sending.
  await page.locator('.composer').evaluate(node => { const data = new DataTransfer(); data.items.add(new File(['drag text'], 'drag.md', { type: 'text/markdown' })); node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); });
  await page.getByRole('button', { name: '移除 drag.md', exact: true }).waitFor(); await page.getByRole('button', { name: '移除 drag.md', exact: true }).click();
  await page.locator('.attachment-picker').setInputFiles({ name: 'blocked.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('not supported') });
  await page.locator('.pending-attachments [role="alert"]').waitFor(); assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled().catch(() => true), true);
  await page.getByRole('button', { name: '移除 blocked.exe', exact: true }).click();
  // Exercise the native fallback even where Chromium normally exposes clipboard files.
  await textarea().evaluate(node => node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })));
  await page.locator('.pending-attachments img').waitFor();
  await page.locator('.pending-attachments .attachment-remove').click();
  // Verify Anthropic's native image blocks, then verify unsupported-model errors preserve the draft.
  await page.evaluate(() => window.xiaowang.saveSettings({ apiStyle: 'anthropic' }));
  await page.locator('.attachment-picker').setInputFiles({ name: 'again.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.locator('.pending-attachments img').waitFor(); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.bubble.assistant').filter({ hasText: 'ANTHROPIC-IMAGE-OK' }).waitFor();
  assert.ok(requests.at(-1).messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image' && p.source.data === png)));
  failure = true;
  await page.locator('.attachment-picker').setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await page.locator('.pending-attachments img').waitFor();
  await textarea().fill('Keep this failed draft'); await textarea().press('Enter');
  await until(async () => await textarea().inputValue() === 'Keep this failed draft'); await page.locator('.pending-attachments img').waitFor();
  assert.match(await page.locator('.toast').innerText(), /支持视觉输入/);
  await assert.rejects(page.evaluate(ref => window.xiaowang.ask('xiaowang', 'foreign reference', [ref]), attached.refId), /没有这份/);
  await assert.rejects(page.evaluate(() => window.xiaowang.attach('xiaowang', 'huge.txt', new Uint8Array(21 * 1024 * 1024))), /20 MB/);
  await assert.rejects(page.evaluate(() => window.xiaowang.attach('xiaowang', 'broken.png', new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]))), /有效的图片/);
  await closeTestApp(app); app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env }); page = await app.firstWindow(); await page.waitForSelector('.composer');
  await page.locator('.message-attachments img').first().waitFor();
  assert.ok((await page.evaluate(slug => window.xiaowang.events(slug), slug)).filter(item => item.kind === 'user').every(item => !JSON.stringify(item).includes(png)), 'History stores references, not base64');
  assert.deepEqual(errors, []);
});
