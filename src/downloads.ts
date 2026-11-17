import { LIBRARY_BYTE_CAP, librarySizeError } from "./library-limits.ts";

/** Bound decoded file bytes even when Content-Length is absent or compressed. */
export async function readDownloadBody(response: Response, options: { signal?: AbortSignal; limit?: number } = {}): Promise<Buffer> {
  const limit = options.limit ?? LIBRARY_BYTE_CAP, signal = options.signal;
  const encoding = response.headers.get("content-encoding"), length = Number(response.headers.get("content-length"));
  if (!response.ok || (!encoding || encoding === "identity") && length > limit) {
    await response.body?.cancel();
    throw new Error(response.ok ? librarySizeError(length, limit) : `下载失败（HTTP ${response.status}）。`);
  }
  if (signal?.aborted) { await response.body?.cancel(signal.reason); signal.throwIfAborted(); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error(librarySizeError(bytes, limit));
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
}
