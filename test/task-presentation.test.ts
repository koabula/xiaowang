import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundTurnOwners, taskTurnOwners, visibleAnswerIds, isBackgroundJob, presentJob, taskTitle } from '../src/task-presentation.ts';
import { taskLayout } from '../desktop/renderer/task-view.ts';
import type { SessionEvent, StoredEvent, TaskJob } from '../src/types.ts';

const job = (patch: Partial<TaskJob> = {}): TaskJob => ({ id: 'work', botId: 'bot', task: '梳理论文，包含方法、结果和局限', channel: 'voice', notify: 'when_idle', status: 'succeeded', createdAt: '2026-11-15T01:00:00.000Z', updatedAt: '2026-11-15T01:01:00.000Z', activity: '', result: '原文分析结果', error: '', attempts: 1, artifacts: [], ...patch });
const stored = (id: number, event: SessionEvent, createdAt = '2026-11-15T01:00:30.000Z'): StoredEvent => ({ id, botId: 'bot', createdAt, event });

test('each successful task exposes its final answer, while steps and unfinished attempts stay in history', () => {
  const events = [
    stored(1, { type: 'user_text', channel: 'text', text: '研究', jobId: 'first' }),
    stored(2, { type: 'assistant_turn', channel: 'text', jobId: 'first', text: '正在读取', toolCalls: [{ id: 'read', name: 'list_files', input: {} }] }),
    stored(3, { type: 'assistant_turn', channel: 'text', jobId: 'first', text: '补充前的回答', toolCalls: [] }),
    stored(4, { type: 'user_text', channel: 'text', text: '再看实验', jobId: 'first' }),
    stored(5, { type: 'assistant_turn', channel: 'text', jobId: 'first', text: '最终分析', toolCalls: [] }),
    stored(6, { type: 'assistant_turn', channel: 'text', jobId: 'second', text: '另一项回答', toolCalls: [] }),
    stored(7, { type: 'assistant_turn', channel: 'text', text: '无法确认归属的旧回答', toolCalls: [] }),
  ];
  const first = job({ id: 'first', channel: 'text', result: '最终分析', resultEventId: 5 });
  const second = job({ id: 'second', channel: 'text', result: '另一项回答', resultEventId: 6 });
  for (const status of ['queued', 'running', 'failed', 'cancelled', 'interrupted'] as const) {
    const jobs = [{ ...first, status }, second];
    assert.deepEqual([...visibleAnswerIds(jobs, events, taskTurnOwners(jobs, events))], [6, 7]);
  }
  assert.deepEqual([...visibleAnswerIds([first, second], events, taskTurnOwners([first, second], events))], [5, 6, 7]);
  assert.equal(events.length, 7);
});

test('legacy text tasks recover a missing final ID even when display metadata already exists', () => {
  const events = [
    stored(1, { type: 'user_text', channel: 'text', text: '研究' }),
    stored(2, { type: 'assistant_turn', channel: 'text', text: '正在核对', toolCalls: [{ id: 'read', name: 'list_files', input: {} }] }),
    stored(3, { type: 'assistant_turn', channel: 'text', text: '最终分析', toolCalls: [] }),
    stored(4, { type: 'user_text', channel: 'text', text: '另一项问题' }),
    stored(5, { type: 'assistant_turn', channel: 'text', text: '独立回答', toolCalls: [] }),
  ];
  const shown = presentJob(job({ channel: 'text', task: '研究', result: '最终分析', display: 'conversation', title: '研究' }), events);
  assert.equal(shown.resultEventId, 3);
  const owners = taskTurnOwners([shown], events);
  assert.equal(owners.has(5), false);
  assert.deepEqual([...visibleAnswerIds([shown], events, owners)], [3, 5]);
});

test('chat stays out of task cards and history, including legacy greetings and failed replies', () => {
  for (const task of ['hi', '你好', 'What is a transformer?', '解释一下这个术语', '梳理论文']) {
    const foreground = job({ task, channel: 'text' });
    assert.equal(isBackgroundJob(foreground), false);
    assert.equal(isBackgroundJob({ ...foreground, status: 'failed' }), false);
    assert.deepEqual(taskLayout([foreground], []).background, []);
  }
  assert.equal(isBackgroundJob(job({ channel: 'text', display: 'background' })), true, 'Explicit background mode is independent of the input channel');
});

test('legacy task links are recovered from the right turn without rewriting history', () => {
  const events = [
    stored(1, { type: 'assistant_turn', channel: 'text', text: '原文分析结果', toolCalls: [] }, '2026-11-15T00:59:00.000Z'),
    stored(2, { type: 'user_text', channel: 'voice', text: '梳理论文，包含方法、结果和局限' }),
    stored(3, { type: 'assistant_turn', channel: 'text', text: '原文分析结果', toolCalls: [] }),
    stored(4, { type: 'call', callId: 'voice-call', startedAt: '2026-11-15T00:59:30.000Z', endedAt: '2026-11-15T01:02:00.000Z', lines: [{ who: 'user', text: '梳理论文' }] }),
  ];
  const original = job(); const shown = presentJob(original, events);
  assert.equal(shown.title, '梳理论文'); assert.equal(shown.originEventId, 2); assert.equal(shown.resultEventId, 3); assert.equal(shown.originCallId, 'voice-call');
  assert.equal(original.title, undefined); assert.equal(events.length, 4);
  assert.equal(presentJob(job({ result: '', status: 'running' }), [stored(9, { type: 'assistant_turn', channel: 'text', text: '', jobId: 'work', toolCalls: [{ id: 'tool', name: 'list_files', input: {} }] })]).resultEventId, undefined);
});

test('voice work and replies stay inside the original call, including late completion', () => {
  const jobs = [job({ id: 'call', originCallId: 'phone', resultEventId: 3 }), job({ id: 'late', originCallId: 'previous-phone', resultEventId: 7 }), job({ id: 'orphan' }), job({ id: 'chat', channel: 'text', status: 'failed', originEventId: 1 })];
  const layout = taskLayout(jobs, [{ id: 1, kind: 'user' }, { id: 2, kind: 'assistant', jobId: 'call' }, { id: 3, kind: 'assistant' }, { id: 4, kind: 'call' }, { id: 5, kind: 'assistant', jobId: 'chat' }, { id: 7, kind: 'assistant', jobId: 'late' }]);
  assert.deepEqual(layout.byCall.get('phone')?.map(job => job.id), ['call']);
  assert.deepEqual(layout.byCall.get('previous-phone')?.map(job => job.id), ['late']);
  assert.deepEqual([...layout.hidden], [2, 3, 7]);
  assert.equal(layout.hidden.has(5), false, 'Foreground replies stay in the text conversation');
  assert.deepEqual(layout.chatIssues.get(1)?.map(job => job.id), ['chat']);
  assert.equal(layout.byCall.size, 2, 'Unlinked work cannot attach to an unrelated call or message');
  assert.ok(taskTitle('请整理 AudioHijack 复现备忘录，包含环境、步骤和指标').length < 48);
});

test('legacy ownership preserves foreground chat and groups intermediate turns without changing stored events', () => {
  const events = [
    stored(1, { type: 'user_text', channel: 'voice', text: '研究' }),
    stored(2, { type: 'assistant_turn', channel: 'text', text: '正在读', toolCalls: [{ id: 'read', name: 'read_file', input: {} }] }),
    stored(3, { type: 'assistant_turn', channel: 'text', text: '完成', toolCalls: [] }),
    stored(4, { type: 'user_text', channel: 'text', text: 'hi' }),
    stored(5, { type: 'assistant_turn', channel: 'text', text: '你好', toolCalls: [] }),
    stored(6, { type: 'assistant_turn', channel: 'text', jobId: 'foreground', text: '继续', toolCalls: [] }),
    stored(7, { type: 'call', startedAt: '2026-11-15T00:59:30.000Z', endedAt: '2026-11-15T01:02:00.000Z', lines: [{ who: 'user', text: '研究' }] }),
  ];
  const shown = presentJob(job({ task: '研究', result: '完成' }), events);
  assert.equal(shown.originCallId, 'legacy-call:7', 'Calls saved before call IDs existed remain accessible');
  const owners = backgroundTurnOwners([shown], events);
  assert.equal(owners.get(2), 'work'); assert.equal(owners.get(3), 'work');
  assert.equal(owners.has(5), false); assert.equal(owners.get(6), 'foreground');
  assert.equal('jobId' in events[1]!.event, false, 'Migration is a read projection, not a history rewrite');
});
