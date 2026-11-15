import { createHash } from "node:crypto";
import type { RealtimeVoiceChoice } from "../../src/realtime-catalog.ts";

/** Account-scoped in-memory cache; credentials and authenticated HTTP remain in main. */
export class MossVoiceCatalog {
  private readonly cache = new Map<string, { at: number; voices: RealtimeVoiceChoice[] }>();
  private readonly pending = new Map<string, Promise<RealtimeVoiceChoice[]>>();
  private readonly url: string;
  private readonly fetcher: typeof fetch;
  constructor(url = process.env.XIAOWANG_MOSS_VOICES_URL || "https://api.mosi.cn/v1/audio/voices", fetcher = fetch) {
    const endpoint = new URL(url);
    if (endpoint.href !== "https://api.mosi.cn/v1/audio/voices" && (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) throw new Error("音色测试地址必须是本机服务。");
    this.url = url; this.fetcher = fetcher;
  }
  list(key: string, refresh = false): Promise<RealtimeVoiceChoice[]> {
    if (!key.trim()) return Promise.reject(new Error("先填写 MOSS 的语音密钥。"));
    const account = createHash("sha256").update(this.url).update("\0").update(key).digest("hex");
    const pending = this.pending.get(account); if (pending) return pending;
    const cached = this.cache.get(account);
    if (!refresh && cached && Date.now() - cached.at < 10 * 60_000) return Promise.resolve(cached.voices.map(voice => ({ ...voice })));
    const request = this.load(key).then(voices => {
      this.cache.delete(account); this.cache.set(account, { at: Date.now(), voices });
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      return voices.map(voice => ({ ...voice }));
    }).finally(() => this.pending.delete(account));
    this.pending.set(account, request); return request;
  }
  private async load(key: string): Promise<RealtimeVoiceChoice[]> {
    const voices = new Map<string, RealtimeVoiceChoice>(), cursors = new Set<string>();
    let cursor = "";
    // A bad cursor must not cause an unbounded request loop or silently return a partial catalog.
    for (let page = 0; page < 1000; page++) {
      const url = new URL(this.url); url.searchParams.set("limit", "150"); if (cursor) url.searchParams.set("after", cursor);
      const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: "error" });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "MOSS 音色读取失败，请检查当前账号的密钥和权限。" : `MOSS 音色读取失败（${response.status}），可稍后重试。`);
      const body = await response.json() as { data?: unknown; has_more?: boolean; next_cursor?: unknown };
      if (!Array.isArray(body.data)) throw new Error("MOSS 音色列表格式不正确。");
      for (const value of body.data) {
        if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim()) continue;
        const id = value.id.trim(), name = typeof value.name === "string" ? value.name.trim() : "";
        voices.set(id, { id, name: name || `音色 · ${id.slice(0, 12)}` });
      }
      if (!body.has_more) return [...voices.values()];
      if (typeof body.next_cursor !== "string" || !body.next_cursor || cursors.has(body.next_cursor)) throw new Error("MOSS 音色分页异常，未取得完整列表，请刷新重试。");
      cursor = body.next_cursor; cursors.add(cursor);
    }
    throw new Error("MOSS 音色分页过多，未取得完整列表，请稍后重试。");
  }
}
