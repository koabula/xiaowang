import type { DownloadItem } from "electron";
import { mkdtempSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { LIBRARY_BYTE_CAP, librarySizeError } from "../../src/library-limits.ts";

export interface DownloadTask { done: Promise<void>; cancel(): Promise<void> }

/** Import only completed, bounded files; own and clean one temporary directory per download. */
export function receiveDownload(item: DownloadItem, options: {
  temporaryRoot: string;
  onComplete: (bytes: Buffer) => void | Promise<void>;
  onError: (error: unknown) => void;
  limit?: number;
}): DownloadTask {
  const limit = options.limit ?? LIBRARY_BYTE_CAP;
  const directory = mkdtempSync(path.join(options.temporaryRoot, "xiaowang-download-")), file = path.join(directory, "download");
  let terminal = false, oversize = 0, resolve!: () => void;
  const done = new Promise<void>(finished => { resolve = finished; });
  const checkSize = () => {
    const bytes = Math.max(item.getTotalBytes(), item.getReceivedBytes());
    if (bytes <= limit || oversize) return;
    oversize = bytes; item.cancel();
  };
  const finish = async (state: string) => {
    terminal = true; item.removeListener("updated", checkSize);
    try {
      if (oversize) throw new Error(librarySizeError(oversize, limit));
      if (state !== "completed") return;
      const info = await stat(file);
      if (info.size > limit) throw new Error(librarySizeError(info.size, limit));
      await options.onComplete(await readFile(file));
    } catch (error) { options.onError(error); }
    finally {
      try { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { options.onError(error); }
      resolve();
    }
  };
  item.once("done", (_event, state) => { void finish(state); });
  item.on("updated", checkSize);
  try { item.setSavePath(file); checkSize(); }
  catch (error) { options.onError(error); if (!terminal) item.cancel(); }
  return { done, cancel() { if (!terminal) item.cancel(); return done; } };
}
