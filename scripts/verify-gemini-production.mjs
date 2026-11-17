/** Opt-in real Gemini acceptance through the actual Electron main/renderer.
 * A local relay injects the real key in memory, drops the socket deliberately,
 * and filters synthetic-microphone silence during injected test speech.
 * The background LLM is a controlled local fixture that reads/writes real files.
 * No private user data, microphone, credentials, remote handles or audio is saved.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { Runtime } from '../src/runtime.ts';
import { electron, launchPackaged, closeTestApp } from '../e2e/launch.mjs';

const key = process.env.GEMINI_API_KEY; assert.ok(key, 'GEMINI_API_KEY is required');
const root = await mkdtemp(path.join(os.tmpdir(), 'xw-gemini-acceptance-'));
const home = path.join(root, 'home'), profile = path.join(root, 'profile'); await mkdir(profile);
const reportPath = process.env.GEMINI_TEST_REPORT || path.join(os.tmpdir(), 'xiaowang-gemini-production-verification.json');
const report = { checkedAt: new Date().toISOString(), model: 'gemini-3.8-live', status: 'running', stage: 'setup', checks: [], background: 'controlled local LLM with actual file tools' };
const walkthroughOnly = process.env.GEMINI_CHECK_WALKTHROUGH_ONLY === '1';
const diagnostic = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, peer, upstream, handles = new Set(), connections = 0, resumed = 0, turns = 0, bytes = 0, interruptions = 0, output = '', input = '', lastPacket = Date.now();
let failure = '', shutdown = false, dropSilence = false, currentCallId, job;
const toolNames = [], stagePages = [], livePhases = [], states = [];
let releaseWork; const workGate = new Promise(resolve => { releaseWork = resolve; });
const silence = Buffer.alloc(44 + 16000 * 2 * 30);
silence.write('RIFF'); silence.writeUInt32LE(silence.length - 8, 4); silence.write('WAVEfmt ', 8); silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22); silence.writeUInt32LE(16000, 24); silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write('data', 36); silence.writeUInt32LE(silence.length - 44, 40);
await writeFile(path.join(root, 'silence.wav'), silence);
const checked = label => { report.checks.push(label); console.log(label); };
function hasCheckValue(value) {
  const digits = { 零: '0', 〇: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
  return value.replace(/[零〇一二两三四五六七八九]/g, char => digits[char]).replace(/[\s,，]/g, '').includes('333833500') || value.includes('三亿三千三百八十三万三千五百');
}
async function until(check, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (failure) throw Error(failure); const value = await check(); if (value) return value; await sleep(40); }
  throw Error(label);
}
const seed = Runtime.open(home), bot = seed.activeBot();
await writeFile(path.join(bot.workspaceDir, 'source.md'), '# Fixture\nThe independently verified result is 333833500.');
await writeFile(path.join(bot.workspaceDir, 'lesson.html'), '<!doctype html><meta charset="utf-8"><style>section{padding:40px;font:28px sans-serif}</style><section data-xw-slide="1" class="active">第一页：水在标准大气压下，沸点约为一百摄氏度。</section><section data-xw-slide="2">第二页：地球绕太阳公转，周期约为一年。</section><section data-xw-slide="3">第三页：月球是地球的天然卫星。三页结束，请调用 manage_presentation complete。</section>');
seed.close();
const model = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), own = body.messages.slice(body.messages.findLastIndex(item => item.role === 'user') + 1);
    const read = own.some(item => item.role === 'tool' && item.content.includes('333833500'));
    const written = own.some(item => item.role === 'tool' && item.content.includes('notes/gemini-check.md'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = 'stop') => res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`);
    if (!read) { await workGate; send({ tool_calls: [{ index: 0, id: 'read-source', function: { name: 'read_file', arguments: JSON.stringify({ path: 'source.md' }) } }] }, 'tool_calls'); }
    else if (!written) send({ tool_calls: [{ index: 0, id: 'write-note', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/gemini-check.md', content: '核验结果 333833500，已读取 source.md 并完成记录。' }) } }] }, 'tool_calls');
    else send({ content: '核验完成，结果为 333833500，已保存到 notes/gemini-check.md。' });
  } catch { if (!shutdown) failure = 'Controlled background fixture failed'; res.end(); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(resolve => relay.once('listening', resolve));
relay.on('connection', socket => {
  peer = socket; connections++;
  const remote = new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', { headers: { 'x-goog-api-key': key } }); upstream = remote;
  const pending = [];
  remote.on('open', () => { for (const raw of pending) remote.send(raw); });
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    if (value.setup?.sessionResumption?.handle) {
      if (!handles.has(value.setup.sessionResumption.handle)) failure = 'Reconnect did not use the real issued handle'; else resumed++;
    }
    if (value.realtimeInput?.audio) {
      const pcm = Buffer.from(value.realtimeInput.audio.data, 'base64');
      if (dropSilence && !pcm.some(byte => byte !== 0)) return;
    }
    if (remote.readyState === WebSocket.OPEN) remote.send(raw.toString()); else pending.push(raw.toString());
  });
  remote.on('message', raw => {
    const message = JSON.parse(raw.toString()); lastPacket = Date.now();
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) handles.add(message.sessionResumptionUpdate.newHandle);
    if (message.error) failure = `Gemini error: ${String(message.error.message).replaceAll(key, '[redacted]')}`;
    const content = message.serverContent || {};
    if (content.turnComplete) turns++;
    if (content.interrupted) interruptions++;
    if (content.inputTranscription?.text) input += content.inputTranscription.text;
    if (content.outputTranscription?.text) output += content.outputTranscription.text;
    for (const part of content.modelTurn?.parts || []) if (part.inlineData?.data) bytes += Buffer.from(part.inlineData.data, 'base64').length;
    for (const call of message.toolCall?.functionCalls || []) { toolNames.push(call.name); if (call.name === 'show_stage') stagePages.push({ page: call.args?.page, at: Date.now() }); }
    if (socket.readyState === WebSocket.OPEN) socket.send(raw.toString());
  });
  remote.on('close', (code, reason) => { if (socket.readyState === WebSocket.OPEN) socket.close(code === 1006 ? 1011 : code, reason.toString().slice(0, 100)); });
  remote.on('error', () => { if (!shutdown && socket.readyState === WebSocket.OPEN) socket.close(1011, 'Upstream network error'); });
  socket.on('close', () => remote.terminate());
});
const run = promisify(execFile);
async function voice(sentence, name) {
  const aiff = path.join(root, `${name}.aiff`), wav = path.join(root, `${name}.wav`);
  await run('/usr/bin/say', ['-v', 'Tingting', '-r', '185', '-o', aiff, sentence]);
  await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const value = await readFile(wav);
  for (let offset = 12; offset + 8 < value.length;) { const size = value.readUInt32LE(offset + 4); if (value.toString('ascii', offset, offset + 4) === 'data') return value.subarray(offset + 8, offset + 8 + size); offset += 8 + size + size % 2; }
  throw Error('Synthetic WAV has no audio');
}
async function feed(pcm) {
  dropSilence = true;
  for (let offset = 0; offset < pcm.length; offset += 1280) { await page.evaluate(audio => window.xiaowang.callAudio(audio), pcm.subarray(offset, offset + 1280).toString('base64')); await sleep(40); }
  upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  await sleep(100); dropSilence = false;
}
async function drained() { await until(async () => Date.now() - lastPacket > 500 && await page.evaluate(() => window.geminiCheck?.sources === 0), 'Real speaker did not drain'); }
const env = { ...process.env, XIAOWANG_GEMINI_DIAGNOSTICS: '1', XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1', XIAOWANG_ENABLE_GEMINI: '1', XIAOWANG_REALTIME_URL: `ws://127.0.0.1:${relay.address().port}` };
for (const name of Object.keys(env)) if (/GEMINI_API_KEY|GOOGLE_API_KEY|MOSS_API_KEY|ELECTRON_RUN_AS_NODE/.test(name)) delete env[name];
const args = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(root, 'silence.wav')}`, '--autoplay-policy=no-user-gesture-required'];
const launch = () => process.env.XIAOWANG_E2E_EXECUTABLE
  ? launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, args, env)
  : electron.launch({ args: [...args, 'desktop/dist/main.js'], env });
try { acceptance: {
  const [remember, recall, task, question, walkthrough] = await Promise.all([
    voice('你好，请记住本次通话的暗号是红色苹果。只回答记住了。', 'remember'),
    voice('刚才约定的暗号是什么？', 'recall'),
    voice('请让后台助手分析 source.md，把核验结果写到 notes/gemini-check.md，完成后请读出核验数字。', 'task'),
    voice('后台继续工作。你先回答二加二等于几。', 'question'),
    voice('工作区有 lesson.html，请完整逐页讲解三页，每页只讲一句话。每页讲完等待播放完成再翻页，不要等我说继续。最后结束讲解，不要挂断。', 'walkthrough'),
  ]);
  app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForSelector('.composer');
  let stderr = ''; app.process().stderr.on('data', chunk => { stderr += chunk; let end; while ((end = stderr.indexOf('\n')) >= 0) { const line = stderr.slice(0, end); stderr = stderr.slice(end + 1); if (line.startsWith('XW_GEMINI_STATE ')) { try { diagnostic.push(JSON.parse(line.slice('XW_GEMINI_STATE '.length))); if (diagnostic.length > 50) diagnostic.shift(); } catch {} } } });
  await page.evaluate(() => {
    window.geminiCheck = { sources: 0, started: 0, peak: 0, micStarts: 0 };
    const original = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (...args) { const source = original.apply(this, args), start = source.start.bind(source); source.start = (...args) => { window.geminiCheck.sources++; window.geminiCheck.started++; source.addEventListener('ended', () => window.geminiCheck.sources--, { once: true }); return start(...args); }; return source; };
    const analyser = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (values) { analyser.call(this, values); window.geminiCheck.peak = Math.max(window.geminiCheck.peak, Math.sqrt(values.reduce((sum, n) => sum + n * n, 0) / values.length)); };
    const mic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (...args) => { window.geminiCheck.micStarts++; return mic(...args); };
    window.geminiCallNotes = []; window.xiaowang.onCall(note => { if (note.phase !== 'audio' && note.phase !== 'line') window.geminiCallNotes.push(note); });
    window.geminiStages = []; window.xiaowang.onStage(note => { window.geminiStages.push({ mode: note.mode, page: note.page, sources: window.geminiCheck.sources }); });
  });
  await page.evaluate(baseUrl => window.xiaowang.saveSettings({ baseUrl, model: 'fixture', apiKey: 'local', realtimeService: 'gemini', realtimeKey: 'relay-local-key', realtimeModel: 'gemini-3.8-live', realtimeVoice: 'Kore' }), `http://127.0.0.1:${model.address().port}/v1`);
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).settings.realtimeService, 'gemini');
  if (process.env.GEMINI_CHECK_VISION_ONLY === '1') {
    releaseWork(); report.stage = 'visual input';
    const image = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 450;
      const c = canvas.getContext('2d'); c.fillStyle = '#ffffff'; c.fillRect(0, 0, 1000, 450);
      c.fillStyle = '#143e99'; c.font = 'bold 96px sans-serif'; c.fillText('RAVEN 5873', 100, 240);
      const bytes = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer());
      return window.xiaowang.attach('xiaowang', 'picture.png', bytes);
    });
    await page.evaluate(id => window.xiaowang.ask('xiaowang', '请保存这张图片，等我在通话中提问。', [id]), image.refId);
    await page.evaluate(() => window.xiaowang.callStart('xiaowang'));
    await until(async () => (await page.evaluate(() => window.geminiCallNotes)).some(n => n.phase === 'visual' && n.visual?.phase === 'shared'), 'Image not shared');
    await sleep(1800); assert.equal(output, '', 'Passive image/context must not trigger speech'); checked('Image and context updates remain silent');
    await feed(await voice('请直接读出我刚发的图片里的英文单词和四位数字，不要调用后台助手。', 'vision-image'));
    await until(() => /raven/i.test(output) && /5873/.test(output.replace(/\s/g, '')), `Gemini did not read actual image: ${output}`);
    await drained(); checked('Gemini reads actual sent image pixels');
    const pdf = (() => {
      const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], kids = [];
      for (const label of ['FALCON 2468', 'OTTER 9137']) { const id = objects.length + 1; kids.push(`${id} 0 R`); const content = `0.08 0.2 0.7 rg BT /F1 56 Tf 60 400 Td (${label}) Tj ET`; objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`); }
      objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 2 >>`;
      let data = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((o, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${o}\nendobj\n`; });
      const xref = Buffer.byteLength(data); data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`; offsets.slice(1).forEach(o => data += `${String(o).padStart(10, '0')} 00000 n \n`);
      return Buffer.from(data + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    })();
    const doc = await page.evaluate(bytes => window.xiaowang.attach('xiaowang', 'pages.pdf', new Uint8Array(bytes)), [...pdf]);
    for (const [index, expected] of [[1, /falcon/i], [2, /otter/i]]) {
      const mark = output.length, notes = (await page.evaluate(() => window.geminiCallNotes)).length;
      await page.evaluate(({ id, index }) => window.xiaowang.openReference('xiaowang', id, index), { id: doc.refId, index });
      await until(async () => (await page.evaluate(() => window.geminiCallNotes)).slice(notes).some(n => n.phase === 'visual' && n.visual?.phase === 'shared' && n.visual.source === 'pages.pdf' && n.visual.page === index), 'PDF page frame missing');
      await sleep(1800); assert.equal(output.length, mark, 'Page changes cannot trigger unsolicited speech');
      await feed(await voice('请只读出当前打开的PDF页面上最大的英文单词和四位数字。直接看画面，不要调用工具，也不要读之前图片。', `vision-page-${index}`));
      await until(() => expected.test(output.slice(mark)), `Gemini did not read PDF page ${index}`); await drained();
      checked(`Gemini reads actual PDF page ${index}, page navigation remains silent`);
    }
    const before = connections, notesBefore = (await page.evaluate(() => window.geminiCallNotes)).length; peer.terminate(); upstream.terminate(); await until(async () => connections > before && resumed > 0 && (await page.evaluate(() => window.geminiCallNotes)).slice(notesBefore).some(note => note.phase === 'state' && note.state.detail.includes('已恢复连接')), 'Visual call resumption failed');
    await sleep(2000); const mark = output.length;
    await feed(await voice('重连后，请再读一次当前PDF页上的英文单词和数字。不要调用工具。', 'vision-reconnect'));
    await until(() => /otter/i.test(output.slice(mark)), 'Current page lost after reconnect'); await drained(); checked('Reconnect restores current visual context');
    await page.evaluate(() => window.xiaowang.callStop());
    const records = await page.evaluate(() => window.xiaowang.events('xiaowang'));
    assert.ok(records.some(item => item.kind === 'call' && item.lines?.some(line => /otter/i.test(line.text))));
    checked('Visual questions and answers persist in the call transcript'); report.status = 'passed'; report.stage = 'complete'; break acceptance;
  }
  if (process.env.GEMINI_CHECK_HANGUP_ONLY === '1') {
    for (const [index, sentence] of ['现在要把它挂了。', '没有，你可以挂了。'].entries()) {
      const before = (await page.evaluate(() => window.geminiCallNotes)).length;
      await page.evaluate(() => window.xiaowang.callStart('xiaowang'));
      await until(async () => (await page.evaluate(() => window.geminiCallNotes)).slice(before).some(note => note.phase === 'live'), 'Live setup failed');
      report.stage = `natural hangup ${index + 1}`;
      await feed(await voice(sentence, `hangup-${index}`));
      await until(async () => (await page.evaluate(() => window.geminiCallNotes)).slice(before).some(note => note.phase === 'closed'), 'Natural hangup did not close the actual call', 30000);
      await until(async () => await page.evaluate(() => window.geminiCheck.sources === 0), 'Goodbye audio kept playing');
      assert.equal((await page.evaluate(() => window.xiaowang.getState())).call, null);
      const liveCount = (await page.evaluate(() => window.geminiCallNotes)).slice(before).filter(note => note.phase === 'live').length;
      assert.equal(liveCount, 1); await sleep(1200);
      assert.equal((await page.evaluate(() => window.xiaowang.getState())).call, null, 'Ended call reconnected');
      checked(`Real spoken request '${sentence}' closed the call and stopped playback without reconnecting`);
    }
    const records = (await page.evaluate(() => window.xiaowang.events('xiaowang'))).filter(item => item.kind === 'call');
    assert.equal(records.length, 2); assert.ok(toolNames.filter(name => name === 'end_call').length >= 2);
    report.status = 'passed'; report.stage = 'natural hangup complete'; report.connections = connections; report.audioBytes = bytes;
    break acceptance;
  }
  if (process.env.GEMINI_CHECK_PREVIEW_ONLY === '1') {
    await page.locator('button.settings').click();
    const form = page.getByRole('form', { name: '设置', exact: true });
    for (const voice of ['Kore', 'Sulafat']) {
      await form.getByRole('combobox', { name: '音色', exact: true }).click(); await page.getByRole('option', { name: voice, exact: true }).click();
      const before = await page.evaluate(() => window.geminiCheck.started), notesBefore = (await page.evaluate(() => window.geminiCallNotes)).length;
      await form.getByRole('button', { name: '试听', exact: true }).click();
      const closed = await until(async () => (await page.evaluate(() => window.geminiCallNotes)).slice(notesBefore).find(note => note.preview && note.phase === 'closed'), 'Preview did not complete');
      assert.equal(closed.detail, ''); assert.ok(await page.evaluate(before => window.geminiCheck.started > before && window.geminiCheck.sources === 0, before));
      checked(`Actual settings preview for ${voice} played and drained before closing`);
    }
    assert.equal(await page.evaluate(() => window.geminiCheck.micStarts), 0);
    assert.equal((await page.evaluate(() => window.xiaowang.events('xiaowang'))).filter(item => item.kind === 'call').length, 0);
    await form.getByRole('button', { name: '保存并进入', exact: true }).click();
    assert.equal((await page.evaluate(() => window.xiaowang.getState())).settings.realtimeVoice, 'Sulafat');
    report.status = 'partial'; report.stage = 'preview complete'; break acceptance;
  }
  await page.evaluate(() => window.xiaowang.callStart('xiaowang'));
  await until(async () => (await page.evaluate(() => window.geminiCallNotes)).some(note => note.phase === 'live'), 'Live setup failed');
  currentCallId = (await page.evaluate(() => window.geminiCallNotes)).find(note => note.phase === 'live').callId;
  if (!walkthroughOnly) {
  report.stage = 'real speech'; await feed(remember); await until(() => /记住/.test(output), 'No real audio response'); await drained();
  assert.ok(await page.evaluate(() => window.geminiCheck.peak > .005)); checked('Real speech recognized and played through the full production call');
  report.stage = 'resume'; await until(() => handles.size > 0, 'No real session resumption handle');
  const oldConnections = connections; peer.terminate(); upstream.terminate();
  await until(async () => connections > oldConnections && (await page.evaluate(() => window.geminiCallNotes)).some(note => note.phase === 'state' && note.state.detail.includes('已恢复连接')), 'Original session did not recover');
  assert.ok(resumed > 0); const mark = output.length; await feed(recall);
  await until(() => /红色苹果/.test(output.slice(mark)), 'Restored model lost the agreed secret'); await drained();
  assert.equal(await page.evaluate(() => window.geminiCheck.micStarts), 1); checked('Forced disconnection resumed the real remote memory without restarting microphone capture');
  report.stage = 'background task'; await feed(task);
  job = await until(async () => (await page.evaluate(() => window.xiaowang.getState())).jobs.find(job => job.channel === 'voice'), 'No durable voice job');
  await page.locator(`.voice-panel [data-job-id="${job.id}"]`).waitFor();
  const before = output.length; await feed(question); await until(() => /四|4/.test(output.slice(before)), 'Foreground conversation blocked by background work');
  assert.notEqual((await page.evaluate(() => window.xiaowang.getState())).jobs.find(item => item.id === job.id).status, 'succeeded');
  releaseWork(); await until(async () => (await page.evaluate(() => window.xiaowang.getState())).jobs.find(item => item.id === job.id)?.status === 'succeeded', 'Actual backend work failed');
  await until(() => hasCheckValue(output), 'Background answer omitted the requested actual check value'); await drained();
  assert.match(await readFile(path.join(bot.workspaceDir, 'notes/gemini-check.md'), 'utf8'), /333833500/); checked('Production delegation stayed responsive and read/wrote real files before speaking its result');
  }
  report.stage = 'continuous presentation'; await feed(walkthrough);
  await until(async () => { const call = (await page.evaluate(() => window.xiaowang.getState())).call; return call?.state?.presentation.status === 'active' && call.state.presentation.page === 1 && await page.evaluate(() => window.geminiCheck.sources > 0); }, 'First page speech did not start');
  await page.evaluate(() => window.xiaowang.callControl('pause'));
  await until(async () => await page.evaluate(() => window.geminiCheck.sources === 0), 'Pause did not stop actual playback');
  const pausedSources = await page.evaluate(() => window.geminiCheck.started); await sleep(900);
  assert.equal(await page.evaluate(() => window.geminiCheck.started), pausedSources, 'Speech restarted while paused');
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).call.state.presentation.status, 'paused');
  await page.evaluate(() => window.xiaowang.callControl('resume'));
  await until(async () => (await page.evaluate(() => window.xiaowang.getState())).call?.state?.presentation.status === 'completed', 'Three-page presentation did not complete automatically', 90000);
  await drained();
  const presented = (await page.evaluate(() => window.xiaowang.getState())).call.state.presentation;
  assert.equal(presented.page, 3); assert.ok(toolNames.includes('show_stage'));
  const transitions = (await page.evaluate(() => window.geminiStages)).filter(note => note.mode === 'canvas');
  assert.ok([1, 2, 3].every(page => transitions.some(note => note.page === page)), 'Every page must actually be shown');
  assert.ok(transitions.filter(note => note.page > 1).every(note => note.sources === 0), 'A page changed while preceding audio was still playing');
  const finalPlayback = await page.evaluate(() => window.geminiCheck.started); await sleep(1800); assert.equal(await page.evaluate(() => window.geminiCheck.started), finalPlayback, 'Presentation kept playing audio after completion'); checked('Three-page Canvas playback paused in silence, resumed, advanced only after playback, and stopped at completion without a continuation tool');
  report.stage = 'saved call'; await page.evaluate(() => window.xiaowang.callStop());
  let events = await page.evaluate(() => window.xiaowang.events('xiaowang'));
  const calls = events.filter(item => item.kind === 'call'); assert.equal(calls.length, 1); assert.equal(calls[0].callId, currentCallId);
  if (!walkthroughOnly) assert.match(JSON.stringify(calls[0].lines), /红色苹果/);
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).jobs.filter(item => item.channel === 'voice').length, job ? 1 : 0);
  await closeTestApp(app); app = null;
  app = await launch(); page = await app.firstWindow(); await page.waitForSelector('.composer');
  events = await page.evaluate(() => window.xiaowang.events('xiaowang'));
  assert.equal(events.filter(item => item.kind === 'call').length, 1); if (!walkthroughOnly) assert.match(JSON.stringify(events.find(item => item.kind === 'call').lines), /红色苹果/);
  await page.locator(`[data-call-id="${currentCallId}"] > button`).click();
  if (job) await page.locator(`[data-call-id="${currentCallId}"] [data-job-id="${job.id}"]`).waitFor();
  assert.equal(await page.locator('.conversation-entry > .task-item').count(), 0); checked('One call record and its owned job/result survived a full application restart without chat duplication');
  report.status = walkthroughOnly ? 'partial' : 'passed'; report.stage = 'complete'; report.connections = connections; report.resumptions = resumed; report.audioBytes = bytes; report.nativeInterruptions = interruptions; report.tools = [...new Set(toolNames)];
} } catch (error) {
  report.status = 'failed'; report.error = String(error.message).replaceAll(key, '[redacted]'); console.error(`Acceptance failed at ${report.stage}: ${report.error}`); process.exitCode = 1;
  report.syntheticTranscript = { input, output }; report.connections = connections; report.resumptions = resumed; report.tools = toolNames;
  report.diagnostic = diagnostic; report.closed = page ? await page.evaluate(() => (window.geminiCallNotes || []).filter(note => note.phase === 'closed')).catch(() => []) : [];
} finally {
  shutdown = true; releaseWork(); if (app) await closeTestApp(app);
  for (const client of relay.clients) client.terminate(); upstream?.terminate();
  await new Promise(resolve => relay.close(resolve)); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await writeFile(reportPath, JSON.stringify(report, null, 2)); await rm(root, { recursive: true, force: true, maxRetries: 10 }); console.log(`Acceptance report: ${reportPath}`);
}
