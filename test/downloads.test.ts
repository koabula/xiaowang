import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DownloadItem } from "electron";
import { readDownloadBody } from "../src/downloads.ts";
import { receiveDownload } from "../desktop/main/downloads.ts";

function response(bytes: number, headers: Record<string, string> = {}) {
  const state = { received: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.received === bytes) { controller.close(); return; }
      const length = Math.min(1024, bytes - state.received); state.received += length; controller.enqueue(new Uint8Array(length).fill(65));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, value: new Response(stream, { headers }) };
}

test("download bodies reject oversized headers before reading and stop unknown lengths at the limit", async () => {
  const known = response(8192, { "content-length": "8192" });
  await assert.rejects(readDownloadBody(known.value, { limit: 4096 }), /超过/);
  assert.deepEqual(known.state, { received: 0, cancelled: true });
  const unknown = response(8192);
  await assert.rejects(readDownloadBody(unknown.value, { limit: 4096 }), /超过/);
  assert.deepEqual(unknown.state, { received: 5120, cancelled: true });
  const exact = response(4096);
  assert.equal((await readDownloadBody(exact.value, { limit: 4096 })).length, 4096);
  const decoded = response(1024, { "content-length": "8192", "content-encoding": "gzip" });
  assert.equal((await readDownloadBody(decoded.value, { limit: 4096 })).length, 1024, "Compressed metadata must not be mistaken for decoded file size");
  const error = new Response("unavailable", { status: 503 });
  await assert.rejects(readDownloadBody(error), /HTTP 503/);
});

test("aborting a pending download cancels its reader and preserves the abort error", async () => {
  let cancelled = false;
  const value = new Response(new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  const controller = new AbortController(), reading = readDownloadBody(value, { signal: controller.signal });
  controller.abort(); await assert.rejects(reading, { name: "AbortError" }); assert.equal(cancelled, true);
  const pre = response(4096); const stopped = new AbortController(); stopped.abort();
  await assert.rejects(readDownloadBody(pre.value, { signal: stopped.signal }), { name: "AbortError" });
  assert.deepEqual(pre.state, { received: 0, cancelled: true });
});

class Item extends EventEmitter {
  file = ""; total = 0; received = 0; cancelled = 0;
  setSavePath(file: string) { this.file = file; }
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  cancel() { this.cancelled++; this.emit("done", {}, "cancelled"); }
}

test("download temporary files are removed after success, cancellation, interruption and import failure", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "xw-download-cleanup-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const state of ["completed", "cancelled", "interrupted", "import-error"]) {
    const item = new Item(), errors: unknown[] = []; let imported = false;
    const task = receiveDownload(item as unknown as DownloadItem, { temporaryRoot: root, limit: 4096,
      onComplete(bytes) { imported = true; assert.equal(bytes.toString(), "original"); if (state === "import-error") throw new Error("Import failed"); },
      onError(error) { errors.push(error); },
    });
    writeFileSync(item.file, "original"); item.emit("done", {}, state === "import-error" ? "completed" : state); await task.done;
    assert.equal(imported, ["completed", "import-error"].includes(state)); assert.equal(errors.length, state === "import-error" ? 1 : 0);
    assert.deepEqual(readdirSync(root), []);
  }
});

test("browser download limits cover declared length, progress and final file size without importing oversized data", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "xw-download-limits-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const stage of ["header", "progress", "final"]) {
    const item = new Item(), errors: unknown[] = []; let imported = false;
    if (stage === "header") item.total = 8192;
    const task = receiveDownload(item as unknown as DownloadItem, { temporaryRoot: root, limit: 4096, onComplete() { imported = true; }, onError(error) { errors.push(error); } });
    if (stage !== "header") { writeFileSync(item.file, Buffer.alloc(8192)); if (stage === "progress") { item.received = 8192; item.emit("updated", {}, "progressing"); } else item.emit("done", {}, "completed"); }
    await task.done; assert.equal(imported, false); assert.equal(errors.length, 1); assert.match(String(errors[0]), /超过/); assert.deepEqual(readdirSync(root), []);
  }
});

test("shutdown waits for completed imports and cleanup without cancelling a finished native item", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "xw-download-stop-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const item = new Item(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const task = receiveDownload(item as unknown as DownloadItem, { temporaryRoot: root, onComplete: async () => { entered(); await gate; }, onError(error) { throw error; } });
  writeFileSync(item.file, "original"); item.emit("done", {}, "completed"); await started;
  const stopped = task.cancel(); release(); await stopped;
  assert.equal(item.cancelled, 0); assert.deepEqual(readdirSync(root), []);
});
