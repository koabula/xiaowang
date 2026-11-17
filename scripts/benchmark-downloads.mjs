import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readDownloadBody } from '../src/downloads.ts';
import { LIBRARY_BYTE_CAP } from '../src/library-limits.ts';

const MiB = 1024 * 1024, total = 96 * MiB;
function fixture(declared) {
  const state = { received: 0, cancelled: false };
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (state.received === total) { controller.close(); return; }
      state.received += MiB; controller.enqueue(new Uint8Array(MiB).fill(65));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 }), { headers: declared ? { 'content-length': String(total) } : {} });
  return { response, state };
}
// Exact former capturePdf body path: read everything, then let the library reject it.
async function wholeResponse(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > LIBRARY_BYTE_CAP) throw new Error('文件超过上限');
  return bytes;
}
const results = {};
for (const [name, declared] of [['declaredLength', true], ['unknownLength', false]]) {
  results[name] = {};
  for (const [version, read] of [['before', wholeResponse], ['after', readDownloadBody]]) {
    const { response, state } = fixture(declared), start = performance.now();
    await assert.rejects(read(response), /超过/);
    results[name][version] = { bodyBytesRead: state.received, cancelled: state.cancelled, elapsedMs: performance.now() - start };
  }
}
console.log(JSON.stringify({ fileBytes: total, limitBytes: LIBRARY_BYTE_CAP, chunkBytes: MiB, results }, null, 2));
