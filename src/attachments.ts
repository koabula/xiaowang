import path from "node:path";
import { readFileSync } from "node:fs";
import type { Store } from "./store.ts";
import type { Attachment, ModelMessage } from "./types.ts";

import { ATTACHMENT_COUNT, ATTACHMENT_BYTES, ATTACHMENT_TOTAL_BYTES } from "./attachment-limits.ts";
export { ATTACHMENT_BYTES } from "./attachment-limits.ts";
const documentTypes: Record<string, string> = { ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv", ".json": "application/json" };
export function attachmentMime(filename: string, bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (!b.length || b.length > ATTACHMENT_BYTES) throw new Error("附件不能为空，单个文件不能超过 20 MB。");
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  const type = documentTypes[path.extname(filename).toLowerCase()];
  if (!type || (type === "application/pdf" ? !b.subarray(0, 5).equals(Buffer.from("%PDF-")) : b.includes(0))) throw new Error("请选择图片（PNG、JPEG、WebP、GIF）、PDF 或文本文件（TXT、Markdown、CSV、JSON）。");
  return type;
}
export function resolveAttachments(store: Store, botId: string, ids: string[]): Attachment[] {
  if (!Array.isArray(ids) || ids.length > ATTACHMENT_COUNT || ids.some(id => typeof id !== "string")) throw new Error("每条消息最多添加 8 个附件。");
  let total = 0;
  return [...new Set(ids)].map(id => {
    const ref = store.resolveLibraryRef(botId, id);
    const mimeType = attachmentMime(ref.filename, readFileSync(ref.storedPath));
    total += ref.byteSize;
    if (total > ATTACHMENT_TOTAL_BYTES) throw new Error("每条消息的附件合计不能超过 40 MB。");
    return { refId: ref.id, filename: ref.filename, byteSize: ref.byteSize, mimeType };
  });
}
export function hydrateImages(store: Store, botId: string, messages: ModelMessage[]): ModelMessage[] {
  return messages.map(message => {
    if (!message.attachments?.some(a => a.mimeType.startsWith("image/"))) return message;
    const removed: string[] = [];
    const images = message.attachments.filter(a => a.mimeType.startsWith("image/")).flatMap(a => {
      try {
        const ref = store.resolveLibraryRef(botId, a.refId), bytes = readFileSync(ref.storedPath);
        return [{ mimeType: attachmentMime(ref.filename, bytes), data: bytes.toString("base64") }];
      } catch { removed.push(a.filename); return []; } // Never expose another bot's file.
    });
    return { ...message, images: [...(message.images ?? []), ...images], content: message.content + (removed.length ? `\n这些图片已移除，当前无法查看，不要假装已看过：${removed.join("、")}` : "") };
  });
}
