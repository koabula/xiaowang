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
async function until(check, message = 'MOSS workflow timed out', timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(25); }
  throw new Error(message);
}
function pdf() {
  const content = 'BT /F1 20 Tf 72 720 Td (Research Methods) Tj 0 -40 Td /F1 12 Tf (Evidence: MOSS-RESEARCH-42. Compare methods using original sources.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result); result += 'xref\n0 6\n0000000000 65535 f \n'; offsets.slice(1).forEach(offset => { result += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(`${result}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function tone(ms) { const pcm = Buffer.alloc(ms * 48); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 8000), i * 2); return pcm; }

test('desktop: MOSS native audio, interruption, tools, durable delegation, spoken result and saved call', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-moss-')); const home = path.join(root, 'home'); const profile = path.join(root, 'profile'); await mkdir(profile);
  const seed = Runtime.open(home); const ref = seed.store.addLibraryBytes(seed.activeBot().id, 'research-methods.pdf', pdf()).ref; seed.close();
  const gate = deferred(), cancelGate = deferred(), lateGate = deferred(); let read = false, cancelStarted = false, lateStarted = false, requests = 0;
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); requests++;
    const user = input.messages.findLast(message => message.role === 'user');
    const cancelled = (user?.content || '').lastIndexOf('取消测试') > (user?.content || '').lastIndexOf('延后测试');
    const late = /延后测试/.test(user?.content || '');
    const hasRead = input.messages.some(message => message.role === 'tool' && message.content.includes('MOSS-RESEARCH-42'));
    const hasWritten = input.messages.some(message => message.role === 'tool' && message.content.includes('notes/research.md'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
    if (cancelled) { cancelStarted = true; await cancelGate.promise; chunk({ content: '不应回传的旧结果' }, 'stop'); }
    else if (late) { lateStarted = true; await lateGate.promise; chunk({ content: '挂断后的后台结果仍保存在原通话中。' }, 'stop'); }
    else if (!hasRead) { chunk({ content: '正在读取原文，核对研究方法。' }); chunk({ tool_calls: [{ index: 0, id: 'read', function: { name: 'read_document', arguments: JSON.stringify({ file: `${ref.id} ${ref.filename}` }) } }] }, 'tool_calls'); }
    else if (!hasWritten) { read = true; await gate.promise; chunk({ tool_calls: [{ index: 0, id: 'write', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/research.md', content: '# 研究笔记\n\n依据原文 MOSS-RESEARCH-42：比较研究方法时应保留证据与来源。' }) } }] }, 'tool_calls'); }
    else chunk({ content: `论文梳理已完成：依据原文 MOSS-RESEARCH-42，比较方法时需要核对原始证据。笔记已保存。[原文，第1页](xwref://${ref.id}?page=1)` }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const voice = '6c3152b1-1d4f-4e49-ade3-09f447712fec';
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'local', realtimeService: 'moss', realtimeVoice: voice, realtimeKey: 'local', locale: 'zh' }));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise(resolve => server.once('listening', resolve));
  let socket, mic = 0, connections = 0; const events = [], output = [], continuations = [], notices = [], configurations = [];
  const emit = (action, data = {}) => socket.send(JSON.stringify({ action, data }));
  const speak = (id, content, ms = 450) => {
    const ids = { run_id: id, turn_id: `turn-${id}` };
    emit('response.audio.started', ids); emit('output.transcript.updated', { ...ids, text: content });
    emit('response.audio.context', { ...ids, chunk_id: '1' }); socket.send(tone(ms)); emit('response.audio.done', ids);
    return ids;
  };
  server.on('connection', (connection, request) => {
    assert.equal(request.headers.authorization, 'Bearer local'); assert.equal(new URL(request.url, 'http://local').searchParams.get('model'), 'moss-live-1.0');
    socket = connection; connections++;
    connection.on('message', (raw, binary) => {
      if (binary) { mic++; assert.equal(raw.length % 2, 0); return; }
      const event = JSON.parse(raw.toString()); events.push(event);
      if (event.action === 'attach_session') { assert.equal(event.memory_scope, 'session'); assert.equal(event.delegation.type, 'client'); emit('session_attached', { session_id: 'moss-session', memory_scope: 'session', delegation: 'client' }); }
      if (event.action === 'session.update') { configurations.push(event.session); emit('session.updated', { error: '' }); }
      if (event.action === 'change_voice') emit('voice_changed', { name: event.voice_name });
      if (event.action === 'media.configure') emit('media.configured', { ...event, error: '', input_audio: { format: 'pcm16', sample_rate: 16000 }, output_audio: { format: 'pcm16', sample_rate: 24000 } });
      if (event.action === 'conversation.item.create') { output.push(event.item); emit('conversation.item.created', { item: { type: 'function_call_output', call_id: event.item.call_id } }); }
      if (event.action === 'response.create') continuations.push(event.response.call_ids);
      if (event.action === 'session.thinking.append') emit('session.thinking.appended', { client_event_id: event.event_id });
      if (event.action === 'session.commentary.append') {
        notices.push(event); emit('session.commentary.appended', { client_event_id: event.event_id }); speak(`result-${notices.length}`, '论文梳理已完成。我核对了原始证据，研究笔记也已保存，你可以打开查看。');
      }
      if (event.action === 'playback.completed') {
        const ids = { run_id: event.run_id, turn_id: event.turn_id };
        emit('output.transcript.done', { ...ids, text: event.run_id.startsWith('result-') ? '论文梳理已完成。我核对了原始证据，研究笔记也已保存，你可以打开查看。' : '我在，随时可以继续交流。' }); emit('response.ended', { ...ids, status: 'completed' });
      }
    });
  });
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_REALTIME_URL: `ws://127.0.0.1:${server.address().port}/realtime`, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  const app = process.env.XIAOWANG_E2E_EXECUTABLE ? await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, args, env) : await electron.launch({ args: [...args, 'desktop/dist/main.js'], env });
  t.after(async () => { gate.resolve(); cancelGate.resolve(); lateGate.resolve(); await closeTestApp(app); for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.meters = []; const create = AudioContext.prototype.createAnalyser; AudioContext.prototype.createAnalyser = function(...args) { const meter = create.apply(this, args); window.meters.push(meter); return meter; }; });
  await page.reload(); await page.waitForSelector('.composer');
  const state = () => page.evaluate(() => window.xiaowang.getState());
  const energy = () => page.evaluate(() => { const meter = window.meters.at(-1); if (!meter) return 0; const data = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length); });
  await page.evaluate(() => window.xiaowang.callStart('xiaowang')); await until(() => mic > 0, 'Microphone did not reach native binary transport');
  assert.ok(!configurations[0].tools.some(tool => ['delegate_task', 'ask_text'].includes(tool.name)));
  emit('input.transcript.updated', { text: '你' }); emit('input.transcript.done', { text: '你好', turn: 'hello' });
  const long = speak('old', '我在，随时可以交流。', 2200); const start = Date.now();
  await until(async () => await energy() > .05, 'PCM never reached the renderer speaker');
  assert.equal(events.filter(event => event.action === 'playback.completed' && event.run_id === 'old').length, 0);
  const micBefore = mic; await sleep(100); assert.ok(mic > micBefore, 'Duplex microphone must continue during playback');
  emit('input.speech.started'); await sleep(60); assert.ok(await energy() > .05, 'Speech-start is not a MOSS stop decision');
  emit('response.audio.stop', long); emit('response.interrupted', long);
  const stop = await until(() => events.find(event => event.action === 'playback.stopped' && event.run_id === 'old'));
  assert.ok(stop.played_audio_ms > 0 && stop.played_audio_ms < 2200);
  await until(async () => await energy() < .001, 'Old audio continued after stop');
  emit('response.audio.context', { ...long, chunk_id: 'late' }); socket.send(tone(500)); await sleep(70); assert.ok(await energy() < .001, 'Late old audio must remain rejected');
  speak('new', '我在，随时可以继续交流。'); await until(async () => await energy() > .05);
  await until(() => events.some(event => event.action === 'playback.completed' && event.run_id === 'new'));
  // The second chunk's partial receipt must exclude the first completed chunk.
  const pair = { run_id: 'paired', turn_id: 'paired-turn' };
  emit('response.audio.started', pair);
  emit('response.audio.context', { ...pair, chunk_id: 'one' }); socket.send(tone(300));
  emit('response.audio.context', { ...pair, chunk_id: 'two' }); socket.send(tone(1800)); emit('response.audio.done', pair);
  await until(() => events.some(event => event.action === 'playback.chunk.completed' && event.run_id === 'paired' && event.chunk_id === 'one'));
  await sleep(80); emit('response.audio.stop', pair);
  const partial = await until(() => events.find(event => event.action === 'playback.stopped' && event.run_id === 'paired'));
  assert.ok(partial.played_audio_ms > 0 && partial.played_audio_ms < 300, 'Stop duration must be relative to the unfinished chunk');
  assert.equal(events.filter(event => event.action === 'playback.chunk.completed' && event.run_id === 'paired' && event.chunk_id === 'two').length, 0, 'Stopping a node must not acknowledge full playback');
  assert.equal((await state()).jobs.length, 0, 'Ordinary conversation must not create a job');
  assert.ok(Date.now() - start < 2200, 'Interrupt should finish before original playback');
  const user = { text: '帮我分析这篇论文，保留来源，并整理研究笔记。', turn: 'research' };
  emit('input.transcript.updated', { text: '帮我分析这篇论文' }); emit('input.transcript.done', user);
  emit('input.transcript.revised', { ...user, previous: user.text, text: '帮我分析这篇论文，核对原始证据，并整理研究笔记。' });
  assert.equal((await state()).jobs.length, 0, 'Transcript heuristics must not race native delegation');
  const task = { delegation: { id: 'research', target: 'client', type: 'delegation' }, objective: user.text, context: [{ role: 'user', content: user.text }], purpose: 'task', owner_turn_id: 'owner-opaque' };
  emit('session.delegation.created', task); emit('session.delegation.created', task);
  await until(() => read, 'Background LLM did not read actual source evidence');
  await page.locator('.voice-panel .task-item.running').waitFor(); assert.equal((await state()).jobs.length, 1);
  assert.equal(await page.locator('.messages .task-item').count(), 0); assert.equal(await page.locator('.bubble.assistant').count(), 0);
  emit('response.function_call_arguments.done', { call_id: 'status', name: 'get_task', arguments: '{}' });
  await until(() => continuations.some(ids => ids.includes('status'))); assert.equal(JSON.parse(output.find(item => item.call_id === 'status').output).status, 'running');
  emit('response.function_call_arguments.done', { call_id: 'open', name: 'show_stage', arguments: JSON.stringify({ mode: 'file', file: `${ref.id} ${ref.filename}`, page: 1 }) });
  await until(() => continuations.some(ids => ids.includes('open')), 'Foreground viewer tool never resumed after its receipt');
  assert.match(output.find(item => item.call_id === 'open').output, /右栏已显示/);
  await page.waitForFunction(() => document.querySelector('.pdf-scroll canvas')?.width > 0);
  // Resume the same remote session while real research is still running.
  socket.close(); await until(() => connections === 2); await until(() => events.filter(event => event.action === 'mic_state').length >= 2);
  emit('session.delegation.created', task); assert.equal((await state()).jobs.length, 1);
  const afterReconnect = mic; await sleep(100); assert.ok(mic > afterReconnect, 'Capture must survive reconnection');
  gate.resolve(); await until(() => notices.length === 1, 'Completed research was not returned for speech');
  assert.match(notices[0].content, /MOSS-RESEARCH-42/); assert.match(notices[0].content, /notes\/research.md/); assert.equal(notices[0].status, 'completed');
  await until(async () => await energy() > .05, 'Result text did not produce actual renderer audio');
  await until(() => events.some(event => event.action === 'playback.completed' && event.run_id === 'result-1'));
  assert.equal((await state()).jobs[0].status, 'succeeded'); assert.equal(await page.locator('.bubble.assistant').count(), 0);
  assert.ok(requests >= 3); assert.equal(notices.length, 1);
  if (process.env.XIAOWANG_DOC_SCREENSHOT) {
    await page.locator('.voice-panel .task-item.succeeded').waitFor();
    await page.screenshot({ path: process.env.XIAOWANG_DOC_SCREENSHOT });
  }
  emit('session.delegation.created', { ...task, delegation: { id: 'cancel' }, objective: '取消测试' }); await until(() => cancelStarted);
  emit('session.delegation.cancelled', { delegation_id: 'cancel' }); await until(async () => (await state()).jobs.some(job => job.status === 'cancelled'));
  cancelGate.resolve(); await sleep(100); assert.equal(notices.length, 1, 'Cancelled executor must not return a stale result');
  emit('session.delegation.created', { ...task, delegation: { id: 'late' }, objective: '延后测试' }); await until(() => lateStarted);
  await page.evaluate(() => window.xiaowang.callStop()); await page.locator('.call-card').first().waitFor();
  lateGate.resolve(); await until(async () => (await state()).jobs.find(job => job.title === '延后测试')?.status === 'succeeded');
  assert.equal(notices.length, 1, 'Hangup must keep results locally without speaking to a dead session');
  assert.equal(await page.locator('.messages > .task-item').count(), 0);
  const items = await page.evaluate(() => window.xiaowang.events('xiaowang'));
  const saved = items.find(item => item.kind === 'call'); assert.ok(saved); assert.equal(saved.lines.filter(line => line.who === 'user' && /核对原始证据/.test(line.text)).length, 1);
  assert.equal(saved.lines.some(line => line.who === 'user' && line.text === user.text), false, 'Saved transcript must retain ASR revision');
  assert.equal(await page.locator('.bubble.assistant').count(), 0, 'Background results must not duplicate as chat answers');
  await page.locator('.call-card > button').first().click();
  await page.locator('.call-card .task-item.succeeded').first().waitFor();
  await page.locator('.call-task-result summary').first().click();
  await page.locator('.call-task-result').getByText('论文梳理已完成：', { exact: false }).waitFor();
  await page.locator('button.settings').click();
  const settings = page.getByRole('form', { name: '设置', exact: true }); await settings.waitFor();
  assert.match(await settings.getByRole('combobox', { name: '服务', exact: true }).innerText(), /MOSS Live/);
  assert.match(await settings.getByRole('combobox', { name: '音色', exact: true }).innerText(), /暖暖/);
  await page.keyboard.press('Escape'); await settings.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});
