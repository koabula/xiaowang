import { electron, closeTestApp } from './launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Voice settings did not reach the expected state') { const end = Date.now() + 15000; while (Date.now() < end) { if (await check()) return; await sleep(30); } throw Error(message); }
const D = 'fixture-doubao-1111', A = 'fixture-moss-A-2222', B = 'fixture-moss-B-2222';
const custom = 'dynamic-voice-from-last-page';

test('desktop voice settings: provider isolation, encrypted restart, all voice pages, preview, call and draft removal', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-voice-settings-')); const home = path.join(root, 'home'), profile = path.join(root, 'profile'); await mkdir(profile);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'text-key', realtimeService: 'doubao', realtimeKey: D, realtimeVoice: 'zh_male_m191_uranus_bigtts', locale: 'zh' }));
  const queries = []; let failure = false;
  const catalog = createServer((req, res) => {
    const key = req.headers.authorization?.replace('Bearer ', ''); const url = new URL(req.url, 'http://local'); queries.push({ key, after: url.searchParams.get('after') });
    res.setHeader('content-type', 'application/json');
    if (failure) { res.writeHead(503); res.end('{}'); return; }
    if (key === B) { res.end(JSON.stringify({ data: [{ id: 'voice-B', name: '账号 B 的音色' }], has_more: false })); return; }
    if (key !== A) { res.writeHead(401); res.end('{}'); return; }
    const data = url.searchParams.has('after') ? [{ id: custom, name: '最后一页音色' }, { id: 'unnamed', name: '' }, { id: 'voice-0', name: '样例音色 0' }] : Array.from({ length: 150 }, (_, i) => ({ id: `voice-${i}`, name: `样例音色 ${i}` }));
    res.end(JSON.stringify({ data, has_more: !url.searchParams.has('after'), next_cursor: 'next-page' }));
  }); await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(resolve => ws.once('listening', resolve));
  const connections = [], changes = [], receipts = []; let mic = 0, socket;
  const emit = (action, data = {}) => socket.send(JSON.stringify({ action, data }));
  const speak = () => {
    const ids = { run_id: `run-${connections.length}`, turn_id: `turn-${connections.length}` };
    emit('response.audio.started', ids); emit('output.transcript.updated', { ...ids, text: '你好，我是小王。' }); emit('response.audio.context', { ...ids, chunk_id: 'one' });
    const pcm = Buffer.alloc(24000); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 5000), i * 2);
    socket.send(pcm); emit('response.audio.done', ids);
  };
  ws.on('connection', (connection, req) => {
    socket = connection; connections.push(req.headers.authorization ?? req.headers['x-api-key']);
    connection.on('message', (raw, binary) => {
      if (binary) { mic++; return; }
      const event = JSON.parse(raw.toString());
      if (event.action === 'attach_session') emit('session_attached', { session_id: `session-${connections.length}`, memory_scope: 'session', delegation: 'client' });
      if (event.action === 'session.update') emit('session.updated', { error: '' });
      if (event.action === 'change_voice') { changes.push(event.voice_name); emit('voice_changed', { name: event.voice_name }); }
      if (event.action === 'media.configure') emit('media.configured', { error: '', input_audio: { format: 'pcm16', sample_rate: 16000 }, output_audio: { format: 'pcm16', sample_rate: 24000 }, playback: 'client' });
      if (event.action === 'session.commentary.append') { emit('session.commentary.appended', { client_event_id: event.event_id }); speak(); }
      if (event.action?.startsWith('playback.')) receipts.push(event);
    });
  });
  const env = { ...process.env, XIAOWANG_ENABLE_MOSS: '1', XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1', XIAOWANG_REALTIME_URL: `ws://127.0.0.1:${ws.address().port}/realtime`, XIAOWANG_MOSS_VOICES_URL: `http://127.0.0.1:${catalog.address().port}/voices` }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '.'], env });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.waitForSelector('.composer');
  };
  t.after(async () => { if (app) await closeTestApp(app); for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); catalog.closeAllConnections(); await new Promise(resolve => catalog.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const settings = () => page.getByRole('form', { name: '设置', exact: true });
  const open = async () => { await page.locator('button.settings').click(); await settings().waitFor(); };
  const choose = async name => { await settings().getByRole('combobox', { name: '服务', exact: true }).click(); await page.getByRole('option', { name, exact: true }).click(); await page.getByRole('listbox').waitFor({ state: 'detached' }); };
  const key = () => page.getByTestId('voice-key');
  const save = async () => { await settings().getByRole('button', { name: '保存并进入', exact: true }).click(); await settings().waitFor({ state: 'detached' }); };
  await launch(); await open(); assert.match(await key().getAttribute('placeholder'), /1111/);
  for (const size of [{ width: 1280, height: 840 }, { width: 900, height: 700 }, { width: 760, height: 680 }]) {
    await page.setViewportSize(size);
    for (const provider of ['OpenAI', '豆包全双工', 'MOSS Live']) {
      await choose(provider);
      const layout = await settings().evaluate(form => ({ scroll: form.scrollHeight - form.clientHeight, top: form.getBoundingClientRect().top, bottom: form.getBoundingClientRect().bottom, viewport: innerHeight }));
      assert.ok(layout.scroll <= 1 && layout.top >= 0 && layout.bottom <= layout.viewport, `${provider} settings must fit without vertical scrolling at ${size.width}×${size.height}: ${JSON.stringify(layout)}`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 840 });
  await choose('MOSS Live'); assert.equal(await key().getAttribute('placeholder'), '未配置');
  await key().fill(A); await settings().getByText('可用音色：152', { exact: true }).waitFor();
  assert.equal(queries.filter(query => query.key === A).length, 2);
  await settings().getByRole('searchbox', { name: '搜索音色' }).fill('最后一页');
  await settings().getByRole('combobox', { name: '音色', exact: true }).selectOption(custom);
  assert.equal(await settings().getByRole('button', { name: '试听', exact: true }).textContent(), '', 'Preview is icon-only');
  await page.setViewportSize({ width: 760, height: 680 });
  assert.ok(await settings().evaluate(form => form.scrollHeight <= form.clientHeight + 1), 'Loaded MOSS voices fit the minimum window');
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.screenshot({ path: path.join(os.tmpdir(), 'xiaowang-settings-voices.png') });
  await choose('豆包全双工'); assert.equal(await key().inputValue(), ''); assert.match(await key().getAttribute('placeholder'), /1111/);
  await settings().getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('alertdialog').waitFor(); await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await choose('MOSS Live'); assert.equal(await key().inputValue(), A); assert.equal(await settings().getByRole('combobox', { name: '音色', exact: true }).inputValue(), custom);
  await choose('豆包全双工'); await save();
  const view = await page.evaluate(() => window.xiaowang.getState()); assert.ok(!JSON.stringify(view.settings).includes(A)); assert.ok(!JSON.stringify(view.settings).includes(D));
  await closeTestApp(app); await launch(); await open(); await choose('MOSS Live');
  assert.equal(await key().inputValue(), ''); assert.match(await key().getAttribute('placeholder'), /2222/);
  await settings().getByText('可用音色：152', { exact: true }).waitFor();
  assert.equal(await settings().getByRole('combobox', { name: '音色', exact: true }).inputValue(), custom);
  failure = true; await settings().getByRole('button', { name: '刷新音色', exact: true }).click(); await settings().getByText(/MOSS 音色读取失败（503）/).waitFor();
  assert.equal(await settings().getByRole('combobox', { name: '音色', exact: true }).inputValue(), custom); failure = false;
  await settings().getByRole('button', { name: '试听', exact: true }).click();
  await until(() => connections.includes(`Bearer ${A}`)); await until(() => changes.includes(custom)); await until(() => receipts.some(event => event.action === 'playback.completed'));
  await settings().getByRole('button', { name: '试听', exact: true }).waitFor();
  const before = connections.length; await settings().getByRole('button', { name: '清除已保存密钥', exact: true }).click();
  await settings().getByRole('button', { name: '试听', exact: true }).click(); await settings().getByText(/先填写这一家的密钥/).waitFor(); assert.equal(connections.length, before);
  await settings().getByRole('button', { name: '撤销密钥清除', exact: true }).click();
  await choose('豆包全双工'); await page.keyboard.press('Escape'); await settings().waitFor({ state: 'detached' });
  await page.evaluate(() => window.xiaowang.previewVoice({ realtimeService: 'doubao' })); await until(() => connections.includes(D)); await page.evaluate(() => window.xiaowang.callStop());
  await open(); await choose('MOSS Live'); await save();
  await page.evaluate(() => window.xiaowang.callStart('xiaowang')); await until(() => mic > 0);
  assert.equal(connections.at(-1), `Bearer ${A}`); assert.equal(changes.at(-1), custom);
  emit('response.interrupted', { reason: 'no output identifiers' }); emit('input.transcript.done', { text: '你好', turn: 'user' }); speak();
  await until(() => receipts.filter(event => event.action === 'playback.completed').length === 2);
  assert.equal(await page.locator('.voice-panel').count(), 1); assert.equal((await page.evaluate(() => window.xiaowang.getState())).jobs.length, 0);
  await page.evaluate(() => window.xiaowang.callStop());
  await open(); await key().fill(B); await settings().getByText('可用音色：1', { exact: true }).waitFor();
  assert.equal(await settings().getByRole('option', { name: '账号 B 的音色', exact: true }).count(), 1);
  assert.equal(await settings().getByRole('option', { name: '最后一页音色', exact: true }).count(), 0);
  await settings().getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  const last = connections.length; await page.evaluate(() => window.xiaowang.previewVoice({ realtimeService: 'moss' })); await until(() => connections.length > last);
  assert.equal(connections.at(-1), `Bearer ${A}`); await page.evaluate(() => window.xiaowang.callStop());
  await open(); await settings().getByRole('button', { name: '清除已保存密钥', exact: true }).click(); await save();
  await closeTestApp(app); await launch();
  const cleared = (await page.evaluate(() => window.xiaowang.getState())).settings;
  assert.equal(cleared.realtimeProfiles.moss.keyHint, ''); assert.match(cleared.realtimeProfiles.doubao.keyHint, /1111/);
  await assert.rejects(page.evaluate(() => window.xiaowang.previewVoice({ realtimeService: 'moss' })), /先填写/);
  assert.deepEqual(errors, []);
});
