import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { WebSocketServer } from 'ws';
import { Runtime } from '../src/runtime.ts';
import { launchPackaged, closeTestApp } from './launch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(30); }
  throw new Error('Research workflow did not reach the expected state');
}
function pdf() {
  const content = 'BT /F1 18 Tf 72 720 Td (RESEARCH-EVIDENCE-42) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(result); result += 'xref\n0 6\n0000000000 65535 f \n';
  offsets.slice(1).forEach(offset => { result += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(`${result}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function tone(ms = 400) {
  const pcm = Buffer.alloc(ms * 48);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 8000), i * 2);
  return pcm.toString('base64');
}

test('desktop: paper analysis, visible progress, interruption/status, real result and opening the source', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-research-'));
  const home = path.join(root, 'home'); const profile = path.join(root, 'profile'); await mkdir(profile);
  const seed = Runtime.open(home); const ref = seed.store.addLibraryBytes(seed.activeBot().id, 'paper.pdf', pdf()).ref; seed.close();
  const gates = { voice: deferred(), text: deferred() }; const waiting = new Set();
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const index = input.messages.findLastIndex(message => message.role === 'user' && /你去分析一下|文字分析测试/.test(message.content));
    assert.ok(index >= 0); const task = input.messages[index].content;
    const kind = task.includes('文字分析测试') ? 'text' : 'voice';
    const turn = input.messages.slice(index + 1);
    assert.ok(!turn.some(message => typeof message.content === 'string' && message.content.includes('梳理了吗')),'Live progress must not replace the running research goal');
    const source = turn.find(message => message.role === 'tool' && message.content.includes('RESEARCH-EVIDENCE-42'));
    const written = turn.find(message => message.role === 'tool' && /notes\/research.md/.test(message.content));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
    if (!source) {
      chunk({ content: '我先通读全文，再给出结构化的梳理结果。' });
      chunk({ tool_calls: [{ index: 0, id: `read-${kind}`, function: { name: 'read_document', arguments: JSON.stringify({ file: `${ref.id} ${ref.filename}` }) } }] }, 'tool_calls');
    } else if (!written) {
      waiting.add(kind);
      chunk({ content: '尚未完成的中途说明。' });
      await gates[kind].promise;
      chunk({ tool_calls: [{ index: 0, id: `write-${kind}`, function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/research.md', content: '原文证据：RESEARCH-EVIDENCE-42。分析结果已保存。' }) } }] }, 'tool_calls');
    } else chunk({ content: `${kind === 'text' ? '文字分析结果' : '论文分析结果'}：基于原文 RESEARCH-EVIDENCE-42，已完成梳理并保存笔记。[原文，第1页](xwref://${ref.id}?page=1)` }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'local', realtimeService: 'doubao', realtimeModel: '1.2.6.1', realtimeKey: 'local', locale: 'zh' }));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise(resolve => server.once('listening', resolve));
  let socket; let mic = 0; const returned = []; const notices = []; const instructions = [];
  const emit = event => socket.send(JSON.stringify(event));
  const speak = (id, text, ms = 400) => {
    emit({ type: 'response.output_text.delta', question_id: id, response_id: id, delta: text });
    emit({ type: 'response.output_audio.started', question_id: id, response_id: id });
    emit({ type: 'response.output_text.done', question_id: id, response_id: id, text });
    emit({ type: 'response.output_audio.delta', delta: tone(ms) });
    emit({ type: 'response.output_audio.done', question_id: id, response_id: id });
  };
  server.on('connection', connection => {
    socket = connection;
    connection.on('message', raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.create') emit({ type: 'session.created' });
      if (event.type === 'session.update') { instructions.push(event.session.instructions); emit({ type: 'session.updated' }); }
      if (event.type === 'input_audio_buffer.append') mic++;
      // Actual native service can proceed to the next ASR/tool turn without a
      // response.canceled acknowledgement. Exercise that ordering here.
      if (event.type === 'speech_text_buffer.commit') { notices.push(event.text); speak(`notice-${notices.length}`, event.text); }
      if (event.items?.[0]?.role === 'tool') {
        const item = event.items[0]; returned.push(item);
        if (item.call_id === 'lookup') speak('lookup-reply', '后台正在分析，你可以继续说。');
        if (item.call_id === 'status') speak('status-reply', '正在阅读原文，还没有完成。');
        if (item.call_id === 'open') speak('open-reply', '原文已打开。');
      }
    });
  });
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_REALTIME_URL: `ws://127.0.0.1:${server.address().port}/realtime` }; delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  const app = process.env.XIAOWANG_E2E_EXECUTABLE ? await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, args, env) : await electron.launch({ args: [...args, 'desktop/dist/main.js'], env });
  t.after(async () => { gates.voice.resolve(); gates.text.resolve(); await closeTestApp(app); for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.meters = []; const create = AudioContext.prototype.createAnalyser; AudioContext.prototype.createAnalyser = function(...args) { const meter = create.apply(this, args); window.meters.push(meter); return meter; }; });
  await page.reload(); await page.waitForSelector('.composer');
  const state = () => page.evaluate(() => window.xiaowang.getState());
  const energy = () => page.evaluate(() => { const meter = window.meters.at(-1); if (!meter) return 0; const values = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(values); return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length); });
  await page.evaluate(() => window.xiaowang.callStart('xiaowang')); await until(() => mic > 0);
  const user = (id, text) => { emit({ type: 'conversation.item.input_audio_transcription.started', item_id: id }); emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, text }); };
  const tool = (id, name, args = {}) => emit({ type: 'response.function_call_arguments.done', question_id: id, items: [{ call_id: id, name, arguments: args }] });
  user('research', '你去分析一下刚刚这篇文章。');
  // Reproduce the problematic provider order: function call, then preface, with no
  // audio completion until the app has returned the tool's result.
  tool('lookup', 'list_library');
  emit({ type: 'response.output_text.delta', question_id: 'research', response_id: 'preface', delta: '我先找到论文。' });
  emit({ type: 'response.output_text.done', question_id: 'research', response_id: 'preface', text: '我先找到论文。' });
  await until(() => returned.some(item => item.call_id === 'lookup'));
  await until(() => waiting.has('voice'));
  await page.locator('.voice-panel .task-item.running').waitFor();
  assert.equal(await page.locator('.messages .task-item').count(), 0, 'Live progress belongs to the call panel');
  assert.equal(await page.locator('.thinking').count(), 0, 'Background progress has one primary display');
  assert.equal((await state()).jobs.length, 1);
  assert.equal(await page.locator('.bubble.assistant').count(), 0, 'Intermediate streamed prefaces must not become completed answer bubbles');
  await page.screenshot({ path: '/private/tmp/xiaowang-research-working.png' });
  speak('long-before-progress', '正在阅读原文。', 2500);
  await until(async () => await energy() > .05);
  user('progress', '梳理了吗？'); tool('status', 'get_task');
  const status = await until(() => returned.find(item => item.call_id === 'status'));
  assert.equal(JSON.parse(status.content[0].text).status, 'running');
  assert.equal((await state()).jobs.length, 1);
  gates.voice.resolve();
  await until(async () => (await state()).jobs[0]?.status === 'succeeded');
  await page.locator('.voice-panel .call-task-result summary').click();
  await page.locator('.voice-panel .call-task-result').filter({ hasText: '论文分析结果：' }).waitFor();
  assert.equal(await page.locator('.bubble.assistant').count(), 0, 'Completed background turns never leak into text chat');
  await until(() => notices.some(text => text.includes('RESEARCH-EVIDENCE-42')));
  await until(() => instructions.some(text => text.includes('RESEARCH-EVIDENCE-42')));
  await until(async () => await energy() > .05); await until(async () => await energy() < .001);
  user('open-request', '现在打开这篇论文。'); tool('open', 'show_stage', { mode: 'file', file: `${ref.id} ${ref.filename}` });
  await until(() => returned.some(item => item.call_id === 'open'));
  await page.waitForFunction(() => document.querySelector('.pdf-scroll canvas')?.width > 0);
  assert.match(returned.find(item => item.call_id === 'open').content[0].text, /第 1 页/);
  assert.equal((await state()).jobs.length, 1);
  await page.getByRole('button', { name: '挂断', exact: true }).click();
  const voiceJob = (await state()).jobs.find(job => job.channel === 'voice');
  assert.ok(voiceJob.originCallId); assert.ok(voiceJob.resultEventId);
  const sourceCall = page.locator(`[data-call-id="${voiceJob.originCallId}"]`);
  await sourceCall.waitFor();
  assert.equal(await page.locator('.task-item, .call-tasks').count(), 0, 'Hangup leaves a collapsed call, not standalone task cards');
  await sourceCall.locator(':scope > button').click();
  await sourceCall.locator(`[data-job-id="${voiceJob.id}"]`).waitFor();
  await sourceCall.locator('.call-task-result summary').click();
  await sourceCall.locator('.call-task-result').getByText('论文分析结果：', { exact: false }).waitFor();
  assert.equal(await page.locator('.bubble.assistant').count(), 0);
  await page.locator('.composer textarea').fill('文字分析测试：分析这篇论文'); await page.locator('.composer textarea').press('Enter');
  await until(() => waiting.has('text'));
  await page.locator('.thinking').waitFor();
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: '尚未完成的中途说明。' }).count(), 0, 'Call work stays inside the call; the active text turn is still progress');
  gates.text.resolve();
  await page.locator('.bubble.assistant').filter({ hasText: '文字分析结果：' }).waitFor();
  await until(async () => (await state()).jobs.every(job => job.status === 'succeeded'));
  const textJob = (await state()).jobs.find(job => job.channel === 'text');
  assert.equal(textJob.display, 'conversation');
  assert.equal(await page.locator(`[data-job-id="${textJob.id}"]`).count(), 0);
  await page.locator('.thinking').waitFor({ state: 'detached' });
  await sourceCall.locator(':scope > button').click();
  gates.voice = deferred(); waiting.delete('voice');
  const previousMic = mic;
  await page.evaluate(() => window.xiaowang.callStart('xiaowang')); await until(() => mic > previousMic);
  user('late-research', '你去分析一下刚刚这篇文章。');
  await until(() => waiting.has('voice'));
  const lateJob = (await state()).jobs.find(job => job.channel === 'voice' && job.id !== voiceJob.id);
  assert.ok(lateJob?.originCallId && lateJob.originCallId !== voiceJob.originCallId);
  await page.locator('.voice-panel').locator(`[data-job-id="${lateJob.id}"]`).waitFor();
  await page.getByRole('button', { name: '挂断', exact: true }).click();
  const lateCall = page.locator(`[data-call-id="${lateJob.originCallId}"]`);
  await lateCall.waitFor();
  assert.equal(await page.locator('.task-item').count(), 0);
  gates.voice.resolve();
  await until(async () => (await state()).jobs.find(job => job.id === lateJob.id)?.status === 'succeeded');
  assert.equal(await page.locator('.task-item').count(), 0, 'Late completion cannot reopen the call or insert a standalone card');
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: '论文分析结果：' }).count(), 0);
  await lateCall.locator(':scope > button').click();
  await lateCall.locator(`[data-job-id="${lateJob.id}"] .call-task-result summary`).click();
  await lateCall.locator('.call-task-result').getByText('论文分析结果：', { exact: false }).waitFor();
  assert.equal(await sourceCall.locator('.task-item').count(), 0, 'Earlier calls do not absorb later work');
  await page.screenshot({ path: '/private/tmp/xiaowang-research-complete.png' });
  assert.deepEqual(errors, []);
  console.log('Verified analysis acceptance, visible progress, no duplicate jobs after interruption/status, native result return during preface, actual PDF reading, saved notes, spoken result, source display receipt and baseline text progress.');
});
