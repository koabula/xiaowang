import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { runTurn } from '../src/harness.ts';
import { executeTool } from '../src/tools.ts';
import type { CompletionResult, LlmProvider } from '../src/types.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'xw-handoff-'));
  const runtime = Runtime.open(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const bot = runtime.activeBot();
  const file = runtime.store.addLibraryBytes(bot.id, 'paper.txt', Buffer.from('SOURCE-ORIGINAL')).ref;
  return { runtime, bot, file };
}
const spawn = (files?: string[]) => ({ name: 'Child', baseline: 'Quick paper analysis', kickoff_task: 'Give a short explanation', ...(files ? { files } : {}) });

test('spawn hands selected original refs over before any kickoff and validates all refs first', async t => {
  const { runtime, bot, file } = fixture(t);
  runtime.store.addLibraryBytes(bot.id, 'private.txt', Buffer.from('PRIVATE'));
  let received = 0;
  const host = { store: runtime.store, bot, enqueueKickoff(job: { botId: string }) {
    received++;
    assert.deepEqual(runtime.store.listLibrary(job.botId).map(ref => ref.id), [file.id]);
    assert.equal(runtime.store.resolveLibraryRef(job.botId, file.id).storedPath, file.storedPath);
    assert.equal(runtime.store.getEvents(job.botId).some(e => e.event.type === 'user_text'), false);
  } };
  const count = runtime.store.listBots().length;
  assert.equal((await executeTool('spawn_bot', spawn([file.id, 'missing']), host)).isError, true);
  assert.equal(runtime.store.listBots().length, count);
  assert.equal(received, 0);
  assert.equal((await executeTool('spawn_bot', spawn([file.id, file.id]), host)).isError, false);
  assert.equal(received, 1);
  assert.equal(runtime.store.countLibraryFiles(), 2, 'No duplicate file bytes are created');
});

test('desktop kickoff waits for later share_file and the parent final response', async t => {
  const { runtime, bot, file } = fixture(t);
  let dispatched = 0, calls = 0;
  const provider: LlmProvider = { model: 'fixture', async complete(): Promise<CompletionResult> {
    calls++;
    assert.equal(dispatched, 0, 'Child must not run while parent is still handing off');
    await new Promise(resolve => setImmediate(resolve));
    if (calls === 1) return { text: '', toolCalls: [{ id: 'spawn', name: 'spawn_bot', arguments: JSON.stringify(spawn()) }] };
    const child = runtime.store.listBots().find(b => b.parentBotId === bot.id)!;
    if (calls === 2) return { text: '', toolCalls: [{ id: 'share', name: 'share_file', arguments: JSON.stringify({ file: file.id, to: child.slug }) }] };
    return { text: 'PARENT-FINAL', toolCalls: [] };
  } };
  await runTurn(runtime, { botId: bot.id, input: 'Pass this paper to a child', provider, onKickoff(job) {
    dispatched++;
    assert.equal(calls, 3);
    assert.equal(runtime.store.resolveLibraryRef(job.botId, file.id).id, file.id);
    assert.equal(runtime.store.getEvents(bot.id).at(-1)?.event.type, 'assistant_turn');
  } });
  assert.equal(dispatched, 1);
});

for (const failure of ['cancel', 'error', 'step-limit'] as const) test(`unfinished handoff does not start a child: ${failure}`, async t => {
  const { runtime, bot, file } = fixture(t); const controller = new AbortController();
  let calls = 0, dispatched = 0;
  const provider: LlmProvider = { model: 'fixture', async complete() {
    if (++calls === 1) return { text: '', toolCalls: [{ id: 'spawn', name: 'spawn_bot', arguments: JSON.stringify(spawn([file.id])) }] };
    if (failure === 'cancel') { controller.abort(); return { text: 'cancelled', toolCalls: [] }; }
    throw new Error('fixture upstream error');
  } };
  const turn = runTurn(runtime, { botId: bot.id, input: 'delegate', provider, signal: controller.signal, maxSteps: failure === 'step-limit' ? 1 : 40, onKickoff() { dispatched++; } });
  if (failure === 'step-limit') await turn; else await assert.rejects(turn);
  assert.equal(dispatched, 0);
});
