/** Real, opt-in Gemini verification. Reads GEMINI_API_KEY from the environment;
 * use node --env-file=.env.gemini.local scripts/verify-gemini-live.mjs.
 * Sends only synthetic speech and harmless controlled tasks. No key/audio is
 * written to the report. This is not a production-settings acceptance test. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { GeminiLive } from '../src/gemini-live.ts';
import { JobQueue } from '../src/jobs.ts';
import { Runtime } from '../src/runtime.ts';
import { closeTestApp } from '../e2e/launch.mjs';

const key = process.env.GEMINI_API_KEY;
assert.ok(key, 'Configure GEMINI_API_KEY before running this opt-in check.');
const root = await mkdtemp(path.join(os.tmpdir(), 'xw-gemini-live-'));
const reportFile = process.env.GEMINI_TEST_REPORT || path.join(os.tmpdir(), 'xiaowang-gemini-live-verification.json');
const report = { checkedAt: new Date().toISOString(), model: 'gemini-3.8-live', status: 'running', stage: 'setup', checks: [], settingsEnabled: false, scope: 'native transport + production audio player + controlled durable executor' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, session, timer, reading = false, playerChain = Promise.resolve(), state;
let releaseWork; const workGate = new Promise(resolve => { releaseWork = resolve; });
const runtime = Runtime.open(path.join(root, 'jobs'));
const queue = new JobQueue(runtime.store, async (_job, signal, activity) => {
  activity('Isolated arithmetic check'); await workGate; signal.throwIfAborted();
  return { text: `核验结果：一到一千的平方和为 ${Array.from({ length: 1000 }, (_, n) => (n + 1) ** 2).reduce((a, b) => a + b, 0)}。` };
}); queue.start();
function checked(label) { report.checks.push(label); console.log(label); }
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (state?.closed) throw Error(state.closed);
    const result = await check(); if (result) return result; await sleep(30);
  }
  throw Error(label);
}
async function synthesize(sentence, name) {
  const run = promisify(execFile), aiff = path.join(root, `${name}.aiff`), wav = path.join(root, `${name}.wav`);
  await run('/usr/bin/say', ['-v', 'Tingting', '-r', '175', '-o', aiff, sentence]);
  await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const bytes = await readFile(wav); let pcm;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') pcm = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  assert.ok(pcm?.length); return pcm;
}
async function feed(pcm) {
  for (let offset = 0; offset < pcm.length; offset += 3200) { session.sendAudio(pcm.subarray(offset, offset + 3200)); await sleep(100); }
  session.endAudio();
}
try {
  const [question, interrupt] = await Promise.all([
    synthesize('你好，请简短回答三加五等于几。', 'question'),
    synthesize('停一下，请只回答四加四等于几。', 'interrupt'),
  ]);
  await mkdir(path.join(root, 'profile'));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'app'), XIAOWANG_USER_DATA: path.join(root, 'profile'), XIAOWANG_DISABLE_UPDATES: '1' };
  for (const name of Object.keys(env)) if (/GEMINI|GOOGLE_API_KEY|MOSS_API_KEY|ELECTRON_RUN_AS_NODE/.test(name)) delete env[name];
  app = await electron.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', 'desktop/dist/main.js'], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForSelector('.composer');
  const bundle = await build({ entryPoints: ['desktop/renderer/call-audio.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'GeminiPlayerCheck', write: false });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => {
    window.geminiEnergy = 0; window.geminiPlayed = []; window.geminiIdle = 0;
    window.geminiPlayer = GeminiPlayerCheck.createCallAudio(() => {}, () => window.geminiIdle++, undefined, position => window.geminiPlayed.push(position));
    window.geminiPlayer.subscribeLevels(value => { window.geminiEnergy = Math.max(window.geminiEnergy, value.output); });
    await window.geminiPlayer.startPlayback(24000);
  });
  state = { ready: false, closed: '', bytes: 0, turns: 0, interruptions: 0, input: '', output: '', jobs: [], played: 0, cancelIds: [] };
  timer = setInterval(async () => {
    if (reading) return; reading = true;
    try { state.played += (await page.evaluate(() => window.geminiPlayed.splice(0))).length; } catch {} finally { reading = false; }
  }, 30);
  session = new GeminiLive(key, { instructions: '这是隔离的中文语音测试。算术问题简短回答。用户要求后台处理时必须调用 delegate_research。工具未返回时不能编造结果，后台运行时仍需回答新问题。', tools: [{ name: 'delegate_research', description: '让后台独立完成耗时工作，语音继续。', behavior: 'NON_BLOCKING', parameters: { type: 'OBJECT', properties: { task: { type: 'STRING' } }, required: ['task'] } }] }, {
    onReady: () => { state.ready = true; },
    onAudio(pcm, serial, identity) {
      state.bytes += pcm.length;
      playerChain = playerChain.then(() => page.evaluate(value => window.geminiPlayer.play(value.audio, value.serial, value.identity), { audio: pcm.toString('base64'), serial, identity }));
    },
    onInterrupt(value) {
      state.interruptions++;
      playerChain = playerChain.then(() => page.evaluate(value => window.geminiPlayer.interrupt(value), value));
    },
    onText: (who, text) => { state[who === 'user' ? 'input' : 'output'] += text; },
    onTurnComplete: () => { state.turns++; },
    onClosed: reason => { state.closed = reason || 'Closed'; },
    onToolCancelled: id => state.cancelIds.push(id),
    async runTool(call) {
      assert.equal(call.name, 'delegate_research');
      const job = queue.enqueue({ botId: runtime.activeBot().id, task: String(call.args.task), channel: 'voice', originCallId: session.id, sourceCallId: `gemini:${session.id}:${call.id}` });
      state.jobs.push(job.id);
      const result = await queue.wait(job.id);
      return { result: { status: result.status, text: result.result }, scheduling: 'WHEN_IDLE' };
    },
  });
  session.start(); await until(() => state.ready, 'Native setup not accepted'); checked('Real Gemini native WebSocket setup accepted');
  report.stage = 'audio input and playback';
  await feed(question);
  await until(async () => state.turns > 0 && state.played > 0 && await page.evaluate(() => window.geminiEnergy > .005), 'No real speech output/playback');
  assert.match(state.input, /三|3/); assert.match(state.output, /八|8/);
  checked('Synthetic 16 kHz speech recognized; 24 kHz speech played by production player');
  report.stage = 'barge in';
  const beforeBytes = state.bytes, beforeInterrupt = state.interruptions;
  session.sendText('请从一数到五十，每个数字单独说出来，不要省略。');
  await until(() => state.bytes > beforeBytes + 20000, 'Long reply did not start');
  await feed(interrupt);
  await until(() => state.interruptions > beforeInterrupt, 'No native interruption event');
  await playerChain;
  checked('Real incoming speech interrupted output and cleared production playback queue');
  report.stage = 'async durable task';
  const beforeOutput = state.output.length;
  session.sendText('请调用 delegate_research，把一到一千的平方和交给后台核算，完成后告诉我。');
  await until(() => state.jobs.length > 0, 'No async function call');
  assert.equal(queue.get(state.jobs[0]).status === 'running' || queue.get(state.jobs[0]).status === 'queued', true);
  const taskTurn = state.turns;
  session.sendText('后台继续算。现在请先简短回答二加二等于几。');
  await until(() => state.turns > taskTurn && /四|4/.test(state.output.slice(beforeOutput)), 'Conversation blocked while durable task runs');
  assert.notEqual(queue.get(state.jobs[0]).status, 'succeeded'); checked('Foreground replied while a durable backend task was still running');
  releaseWork(); await until(() => queue.get(state.jobs[0]).status === 'succeeded', 'Durable task did not finish');
  await until(() => /333[\s,，]*833[\s,，]*500|三亿三千三百八十三万三千五百/.test(state.output), 'Native async tool result not spoken');
  checked('Matching async tool response delivered the actual durable result');
  report.audioBytes = state.bytes; report.playedChunks = state.played; report.interruptions = state.interruptions; report.cancelledRemoteCalls = state.cancelIds.length;
  report.status = 'passed'; report.stage = 'complete';
  report.remaining = ['Production Call persistence and task UI integration', 'Reconnect/session resumption', 'Presentation continuation and provider profile/voice configuration'];
} catch (error) {
  report.status = 'failed'; report.error = String(error.message).replaceAll(key, '[redacted]');
  console.error(`Gemini verification failed at ${report.stage}: ${report.error}`); process.exitCode = 1;
} finally {
  clearInterval(timer); session?.close(); releaseWork(); queue.shutdown();
  await playerChain.catch(() => {}); if (app) await closeTestApp(app);
  runtime.close(); await writeFile(reportFile, JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
  console.log(`Verification report: ${reportFile}`);
}
