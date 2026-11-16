import { electron, launchPackaged, closeTestApp } from './launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Runtime } from '../src/runtime.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 12000; while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(30); } throw new Error('Task display did not reach the expected state'); }

test('desktop: chat stays clean; voice work and results live only inside their collapsed source call', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-task-display-')); const home = path.join(root, 'home'); const profile = path.join(root, 'profile'); await mkdir(profile);
  const seed = Runtime.open(home); const bot = seed.activeBot(); const other = seed.store.createBot({ name: 'Other space', systemPrompt: 'test' });
  const createdAt = new Date(Date.now() - 30000).toISOString(); const updatedAt = new Date(Date.now() + 1000).toISOString();
  const base = { botId: bot.id, notify: 'silent', status: 'succeeded', createdAt, updatedAt, activity: '', error: '', attempts: 1, artifacts: [] };
  seed.store.append(bot.id, { type: 'user_text', channel: 'text', text: 'hi' });
  seed.store.append(bot.id, { type: 'assistant_turn', channel: 'text', text: 'LEGACY-PROGRESS-ONLY', toolCalls: [{ id: 'legacy-read', name: 'list_files', input: {} }] });
  seed.store.append(bot.id, { type: 'assistant_turn', channel: 'text', text: 'LEGACY-CHAT-REPLY', toolCalls: [] });
  seed.store.append(bot.id, { type: 'job', job: { ...base, id: 'old-greeting', task: 'hi', channel: 'text', result: 'LEGACY-CHAT-REPLY' } });
  seed.store.append(bot.id, { type: 'assistant_turn', channel: 'text', text: 'CANONICAL-RESEARCH-RESULT: the research is complete.', toolCalls: [] });
  const call = seed.store.append(bot.id, { type: 'call', callId: 'old-phone', startedAt: new Date(Date.now() - 40000).toISOString(), endedAt: new Date(Date.now() + 1000).toISOString(), lines: [{ who: 'user', text: '整理研究备忘录' }, { who: 'assistant', text: '已开始处理。' }] });
  seed.store.append(bot.id, { type: 'job', job: { ...base, id: 'old-research', task: '整理研究备忘录，包含方法、结果和限制条件等详细要求', channel: 'voice', result: 'CANONICAL-RESEARCH-RESULT: the research is complete.', artifacts: ['notes/memo.md'] } });
  seed.store.append(bot.id, { type: 'job', job: { ...base, id: 'old-failure', task: '读取缺失文件', channel: 'voice', status: 'failed', result: '', error: '测试文件缺失' } });
  await mkdir(path.join(bot.workspaceDir, 'notes'), { recursive: true }); await writeFile(path.join(bot.workspaceDir, 'notes/memo.md'), '# Research memo\nARTIFACT-CONTENT-ONLY');
  seed.close();
  let failedChatOnce = false;
  let researchWaiting = false;
  let finishResearch;
  const researchGate = new Promise(resolve => { finishResearch = resolve; });
  const model = createServer(async (request, response) => {
    if (request.url?.endsWith("/models")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [] })); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); const text = input.messages.findLast(message => message.role === 'user')?.content || '';
    if (input.messages.at(-1)?.tool_call_id === 'review-read') {
      researchWaiting = true;
      await researchGate;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '## MULTISTEP-FINAL\n\n研究已完成。这里保存最终结论，过程记录可供后续研究使用。\n\n### 核对依据\n\n- 原文来自当前课题的资料。\n- 补充要求随任务一起处理。\n\n| 项目 | 结果 |\n| --- | --- |\n| 文件 | 已核对 |\n| 笔记 | 已整理 |' } }] })); return;
    }
    if (text.includes('多步研究测试')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'LIVE-PROGRESS-ONLY', tool_calls: [{ id: 'review-read', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } }] })); return;
    }
    if (text.includes('失败聊天测试') && !failedChatOnce) {
      failedChatOnce = true; response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'CHAT-FAILURE-ONCE' } })); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: text.includes('读取缺失文件') ? 'RETRIED-BACKGROUND-REPLY' : text.includes('失败聊天测试') ? 'CHAT-RETRY-REPLY' : 'NEW-CHAT-REPLY' } }] }));
  }); await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'local', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = process.env.XIAOWANG_E2E_EXECUTABLE ? await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, ['--no-sandbox'], env) : await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.waitForSelector('.composer');
  const sourceCall = page.locator(`[data-call-id="old-phone"]`);
  await sourceCall.waitFor();
  assert.equal(await sourceCall.locator(':scope > button').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.task-panel, .task-item, .call-tasks').count(), 0, 'Collapsed calls have no independent task UI');
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: 'CANONICAL-RESEARCH-RESULT' }).count(), 0, 'Voice results never appear as text-chat replies');
  await page.locator('.composer textarea').fill('hi'); await page.locator('.composer textarea').press('Enter');
  await page.locator('.messages').getByText('NEW-CHAT-REPLY', { exact: true }).waitFor();
  await page.locator('.composer textarea').fill('多步研究测试'); await page.locator('.composer textarea').press('Enter');
  await until(() => researchWaiting);
  assert.equal(await page.locator('.thinking').isVisible(), true, 'Progress uses the existing temporary status');
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: 'LIVE-PROGRESS-ONLY' }).count(), 0);
  finishResearch();
  await page.locator('.bubble.assistant h2').filter({ hasText: 'MULTISTEP-FINAL' }).waitFor();
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: /LIVE-PROGRESS-ONLY|LEGACY-PROGRESS-ONLY/ }).count(), 0);
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: 'NEW-CHAT-REPLY' }).count(), 1, 'Separate questions keep their own final answer');
  const history = await page.evaluate(() => window.xiaowang.events('xiaowang'));
  assert.equal(history.filter(item => item.kind === 'assistant' && item.text.includes('MULTISTEP-FINAL')).length, 1);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.bubble.assistant').last().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: path.join(os.tmpdir(), `xiaowang-editorial-${colorScheme}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 800, height: 720 });
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.search-line input').fill('Other space');
  assert.equal(await page.locator('.bot').count(), 1);
  assert.equal(await page.locator('.search-line input').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('.search-line input').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await page.screenshot({ path: path.join(os.tmpdir(), 'xiaowang-editorial-narrow.png'), animations: 'disabled' });
  await page.locator('.search-line input').fill('');
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('.search-line input').click();
  assert.equal(await page.locator('.search-line input').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  const greeting = await until(async () => (await page.evaluate(() => window.xiaowang.getState())).jobs.find(job => job.id !== 'old-greeting' && job.task === 'hi'));
  assert.equal(greeting.display, 'conversation'); assert.equal(await page.locator(`[data-job-id="${greeting.id}"]`).count(), 0);
  await sourceCall.locator(':scope > button').click();
  assert.equal(await sourceCall.locator('.task-item').count(), 2);
  const research = sourceCall.locator('[data-job-id="old-research"]');
  await research.locator('summary').click();
  await research.getByText('CANONICAL-RESEARCH-RESULT: the research is complete.', { exact: true }).waitFor();
  assert.equal(await page.getByText('CANONICAL-RESEARCH-RESULT: the research is complete.', { exact: true }).count(), 1, 'The result has only one copy, inside the call');
  assert.equal(await page.locator('.conversation-entry > .task-item, .task-panel').count(), 0);
  await research.getByRole('button', { name: '打开 memo.md', exact: true }).click();
  await page.locator('.canvas-frame, .document-reader').first().waitFor();
  await page.getByText('ARTIFACT-CONTENT-ONLY', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(os.tmpdir(), 'xiaowang-task-history.png') });
  await sourceCall.locator('[data-job-id="old-failure"]').getByRole('button', { name: '重试', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.xiaowang.getState())).jobs.find(job => job.id === 'old-failure')?.status === 'succeeded');
  const retried = sourceCall.locator('[data-job-id="old-failure"]');
  await retried.locator('summary').click();
  await retried.getByText('RETRIED-BACKGROUND-REPLY', { exact: true }).waitFor();
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: 'RETRIED-BACKGROUND-REPLY' }).count(), 0, 'A retry after hangup remains in the original call');
  await sourceCall.locator(':scope > button').click();
  assert.equal(await page.locator('.task-item, .call-tasks').count(), 0);
  await page.evaluate(slug => window.xiaowang.setActive(slug), other.slug);
  await until(async () => (await page.evaluate(() => window.xiaowang.getState())).activeSlug === other.slug);
  await sourceCall.waitFor({ state: 'detached' });
  await page.locator('.composer textarea').fill('你好'); await page.locator('.composer textarea').press('Enter');
  const otherChat = await until(async () => (await page.evaluate(() => window.xiaowang.getState())).jobs.find(job => job.botId === other.id && job.task === '你好' && job.status === 'succeeded'));
  await page.locator(`#message-${otherChat.originEventId}`).waitFor();
  assert.equal(await page.locator('.task-panel, .task-item').count(), 0, 'A chat-only workspace has no task cards or task history');
  await page.locator('.composer textarea').fill('失败聊天测试'); await page.locator('.composer textarea').press('Enter');
  await page.locator('.conversation-issue').filter({ hasText: 'CHAT-FAILURE-ONCE' }).waitFor();
  assert.equal(await page.locator('.task-panel, .task-item').count(), 0, 'A failed chat is an inline reply issue, not a background task card');
  await page.getByRole('button', { name: '重试回复', exact: true }).click();
  await page.locator('.messages').getByText('CHAT-RETRY-REPLY', { exact: true }).waitFor();
  assert.equal(await page.locator('.conversation-issue, .task-panel, .task-item').count(), 0);
  await page.evaluate(() => window.xiaowang.setActive('xiaowang')); await sourceCall.waitFor();
  assert.equal(await sourceCall.locator(':scope > button').getAttribute('aria-expanded'), 'false', 'Workspace changes reset call expansion');
  await page.reload(); await sourceCall.waitFor();
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: /LIVE-PROGRESS-ONLY|LEGACY-PROGRESS-ONLY/ }).count(), 0);
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: 'MULTISTEP-FINAL' }).count(), 1, 'Reload retains one final answer per task');
  assert.equal(await page.locator('.task-panel, .task-item, .call-tasks').count(), 0);
  assert.equal(await page.locator('.bubble.assistant').filter({ hasText: /CANONICAL-RESEARCH-RESULT|RETRIED-BACKGROUND-REPLY/ }).count(), 0);
  await page.screenshot({ path: path.join(os.tmpdir(), 'xiaowang-task-display.png') });
  await sourceCall.locator(':scope > button').click();
  assert.equal(await sourceCall.locator('.task-item').count(), 2, 'Reload preserves both call-owned jobs');
  await sourceCall.locator('[data-job-id="old-failure"] summary').click();
  await sourceCall.getByText('RETRIED-BACKGROUND-REPLY', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Verified ordinary/failed chat has no cards, voice work only inside its source call, collapsed calls hide results, single result copy, artifact opening, retry after hangup, workspace/reload isolation and legacy compatibility.');
});
