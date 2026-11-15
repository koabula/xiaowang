/** Opt-in integration check. Real MOSS Live + production player + durable controlled job executor.
 * Supply MOSS_API_KEY or one line on stdin, and two harmless 16 kHz PCM16 WAV fixtures:
 * MOSS_TEST_QUESTION_WAV: “你好，请回答三加五等于几。”
 * MOSS_TEST_TASK_WAV: “请让后台助手帮我计算一到一千的平方和，完成后告诉我结果。”
 * No credentials are persisted. This is intentionally excluded from offline CI.
 */
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import WebSocket from 'ws';
import { MossCall } from '../desktop/main/moss-call.ts';
import { mossSession } from '../src/moss-realtime.ts';
import { Runtime } from '../src/runtime.ts';
import { JobQueue } from '../src/jobs.ts';
import { closeTestApp } from '../e2e/launch.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 35000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(30); }
  throw Error(label);
}
async function pcmFile(filename) {
  const wav = await readFile(filename); let pcm, format;
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  for (let p = 12; p + 8 <= wav.length;) {
    const size = wav.readUInt32LE(p + 4), name = wav.toString('ascii', p, p + 4);
    if (name === 'fmt ') format = { encoding: wav.readUInt16LE(p + 8), channels: wav.readUInt16LE(p + 10), rate: wav.readUInt32LE(p + 12), bits: wav.readUInt16LE(p + 22) };
    if (name === 'data') pcm = wav.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  assert.deepEqual(format, { encoding: 1, channels: 1, rate: 16000, bits: 16 }); assert.ok(pcm?.length);
  return pcm;
}
let key = process.env.MOSS_API_KEY;
if (!key) {
  const input = createInterface({ input: process.stdin, terminal: false });
  key = await new Promise(resolve => input.once('line', line => { input.close(); resolve(line.trim()); }));
}
assert.ok(key, 'MOSS_API_KEY or stdin credential is required');
const question = await pcmFile(process.env.MOSS_TEST_QUESTION_WAV), task = await pcmFile(process.env.MOSS_TEST_TASK_WAV);
const root = await mkdtemp(path.join(os.tmpdir(), 'xw-real-moss-'));
const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'app-home'), XIAOWANG_USER_DATA: path.join(root, 'profile'), XIAOWANG_DISABLE_UPDATES: '1' };
for (const name of Object.keys(env)) if (/^(MOSS_|XIAOWANG_REALTIME_)/.test(name) || name === 'ELECTRON_RUN_AS_NODE') delete env[name];
const runtime = Runtime.open(path.join(root, 'jobs'));
let app, current, receiptTimer, readingReceipts = false, closing = false, bridge = Promise.resolve();
const output = process.env.MOSS_TEST_REPORT || path.join(os.tmpdir(), 'xiaowang-moss-live-verification.json');
const report = { checkedAt: new Date().toISOString(), model: 'moss-live-1.0', executor: 'controlled durable JobQueue', status: 'running', stage: 'player setup', checks: [] };
const log = label => console.log(label);
const queue = new JobQueue(runtime.store, async (_job, signal, activity) => {
  activity('正在独立核算平方和。'); await sleep(2500); signal.throwIfAborted();
  const sum = Array.from({ length: 1000 }, (_, i) => (i + 1) ** 2).reduce((a, b) => a + b, 0);
  assert.equal(sum, 333833500); return { text: `后台计算已完成：一到一千的平方和为 ${sum}。` };
}, job => current?.call.jobChanged(job)); queue.start();
try {
  app = await electron.launch({ args: ['--no-sandbox', '--use-mock-keychain', '--autoplay-policy=no-user-gesture-required', 'desktop/dist/main.js'], env });
  const page = await app.firstWindow(); await page.waitForSelector('.composer');
  page.setDefaultTimeout(15000);
  const bundle = await build({ entryPoints: ['desktop/renderer/call-audio.ts'], bundle: true, format: 'iife', globalName: 'MossPlayerCheck', write: false, platform: 'browser' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    window.checkMaxEnergy = 0; window.checkPlayed = [];
    window.checkPlayer = MossPlayerCheck.createCallAudio(() => {}, undefined, undefined, p => window.checkPlayed.push(p));
    window.checkPlayer.subscribeLevels(levels => { window.checkMaxEnergy = Math.max(window.checkMaxEnergy, levels.output); });
  });
  receiptTimer = setInterval(async () => {
    if (readingReceipts) return; readingReceipts = true;
    try {
      const positions = await page.evaluate(() => window.checkPlayed.splice(0));
      for (const position of positions) if (current?.call.id === position.callId) { current.played++; current.call.noteChunkPlayed(position); }
    } catch (error) {
      if (!closing && current) current.receiptError = String(error.message).replaceAll(key, '[redacted]');
    } finally { readingReceipts = false; }
  }, 20);
  log('Production audio player ready');
  async function start(preview = '') {
    await bridge; await page.evaluate(async () => { window.checkPlayer.stop(); window.checkMaxEnergy = 0; await window.checkPlayer.startPlayback(24000); });
    const state = { chunks: 0, played: 0, bytes: 0, live: false, closed: false, detail: '', runs: [], done: new Set(), ended: new Set(), timeouts: [], errors: [], sent: [], final: [], feed: null, feedOffset: 0 };
    current = state;
    state.call = new MossCall('wss://api.mosi.cn/v1/realtime?model=moss-live-1.0', key,
      mossSession('隔离测试，无私人资料。普通问题简短回答。复杂计算必须委派客户端后台，收到真实结果后再告知用户。', [], '6c3152b1-1d4f-4e49-ade3-09f447712fec'), {
        onPhase(phase, detail) { if (phase === 'live') state.live = true; if (phase === 'closed') { state.closed = true; state.detail = detail || ''; } },
        onAudio(pcm, serial, identity) {
          state.bytes += pcm.length; state.chunks++;
          bridge = bridge.then(() => page.evaluate(({ audio, serial, identity }) => window.checkPlayer.play(audio, serial, identity), { audio: pcm.toString('base64'), serial, identity }));
        },
        onInterrupt(interruption) {
          bridge = bridge.then(async () => { const position = await page.evaluate(value => window.checkPlayer.interrupt(value), interruption); state.call.noteInterrupted({ callId: state.call.id, playbackEpoch: interruption.playbackEpoch, position }); });
        },
        onLine(_who, _value, _partial) {},
        onTranscript(who, text) { if (who === 'assistant') state.final.push(text); },
        runTool: async () => '',
        delegate(delegation) { return queue.enqueue({ botId: runtime.activeBot().id, task: delegation.objective, channel: 'voice', originCallId: state.call.id, sourceCallId: `moss:${delegation.sessionId}:${delegation.id}` }); },
        cancelDelegation(id) { queue.cancel(id); },
      }, (url, headers) => {
        const socket = new WebSocket(url, { headers }), send = socket.send.bind(socket);
        socket.send = (value, ...args) => {
          if (typeof value === 'string') { const message = JSON.parse(value); state.sent.push(message); if (message.action.startsWith('playback.')) { assert.ok(message.run_id && message.turn_id); if (message.action === 'playback.chunk.completed') assert.ok(message.chunk_id && !message.chunk_id.startsWith('local:')); } }
          return send(value, ...args);
        };
        socket.on('message', (value, binary) => {
          if (binary) return; const { action, data = {} } = JSON.parse(value.toString());
          if (action === 'response.audio.started') state.runs.push({ run: data.run_id, local: !data.turn_id, afterResult: state.sent.some(e => e.action === 'session.commentary.append' && e.delegation_id && e.status === 'completed') });
          if (action === 'response.audio.done') state.done.add(data.run_id);
          if (action === 'response.ended') state.ended.add(data.run_id);
          if (action === 'response.interrupted' && data.reason === 'playback_timeout') state.timeouts.push(data.run_id);
          if (action === 'error') state.errors.push(data.error?.code || 'unknown');
        }); return socket;
      }, preview);
    state.call.start(); await until(() => state.live || state.closed, 'MOSS did not become ready'); assert.equal(state.detail, '');
    log(preview ? 'Real preview session ready' : 'Real conversation session ready');
    state.timer = setInterval(() => {
      const pcm = state.feed?.subarray(state.feedOffset, state.feedOffset + 3200) || Buffer.alloc(3200);
      if (state.feed) { state.feedOffset += 3200; if (state.feedOffset >= state.feed.length) state.feed = null; }
      state.call.sendAudio(pcm);
    }, 100);
    return state;
  }
  async function speech(pcm) { current.feedOffset = 0; current.feed = pcm; await until(() => !current.feed, 'Input upload stalled'); }
  async function drained(state, baseline, local, afterResult = false) {
    return until(async () => {
      assert.equal(state.closed, false); assert.equal(state.detail, '');
      assert.equal(state.receiptError, undefined);
      const run = state.runs.slice(baseline).find(run => (local === undefined || run.local === local) && (!afterResult || run.afterResult));
      if (!run || !state.done.has(run.run) || state.played !== state.chunks || !state.chunks) return false;
      if (!run.local && !state.ended.has(run.run)) return false;
      await bridge; assert.ok(await page.evaluate(() => window.checkMaxEnergy) > .01, 'No audible signal in production player'); return run;
    }, 'Real response never drained');
  }
  report.stage = 'preview';
  const preview = await start('你好，我是小王，这是音色试听。');
  await until(() => preview.closed, 'Real preview did not finish').catch(async error => {
    console.log(JSON.stringify({ stage: 'preview', chunks: preview.chunks, played: preview.played, bytes: preview.bytes, runs: preview.runs, done: [...preview.done], errors: preview.errors, detail: preview.detail, energy: await page.evaluate(() => window.checkMaxEnergy) }));
    throw error;
  }); await bridge;
  assert.equal(preview.detail, ''); assert.ok(preview.bytes > 0 && preview.chunks > 1); assert.equal(preview.played, preview.chunks);
  assert.ok(await page.evaluate(() => window.checkMaxEnergy) > .01); assert.equal(preview.errors.length, 0); clearInterval(preview.timer);
  report.checks.push({ scenario: 'preview', chunksPlayed: preview.played, bytes: preview.bytes, result: 'passed' }); log('PASS real preview / production player');
  report.stage = 'consecutive proactive speech';
  const call = await start();
  call.call.notify('notice-1', '你好，这是第一条主动播报。'); await drained(call, 0, undefined);
  let baseline = call.runs.length; call.call.notify('notice-2', '第二条主动播报，播放测试已完成。'); await drained(call, baseline, undefined);
  // Also cover delayed provider events, without requiring an upstream bug to occur.
  await sleep(12000); assert.equal(call.closed, false);
  report.checks.push({ scenario: 'consecutive proactive speech and delayed events', localRuns: call.runs.filter(r => r.local).length, remoteTimeouts: call.timeouts.length, result: 'passed' }); log('PASS consecutive proactive speech / delayed event isolation');
  report.stage = 'conversation after proactive speech';
  baseline = call.runs.length; await speech(question); await drained(call, baseline, false);
  assert.match(call.final.at(-1), /八|8/); log('PASS ordinary conversation after proactive speech');
  report.stage = 'native background result';
  baseline = call.runs.length; await speech(task);
  await until(() => queue.list().some(job => job.status === 'succeeded'), 'Real MOSS did not delegate the test task');
  await until(() => call.sent.some(e => e.action === 'session.commentary.append' && e.delegation_id && e.content.includes('333833500')), 'Background result was not fed back');
  await drained(call, baseline, false, true); assert.equal(call.errors.length, 0); assert.equal(call.closed, false);
  assert.match(call.final.at(-1), /平方和|333.?833.?500|三亿/);
  report.checks.push({ scenario: 'native delegation / durable executor / spoken result', result: 'passed', resultText: call.final.at(-1) }); log('PASS native background task result / production player');
  report.stage = 'conversation after result';
  baseline = call.runs.length; await speech(question); await drained(call, baseline, false); assert.match(call.final.at(-1), /八|8/);
  call.call.hangup(); clearInterval(call.timer); await bridge;
  report.checks.push({ scenario: 'conversation after result', result: 'passed' });
  report.status = 'passed'; report.stage = 'complete';
} catch (error) {
  report.status = 'failed'; report.failure = String(error.message).replaceAll(key, '[redacted]');
  throw error;
} finally {
  closing = true;
  clearInterval(receiptTimer);
  if (current) { current.call?.hangup(); clearInterval(current.timer); }
  await bridge.catch(() => {}); queue.shutdown(); runtime.close(); if (app) await closeTestApp(app);
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
  await writeFile(output, JSON.stringify(report, null, 2)); log(`Verification ${report.status}: ${output}`);
  key = undefined;
}
