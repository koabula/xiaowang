import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { closeTestApp } from './launch.mjs';

test('legacy budgets disappear and automatic limits apply to the desktop thinking/tool loop', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-research-budget-'));
  const profile = path.join(root, 'profile'); await mkdir(profile);
  const bodies = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'deepseek-fixture', context_length: 131072 }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const prior = body.messages.find(m => m.role === 'tool');
    for (const message of body.messages) if (message.role === 'assistant') assert.equal(typeof message.reasoning_content, 'string');
    res.setHeader('content-type', 'text/event-stream');
    const delta = prior ? { content: 'RESEARCH-COMPLETE', reasoning_content: '采用文件列表' } : { reasoning_content: '先检查文件', tool_calls: [{ index: 0, id: 'native-list', function: { name: 'list_files', arguments: '{}' } }] };
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: prior ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'deepseek-fixture', apiKey: 'local', locale: 'zh', contextProfile: 'conservative', contextOutput: '12000', contextWindow: '32768' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => { app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env }); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.locator('.composer').waitFor(); };
  t.after(async () => { if (app) await closeTestApp(app); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 10 }); });
  await launch(); await page.locator('button.settings').click();
  const form = page.getByRole('form', { name: '设置', exact: true });
  assert.equal(await form.locator('.research-budget').count(), 0);
  await form.getByRole('button', { name: '保存并进入', exact: true }).click(); await form.waitFor({ state: 'detached' });
  await closeTestApp(app); app = null; await launch();
  const saved = (await page.evaluate(() => window.xiaowang.getState())).settings;
  assert.equal(saved.contextProfile, undefined); assert.equal(saved.contextOutput, undefined);
  const textarea = page.locator('.composer textarea'); await textarea.fill('请查看文件'); await textarea.press('Enter');
  await page.getByText('RESEARCH-COMPLETE', { exact: true }).waitFor();
  assert.equal(bodies.length, 2); assert.ok(bodies.every(body => body.max_tokens === 8192));
  const native = bodies[1].messages.find(m => m.role === 'assistant');
  assert.equal(native.reasoning_content, '先检查文件'); assert.equal(native.tool_calls[0].id, 'native-list');
  assert.equal(bodies[1].messages.find(m => m.role === 'tool').tool_call_id, 'native-list');
  assert.deepEqual(errors, []);
});
