import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { Runtime } from '../src/runtime.ts';
import { JobQueue } from '../src/jobs.ts';
import { closeTestApp } from './launch.mjs';

test('a second desktop launch focuses the owner without restoring or duplicating its task', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-single-instance-')), home = path.join(root, 'home'), profile = path.join(root, 'profile');
  await mkdir(profile);
  const seed = Runtime.open(home), bot = seed.activeBot();
  const queue = new JobQueue(seed.store, async () => { throw new Error('Seed must not run'); });
  const job = queue.enqueue({ botId: bot.id, task: 'Write one research note' }); seed.close();
  let release; const gate = new Promise(resolve => { release = resolve; }); let starts = 0;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), toolDone = body.messages.at(-1).role === 'tool';
    if (!toolDone) { starts++; await gate; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: toolDone ? { content: 'SINGLE-RESULT' } : { content: '正在整理', tool_calls: [{ id: 'write-once', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/once.md', content: '# One note' }) } }] } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env }); let child;
  t.after(async () => { release(); if (child && child.exitCode === null) child.kill('SIGKILL'); await closeTestApp(app); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(12000); await page.waitForSelector('.thinking');
  assert.equal(starts, 1);
  await app.evaluate(({ app, BrowserWindow }) => { globalThis.secondLaunches = 0; app.on('second-instance', () => { globalThis.secondLaunches++; }); BrowserWindow.getAllWindows()[0].hide(); });
  child = spawn(createRequire(import.meta.url)('electron'), ['--no-sandbox', 'desktop/dist/main.js'], { env, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Second instance did not exit')), 12000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Second exit ${code}`)); });
  });
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => ({ received: globalThis.secondLaunches, windows: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible() })), { received: 1, windows: 1, visible: true });
  release(); await page.locator('.bubble.assistant').filter({ hasText: 'SINGLE-RESULT' }).waitFor();
  const state = await page.evaluate(() => window.xiaowang.getState());
  assert.equal(starts, 1); assert.equal(state.jobs.find(item => item.id === job.id).attempts, 1);
  const events = await page.evaluate(() => window.xiaowang.events('xiaowang'));
  assert.equal(events.filter(item => item.kind === 'tool' && item.name === 'write_file').length, 1);
  assert.equal(await readFile(path.join(bot.workspaceDir, 'notes/once.md'), 'utf8'), '# One note');
});
