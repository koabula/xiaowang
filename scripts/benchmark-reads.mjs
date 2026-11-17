import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.ts';
import { JobQueue } from '../src/jobs.ts';
import { messagePreview } from '../src/message-preview.ts';

const directory = path.resolve(process.argv[2] ?? '/tmp/xiaowang-read-benchmark');
await fs.mkdir(directory, { recursive: true });
const store = Store.open(path.join(directory, 'home'));
const manifest = path.join(directory, 'fixture.json');
let fixture;
try { fixture = JSON.parse(await fs.readFile(manifest, 'utf8')); } catch {
  const bots = [];
  for (let b = 0; b < 10; b++) {
    const bot = store.createBot({ name: `研究 ${b}`, systemPrompt: 'fixture' }); bots.push(bot.id);
    for (let i = 0; i < 1000; i++) store.append(bot.id, i % 3 === 0
      ? { type: 'user_text', channel: 'text', text: `实验 ${i}：只比较正式样本，保留来源页码。` }
      : i % 3 === 1 ? { type: 'assistant_turn', channel: 'text', text: `## 结论 ${i}\n\n**正式实验** [来源](https://example.com)`, toolCalls: [] }
        : { type: 'tool_result', callId: `call-${i}`, name: 'read_document', output: '原始实验结果。'.repeat(20), isError: false });
  }
  const queue = new JobQueue(store, async () => ({ text: '' }));
  const empty = queue.enqueue({ botId: bots[0], task: '没有补充的任务' });
  const supplemented = queue.enqueue({ botId: bots[0], task: '已有补充的任务' });
  queue.supplement(supplemented.id, { botId: bots[0], task: '仅比较正式实验' });
  queue.supplement(supplemented.id, { botId: bots[0], task: '列出样本量和第七页依据' });
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], kids = [];
  for (let n = 1; n <= 40; n++) {
    const id = objects.length + 1; kids.push(`${id} 0 R`);
    const content = `BT /F1 18 Tf 72 720 Td (EXPERIMENT-PAGE-${n}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 40 >>`;
  objects.push(`<< /Length 8388608 >>\nstream\n${' '.repeat(8 * 1024 * 1024)}\nendstream`);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const bytes = Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const ref = store.addLibraryBytes(bots[0], 'forty-pages.pdf', bytes).ref;
  fixture = { bots, empty: empty.id, supplemented: supplemented.id, ref, pdfHash: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(manifest, JSON.stringify(fixture));
}
const queue = new JobQueue(store, async () => ({ text: '' }));
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(action, count = 31) {
  for (let i = 0; i < 5; i++) action();
  const durations = []; let result;
  for (let i = 0; i < count; i++) { const start = performance.now(); result = action(); durations.push(performance.now() - start); }
  return { medianMs: median(durations), result };
}
const legacyPreview = botId => {
  const events = store.getEvents(botId);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i].event;
    if ((event.type === 'user_text' || event.type === 'assistant_turn') && (event.text.trim() || event.type === 'user_text' && event.attachments?.length))
      return messagePreview(event.text) || (event.type === 'user_text' && event.attachments?.length ? event.attachments.map(a => a.filename).join('、') : '还没有对话');
  }
  return '还没有对话';
};
const optimized = typeof store.latestMessage === 'function';
const preview = optimized ? botId => {
  const stored = store.latestMessage(botId), event = stored?.event;
  return event ? messagePreview(event.text) || (event.type === 'user_text' && event.attachments?.length ? event.attachments.map(a => a.filename).join('、') : '还没有对话') : '还没有对话';
} : legacyPreview;
let returned = 0;
for (const name of ['getEvents', 'eventsByIds', 'latestMessage']) if (typeof store[name] === 'function') {
  const method = store[name].bind(store);
  store[name] = (...args) => { const result = method(...args); returned += Array.isArray(result) ? result.length : result ? 1 : 0; return result; };
}
const sidebar = measure(() => fixture.bots.map(preview)); returned = 0; fixture.bots.map(preview); sidebar.eventsReturned = returned;
assert.deepEqual(sidebar.result, fixture.bots.map(legacyPreview)); delete sidebar.result;
const supplements = {};
for (const [name, id] of [['none', fixture.empty], ['two', fixture.supplemented]]) {
  supplements[name] = measure(() => queue.updates(id)); returned = 0; queue.updates(id); supplements[name].eventsReturned = returned;
  assert.equal(supplements[name].result.events.length, name === 'none' ? 0 : 2); delete supplements[name].result;
}
let fullReads = 0, bytesRead = 0;
const originalRead = fs.readFile;
fs.readFile = async (file, ...args) => { const result = await originalRead(file, ...args); if (String(file) === fixture.ref.storedPath) { fullReads++; bytesRead += result.byteLength; } return result; };
syncBuiltinESMExports();
const { readReferencedDocument } = await import('../src/documents.ts');
await readReferencedDocument(fixture.ref); fullReads = 0; bytesRead = 0;
const durations = [], digest = createHash('sha256');
for (let n = 1; n <= 40; n++) {
  const start = performance.now(); const text = await readReferencedDocument(fixture.ref, { startPage: n }); durations.push(performance.now() - start);
  assert.ok(text.includes(`EXPERIMENT-PAGE-${n}`)); digest.update(text);
}
const pdf = { medianMs: median(durations), mainThreadFullReads: fullReads, mainThreadBytesRead: bytesRead, outputHash: digest.digest('hex') };
fs.readFile = originalRead; syncBuiltinESMExports(); store.close();
console.log(JSON.stringify({ fixture: { bots: 10, historyEvents: 10000, pdfPages: 40, pdfHash: fixture.pdfHash }, sidebar, supplements, pdf }, null, 2));
