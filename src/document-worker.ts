import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { extractText } from "unpdf";

try {
  const bytes = await readFile((workerData as { path: string }).path);
  const result = await extractText(new Uint8Array(bytes), { mergePages: false });
  parentPort?.postMessage({ totalPages: result.totalPages, text: result.text });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally { parentPort?.close(); }
