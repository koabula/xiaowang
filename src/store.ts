import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STEWARD_SLUG, stewardPrompt } from "./persona.ts";
import { APP_ICON_INK, APP_ICON_NAME } from "./beam.ts";
import { MEMORY_TYPES } from "./memory.ts";
import type { Bot, SessionEvent, StoredEvent, Term } from "./types.ts";

interface BotRow {
  id: string;
  slug: string;
  name: string;
  system_prompt: string;
  glossary_json: string;
  workspace_dir: string;
  parent_bot_id: string | null;
  avatar_seed: string;
  avatar_ink: string;
  created_at: string;
}

interface EventRow {
  id: number;
  bot_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XIAOWANG_HOME?.trim();
  if (configured) return path.resolve(configured);
  return path.join(homedir(), ".xiaowang");
}

/**
 * 每个 Bot 一条只追加的事件流，外加 Bot 注册表。
 * 这里没有更新或删除事件的方法：记忆只增不改。
 */
export class Store {
  readonly home: string;
  private readonly db: DatabaseSync;

  private constructor(home: string, db: DatabaseSync) {
    this.home = home;
    this.db = db;
  }

  static open(home: string): Store {
    mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(path.join(home, "xiaowang.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        glossary_json TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        parent_bot_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_bot
        ON session_events (bot_id, id);
      CREATE TABLE IF NOT EXISTS library_files (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        byte_size INTEGER NOT NULL,
        stored_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_file_refs (
        bot_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, file_id)
      );
    `);
    const memoryTypes = MEMORY_TYPES.map(type => `'${type}'`).join(",");
    const memoryTextSql = (prefix: string) => `CASE ${prefix}type
      WHEN 'user_text' THEN coalesce(json_extract(${prefix}payload_json, '$.text'), '') || char(10) || coalesce(json_extract(${prefix}payload_json, '$.attachments'), '')
      WHEN 'assistant_turn' THEN coalesce(json_extract(${prefix}payload_json, '$.text'), '') || char(10) || coalesce(json_extract(${prefix}payload_json, '$.toolCalls'), '')
      WHEN 'tool_result' THEN json_extract(${prefix}payload_json, '$.output')
      WHEN 'voice_line' THEN json_extract(${prefix}payload_json, '$.text')
      WHEN 'call' THEN (SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(${prefix}payload_json, '$.lines'))
      WHEN 'baseline' THEN json_extract(${prefix}payload_json, '$.text')
      WHEN 'artifact' THEN json_extract(${prefix}payload_json, '$.path')
      WHEN 'context_state' THEN json_extract(${prefix}payload_json, '$.message.content') ELSE '' END`;
    const memoryVersion = db.prepare("SELECT value FROM meta WHERE key = 'memory_index_version'").get() as { value: string } | undefined;
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(event_id UNINDEXED, bot_id UNINDEXED, event_type UNINDEXED, search_text, tokenize='trigram');
    `);
    if (memoryVersion?.value !== "2") db.exec("DROP TRIGGER IF EXISTS memory_fts_insert; DELETE FROM memory_fts;");
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON session_events
      WHEN new.type IN (${memoryTypes}) BEGIN
        INSERT INTO memory_fts(rowid, event_id, bot_id, event_type, search_text)
        VALUES(new.id, new.id, new.bot_id, new.type, ${memoryTextSql("new.")});
      END;
      INSERT INTO memory_fts(rowid, event_id, bot_id, event_type, search_text)
      SELECT id, id, bot_id, type, ${memoryTextSql("")} FROM session_events
      WHERE type IN (${memoryTypes}) AND id NOT IN (SELECT rowid FROM memory_fts);
      INSERT INTO meta(key, value) VALUES('memory_index_version', '2') ON CONFLICT(key) DO UPDATE SET value='2';
    `);
    const columns = db.prepare("PRAGMA table_info(bots)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "avatar_seed")) {
      db.exec("ALTER TABLE bots ADD COLUMN avatar_seed TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === "avatar_ink")) {
      db.exec("ALTER TABLE bots ADD COLUMN avatar_ink TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some(column => column.name === "deleted_at")) db.exec("ALTER TABLE bots ADD COLUMN deleted_at TEXT");
    return new Store(home, db);
  }

  close(): void {
    this.db.close();
  }

  createBot(input: {
    name: string;
    systemPrompt: string;
    glossary?: Term[];
    parentBotId?: string | null;
    slug?: string;
  }): Bot {
    const name = input.name.trim();
    if (!name) throw new Error("Bot 名字不能为空。");
    const slug = input.slug ? this.claimSlug(input.slug) : this.uniqueSlug(slugify(name));
    const workspaceDir = path.join(this.home, "bots", slug, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const bot: Bot = {
      id: `bot_${randomBytes(8).toString("hex")}`,
      slug,
      name,
      systemPrompt: input.systemPrompt.trim(),
      glossary: normalizeTerms(input.glossary ?? []),
      workspaceDir,
      parentBotId: input.parentBotId ?? null,
      avatarSeed: slug === STEWARD_SLUG ? APP_ICON_NAME : "",
      avatarInk: slug === STEWARD_SLUG ? APP_ICON_INK : "",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO bots (
          id, slug, name, system_prompt, glossary_json, workspace_dir, parent_bot_id, avatar_seed, avatar_ink, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bot.id,
        bot.slug,
        bot.name,
        bot.systemPrompt,
        JSON.stringify(bot.glossary),
        bot.workspaceDir,
        bot.parentBotId,
        bot.avatarSeed,
        bot.avatarInk,
        bot.createdAt,
      );
    return bot;
  }

  listBots(): Bot[] {
    const rows = this.db
      .prepare("SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY created_at ASC, slug ASC")
      .all() as unknown as BotRow[];
    return rows.map(rowToBot);
  }

  getBot(idOrSlug: string): Bot | null {
    const row = this.db
      .prepare("SELECT * FROM bots WHERE (id = ? OR slug = ?) AND deleted_at IS NULL LIMIT 1")
      .get(idOrSlug, idOrSlug) as BotRow | undefined;
    return row ? rowToBot(row) : null;
  }

  requireBot(idOrSlug: string): Bot {
    const bot = this.getBot(idOrSlug);
    if (!bot) {
      const names = this.listBots()
        .map((item) => item.slug)
        .join("、");
      throw new Error(`没有这个 Bot：${idOrSlug}。现有：${names || "（空）"}`);
    }
    return bot;
  }

  updateGlossary(botId: string, terms: Term[]): Term[] {
    const bot = this.requireBot(botId);
    const merged = mergeTerms(bot.glossary, terms);
    this.db.prepare("UPDATE bots SET glossary_json = ? WHERE id = ?").run(JSON.stringify(merged), bot.id);
    return merged;
  }

  renameBot(idOrSlug: string, name: string): Bot {
    const bot = this.requireBot(idOrSlug);
    const next = name.trim();
    if (!next) throw new Error("名字不能为空。");
    if (next.length > 80) throw new Error("名字请控制在 80 字以内。");
    if (bot.slug === STEWARD_SLUG) {
      this.db.prepare("UPDATE bots SET name = ?, system_prompt = ? WHERE id = ?").run(next, stewardPrompt(next), bot.id);
    } else {
      this.db.prepare("UPDATE bots SET name = ? WHERE id = ?").run(next, bot.id);
    }
    return this.requireBot(bot.id);
  }

  /** Tombstone the bot atomically. Keep local files and append-only history for
   * recovery, but revoke all normal application access and never reuse its slug. */
  deleteBot(idOrSlug: string): void {
    const bot = this.requireBot(idOrSlug);
    if (bot.slug === STEWARD_SLUG) throw new Error("不能删除主助手。");
    const steward = this.requireBot(STEWARD_SLUG);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE bots SET parent_bot_id = ? WHERE parent_bot_id = ?").run(steward.id, bot.id);
      if (this.getActiveBotId() === bot.id) this.setActiveBot(steward.id);
      this.db.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), bot.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  setAvatar(idOrSlug: string, patch: { seed?: string; ink?: string }): Bot {
    const bot = this.requireBot(idOrSlug);
    let seed = bot.avatarSeed;
    let ink = bot.avatarInk;
    if (patch.seed !== undefined) {
      const next = patch.seed.trim();
      if (next && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next)) throw new Error("这张头像暂时不能用。");
      seed = next;
    }
    if (patch.ink !== undefined) {
      const next = patch.ink.trim().toUpperCase();
      if (next && !/^#[0-9A-F]{6}$/.test(next)) throw new Error("请从给出的颜色里选。");
      ink = next;
    }
    this.db.prepare("UPDATE bots SET avatar_seed = ?, avatar_ink = ? WHERE id = ?").run(seed, ink, bot.id);
    return this.requireBot(bot.id);
  }

  setAvatarSeed(idOrSlug: string, seed: string): Bot {
    return this.setAvatar(idOrSlug, { seed });
  }

  forgetLibraryRef(botId: string, nameOrId: string): void {
    const bot = this.requireBot(botId);
    const ref = this.resolveLibraryRef(bot.id, nameOrId);
    this.db.prepare("DELETE FROM bot_file_refs WHERE bot_id = ? AND file_id = ?").run(bot.id, ref.id);
  }

  append(botId: string, event: SessionEvent): StoredEvent {
    this.requireBot(botId);
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO session_events (bot_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(botId, event.type, JSON.stringify(event), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      botId,
      createdAt,
      event,
    };
  }

  getEvents(botId: string, options?: { afterId?: number; limit?: number }): StoredEvent[] {
    this.requireBot(botId);
    const afterId = options?.afterId ?? 0;
    const rows =
      options?.limit === undefined
        ? (this.db
            .prepare(
              "SELECT * FROM session_events WHERE bot_id = ? AND id > ? ORDER BY id ASC",
            )
            .all(botId, afterId) as unknown as EventRow[])
        : (this.db
            .prepare(
              "SELECT * FROM session_events WHERE bot_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
            )
            .all(botId, afterId, options.limit) as unknown as EventRow[]);
    return rows.map((row) => ({
      id: Number(row.id),
      botId: row.bot_id,
      createdAt: row.created_at,
      event: JSON.parse(row.payload_json) as SessionEvent,
    }));
  }

  memoryEvent(botId: string, eventId: number): StoredEvent {
    this.requireBot(botId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error("事件编号必须是正整数。");
    const row = this.db.prepare("SELECT * FROM session_events WHERE bot_id = ? AND id = ?").get(botId, eventId) as EventRow | undefined;
    if (!row || !(MEMORY_TYPES as readonly string[]).includes(row.type)) throw new Error("当前 bot 没有可读取的这条历史事件。");
    return { id: row.id, botId: row.bot_id, createdAt: row.created_at, event: JSON.parse(row.payload_json) as SessionEvent };
  }

  searchMemory(botId: string, query: string, options: { types?: string[]; afterId?: number; limit?: number } = {}) {
    this.requireBot(botId);
    query = query.trim();
    if (!query || query.length > 256) throw new Error("搜索词需为 1–256 个字符。");
    const types = options.types?.length ? options.types : [...MEMORY_TYPES];
    if (types.some(type => !(MEMORY_TYPES as readonly string[]).includes(type))) throw new Error("不支持的历史事件类型。");
    const limit = options.limit ?? 10, afterId = options.afterId ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(afterId) || afterId < 0) throw new Error("历史检索分页参数无效。");
    const match = [...query].length >= 3;
    const predicate = match ? "memory_fts MATCH ?" : "instr(lower(search_text), lower(?)) > 0";
    const term = match ? `"${query.replaceAll('"', '""')}"` : query;
    const rows = this.db.prepare(`SELECT event_id, event_type, ${match ? "snippet(memory_fts, 3, '', '', ' … ', 36)" : "substr(search_text, max(1, instr(lower(search_text), lower(?)) - 70), 240)"} AS excerpt
      FROM memory_fts WHERE bot_id = ? AND event_id > ? AND event_type IN (${types.map(() => "?").join(",")}) AND ${predicate}
      ORDER BY event_id ASC LIMIT ?`).all(...(match ? [] : [query]), botId, afterId, ...types, term, limit) as Array<{ event_id: number; event_type: string; excerpt: string }>;
    return rows.map(row => ({ eventId: row.event_id, type: row.event_type, excerpt: row.excerpt.slice(0, 500) }));
  }

  getActiveBotId(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'active_bot'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setActiveBot(botId: string): void {
    const bot = this.requireBot(botId);
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('active_bot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(bot.id);
  }

  listLibrary(botId: string): LibraryRef[] {
    this.requireBot(botId);
    const rows = this.db
      .prepare(
        `SELECT f.id, f.sha256, r.filename, f.byte_size, f.stored_path, r.created_at
         FROM bot_file_refs r
         JOIN library_files f ON f.id = r.file_id
         WHERE r.bot_id = ?
         ORDER BY r.created_at ASC, f.id ASC`,
      )
      .all(botId) as unknown as LibraryRow[];
    return rows.map(rowToLibraryRef);
  }

  resolveLibraryRef(botId: string, query: string): LibraryRef {
    const name = query.trim();
    if (!name) throw new Error("请给出资料库中的文件 id 或文件名。");
    const refs = this.listLibrary(botId);
    const byId = refs.find((item) => item.id === name);
    if (byId) return byId;
    // Accept the exact legacy catalog label, without accepting arbitrary suffixes
    // or a reference belonging to another workspace.
    const byLabel = refs.find(item => name === `${item.id} ${item.filename}` || name === `${item.id}\t${item.filename}`);
    if (byLabel) return byLabel;
    const matches = refs.filter((item) => item.filename === name || item.filename.toLowerCase() === name.toLowerCase());
    if (matches.length === 1) return matches[0] as LibraryRef;
    if (matches.length > 1) {
      throw new Error(`有多份同名文件。请改用 id：${matches.map((item) => item.id).join("、")}`);
    }
    const hint = refs.length === 0 ? "这个项目的资料库是空的。" : `当前项目已引用：${refs.map((item) => `${item.id} ${item.filename}`).join("、")}`;
    throw new Error(`当前项目没有这份原件：${name}。${hint}`);
  }

  addLibraryBytes(botId: string, filename: string, bytes: Buffer): LibraryAddResult {
    this.requireBot(botId);
    if (bytes.length > LIBRARY_BYTE_CAP) {
      throw new Error(`文件有 ${bytes.length} 字节，超过 ${LIBRARY_BYTE_CAP} 字节。`);
    }
    const display = displayFilename(filename);
    if (isSensitiveName(display)) throw new Error(`拒绝把 ${display} 放进资料库。`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.prepare("SELECT * FROM library_files WHERE sha256 = ?").get(sha256) as
      | LibraryFileRow
      | undefined;
    if (existing) {
      const referenced = this.db
        .prepare("SELECT filename FROM bot_file_refs WHERE bot_id = ? AND file_id = ?")
        .get(botId, existing.id) as { filename: string } | undefined;
      if (referenced) {
        return {
          ref: rowToLibraryRef({ ...existing, filename: referenced.filename, created_at: existing.created_at }),
          deduped: true,
          alreadyReferenced: true,
        };
      }
      const createdAt = new Date().toISOString();
      this.db
        .prepare("INSERT INTO bot_file_refs (bot_id, file_id, filename, created_at) VALUES (?, ?, ?, ?)")
        .run(botId, existing.id, display, createdAt);
      return {
        ref: rowToLibraryRef({ ...existing, filename: display, created_at: createdAt }),
        deduped: true,
        alreadyReferenced: false,
      };
    }

    const id = this.newFileId();
    const createdAt = new Date().toISOString();
    const storedPath = path.join(this.home, "library", sha256, storedFilename(display));
    mkdirSync(path.dirname(storedPath), { recursive: true });
    writeFileSync(storedPath, bytes);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO library_files (id, sha256, byte_size, stored_path, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, sha256, bytes.length, storedPath, createdAt);
      this.db
        .prepare("INSERT INTO bot_file_refs (bot_id, file_id, filename, created_at) VALUES (?, ?, ?, ?)")
        .run(botId, id, display, createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      ref: { id, sha256, filename: display, byteSize: bytes.length, storedPath, createdAt },
      deduped: false,
      alreadyReferenced: false,
    };
  }

  shareLibraryFile(fromBotId: string, query: string, toBotId: string): LibraryRef {
    const source = this.resolveLibraryRef(fromBotId, query);
    const target = this.requireBot(toBotId);
    if (target.id === fromBotId) return source;
    const existing = this.db
      .prepare("SELECT 1 AS ok FROM bot_file_refs WHERE bot_id = ? AND file_id = ?")
      .get(target.id, source.id) as { ok: number } | undefined;
    if (!existing) {
      this.db
        .prepare("INSERT INTO bot_file_refs (bot_id, file_id, filename, created_at) VALUES (?, ?, ?, ?)")
        .run(target.id, source.id, source.filename, new Date().toISOString());
    }
    return this.resolveLibraryRef(target.id, source.id);
  }

  countLibraryFiles(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM library_files").get() as { n: number };
    return Number(row.n);
  }

  private newFileId(): string {
    for (let i = 0; i < 5; i += 1) {
      const id = `f_${randomBytes(4).toString("hex")}`;
      const existing = this.db.prepare("SELECT 1 AS ok FROM library_files WHERE id = ?").get(id) as
        | { ok: number }
        | undefined;
      if (!existing) return id;
    }
    return `f_${randomBytes(8).toString("hex")}`;
  }

  private claimSlug(slug: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`slug 只能是小写字母、数字和连字符：${slug}`);
    }
    if (this.db.prepare("SELECT 1 FROM bots WHERE slug = ?").get(slug)) throw new Error(`slug 已被占用：${slug}`);
    return slug;
  }

  private uniqueSlug(base: string): string {
    let slug = base;
    let n = 2;
    while (this.db.prepare("SELECT 1 FROM bots WHERE slug = ?").get(slug)) {
      slug = `${base}-${n}`;
      n += 1;
    }
    return slug;
  }
}

export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (ascii.length >= 2) return ascii;
  return `bot-${randomBytes(3).toString("hex")}`;
}

function rowToBot(row: BotRow): Bot {
  let glossary: Term[] = [];
  try {
    const parsed = JSON.parse(row.glossary_json) as unknown;
    if (Array.isArray(parsed)) glossary = normalizeTerms(parsed as Term[]);
  } catch {
    glossary = [];
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    systemPrompt: row.system_prompt,
    glossary,
    workspaceDir: row.workspace_dir,
    parentBotId: row.parent_bot_id,
    avatarSeed: row.avatar_seed ?? "",
    avatarInk: row.avatar_ink ?? "",
    createdAt: row.created_at,
  };
}

export function normalizeTerms(terms: Term[]): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const term of terms) {
    const name = term.term?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const alias = term.alias?.trim();
    out.push(alias ? { term: name, alias } : { term: name });
  }
  return out;
}

export interface LibraryRef {
  id: string;
  sha256: string;
  filename: string;
  byteSize: number;
  storedPath: string;
  createdAt: string;
}

export interface LibraryAddResult {
  ref: LibraryRef;
  deduped: boolean;
  alreadyReferenced: boolean;
}

interface LibraryFileRow {
  id: string;
  sha256: string;
  byte_size: number;
  stored_path: string;
  created_at: string;
}

interface LibraryRow extends LibraryFileRow {
  filename: string;
}

const LIBRARY_BYTE_CAP = 80 * 1024 * 1024;

function rowToLibraryRef(row: LibraryRow): LibraryRef {
  return {
    id: row.id,
    sha256: row.sha256,
    filename: row.filename,
    byteSize: Number(row.byte_size),
    storedPath: row.stored_path,
    createdAt: row.created_at,
  };
}

function displayFilename(filename: string): string {
  const base = path.basename(filename).replace(/[\0\r\n]/g, "").trim();
  if (!base || base === "." || base === "..") return "file";
  return base.slice(0, 180);
}

function storedFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
  return ext ? `original${ext}` : "original";
}

function isSensitiveName(filename: string): boolean {
  const base = filename.toLowerCase();
  return base === ".env" || base.startsWith(".env.") || base === "id_rsa" || base.endsWith(".pem");
}

function mergeTerms(existing: Term[], incoming: Term[]): Term[] {
  const map = new Map<string, Term>();
  for (const term of existing) map.set(term.term.toLowerCase(), term);
  for (const term of normalizeTerms(incoming)) map.set(term.term.toLowerCase(), term);
  return [...map.values()];
}
