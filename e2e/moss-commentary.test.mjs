import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { WebSocketServer } from 'ws';
import { closeTestApp } from './launch.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, message) { const deadline = Date.now() + 12000; while (Date.now() < deadline) { if (await check()) return; await sleep(25); } throw Error(message); }
function tone(ms) { const pcm = Buffer.alloc(ms * 48); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 9) * 8000), i * 2); return pcm; }

test('desktop: real MOSS commentary format previews, drains all anonymous chunks, interrupts and keeps conversation usable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-moss-commentary-')), profile = path.join(root, 'profile'); await mkdir(profile);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local', realtimeService: 'moss', realtimeKey: 'local', realtimeVoice: '6c3152b1-1d4f-4e49-ade3-09f447712fec', locale: 'zh' }));
  const catalog = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: '6c3152b1-1d4f-4e49-ade3-09f447712fec', name: '暖暖' }], has_more: false })); });
  await new Promise(r => catalog.listen(0, '127.0.0.1', r));
  const server = new WebSocketServer({ server: catalog });
  let socket, connections = 0, closed = 0; const receipts = [];
  const emit = (action, data = {}) => socket.send(JSON.stringify({ action, data }));
  const commentary = (run, ms = 200) => {
    const ids = { run_id: run, turn_id: '' };
    emit('response.audio.started', { ...ids, kind: 'speech' });
    for (let i = 0; i < 3; i++) { emit('response.audio.context', { ...ids, chunk_id: '', duration_ms: ms }); socket.send(tone(ms)); }
    emit('response.audio.done', ids);
  };
  server.on('connection', connection => {
    socket = connection; connections++; connection.on('close', () => closed++);
    connection.on('message', (raw, binary) => {
      if (binary) return;
      const event = JSON.parse(raw.toString());
      if (event.action === 'attach_session') emit('session_attached', { session_id: `session-${connections}`, memory_scope: 'session', delegation: 'client' });
      if (event.action === 'session.update') emit('session.updated', { error: '' });
      if (event.action === 'change_voice') emit('voice_changed', { name: event.voice_name });
      if (event.action === 'media.configure') emit('media.configured', { error: '', input_audio: { format: 'pcm16', sample_rate: 16000 }, output_audio: { format: 'pcm16', sample_rate: 24000 }, playback: 'client' });
      if (event.action === 'session.commentary.append') { emit('session.commentary.appended', { client_event_id: event.event_id, delegation_id: null, type: 'session.commentary.appended' }); commentary('preview', 300); }
      if (event.action.startsWith('playback.')) receipts.push(event);
    });
  });
  const env = { ...process.env, XIAOWANG_ENABLE_MOSS: '1', XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1', XIAOWANG_REALTIME_URL: `ws://127.0.0.1:${server.address().port}/realtime`, XIAOWANG_MOSS_VOICES_URL: `http://127.0.0.1:${catalog.address().port}/voices` }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', '--use-mock-keychain', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); for (const client of server.clients) client.terminate(); await new Promise(r => server.close(r)); catalog.closeAllConnections(); await new Promise(r => catalog.close(r)); await rm(root, { recursive: true, force: true, maxRetries: 10 }); });
  const page = await app.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.played = []; window.calls = []; window.meters = [];
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function(...args) {
      const source = create.apply(this, args), record = { ended: false, stopped: false }; window.played.push(record);
      const stop = source.stop.bind(source); source.stop = (...args) => { record.stopped = true; return stop(...args); };
      source.addEventListener('ended', () => { record.ended = true; }); return source;
    };
    const meter = AudioContext.prototype.createAnalyser; AudioContext.prototype.createAnalyser = function(...args) { const node = meter.apply(this, args); window.meters.push(node); return node; };
  });
  await page.reload(); await page.waitForSelector('.composer');
  await page.evaluate(() => window.xiaowang.onCall(note => window.calls.push({ phase: note.phase, detail: note.detail, preview: note.preview })));
  const played = () => page.evaluate(() => window.played.filter(node => node.ended && !node.stopped).length);
  const energy = () => page.evaluate(() => { const meter = window.meters.at(-1); if (!meter) return 0; const data = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length); });
  await page.locator('button.settings').click();
  const settings = page.getByRole('form', { name: '设置', exact: true }); await settings.waitFor();
  const start = Date.now(); await settings.getByRole('button', { name: '试听', exact: true }).click();
  await until(() => played().then(n => n === 3), 'Preview did not play every anonymous PCM chunk');
  await until(() => closed === 1, 'Preview did not close after actual playback');
  assert.ok(Date.now() - start >= 850); assert.equal(receipts.length, 0, 'No local IDs may leak into remote receipts');
  await settings.getByRole('button', { name: '关闭', exact: true }).click(); await settings.waitFor({ state: 'detached' });
  await page.evaluate(() => window.xiaowang.callStart('xiaowang')); await until(() => connections === 2, 'Call did not start'); await page.locator('.voice-panel').waitFor();
  commentary('notice-one'); await until(() => played().then(n => n === 6), 'First proactive speech did not finish');
  commentary('notice-two'); await until(() => played().then(n => n === 9), 'Second proactive speech did not finish');
  assert.equal(receipts.length, 0);
  commentary('interrupted', 1000); await until(async () => await energy() > .05, 'Proactive speech was inaudible');
  emit('input.speech.started'); await until(async () => await energy() < .001, 'User speech did not silence proactive speech');
  emit('response.audio.context', { run_id: 'interrupted', turn_id: '', chunk_id: '' }); socket.send(tone(200)); await sleep(70); assert.ok(await energy() < .001);
  const ids = { run_id: 'ordinary', turn_id: '1' }; emit('response.audio.started', ids); emit('response.audio.context', { ...ids, chunk_id: '1' }); socket.send(tone(400)); emit('response.audio.done', ids);
  emit('response.interrupted', { run_id: 'notice-one', reason: 'playback_timeout', text: '' });
  await until(() => receipts.some(r => r.action === 'playback.completed' && r.run_id === 'ordinary'), 'Late timeout damaged the following normal reply');
  assert.equal(receipts.filter(r => r.run_id !== 'ordinary').length, 0); assert.equal(await page.locator('.voice-panel').count(), 1);
  emit('response.audio.started', { turn_id: 'broken' }); emit('response.audio.context', { turn_id: 'broken', chunk_id: '1' }); socket.send(tone(100)); await sleep(50);
  assert.equal(await page.locator('.voice-panel').count(), 1); assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.calls.some(n => n.phase === 'closed' && n.detail)), false);
});
