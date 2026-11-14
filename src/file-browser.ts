import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveInsideWorkspace } from "./workspace.ts";
import type { LibraryRef } from "./store.ts";

export interface FileEntry {
  key: string; name: string; path: string; source: "library" | "workspace";
  kind: "folder" | "file"; byteSize: number; modifiedAt: string; refId?: string;
  preview: "canvas" | "file" | "unsupported";
}
export interface BrowseOptions {
  source: "all" | "library" | "workspace"; path?: string; query?: string; offset?: number;
  type?: "all" | "canvas"; sort?: "name" | "modified" | "size"; recentKeys?: string[];
}
export interface BrowseResult { entries: FileEntry[]; total: number; truncated: boolean }
const preview = (name: string): FileEntry["preview"] => /\.html?$/i.test(name) ? "canvas" : /\.(pdf|md|markdown|txt|csv|json|jsonl)$/i.test(name) ? "file" : "unsupported";

/** One inventory merges referenced originals with generated files, scoped to a single bot. */
export async function browseBotFiles(root: string, references: LibraryRef[], options: BrowseOptions): Promise<BrowseResult> {
  const entries: FileEntry[] = []; const query = String(options.query || "").trim().toLocaleLowerCase();
  let visited = 0; let truncated = false;
  const recent = Array.isArray(options.recentKeys) ? options.recentKeys.slice(0, 40).filter(key => typeof key === "string") : null;
  const accept = (entry: FileEntry) => {
    if (options.type === "canvas" && entry.kind === "file" && entry.preview !== "canvas") return;
    if (query && !`${entry.name} ${entry.path}`.toLocaleLowerCase().includes(query)) return;
    if (recent && !recent.includes(entry.key)) return;
    entries.push(entry);
  };
  if (options.source !== "workspace") for (const ref of references) accept({ key: `library:${ref.id}`, refId: ref.id, name: ref.filename, path: ref.filename, source: "library", kind: "file", byteSize: ref.byteSize, modifiedAt: ref.createdAt, preview: preview(ref.filename) });
  const entryAt = async (relative: string): Promise<FileEntry | null> => {
    const resolved = resolveInsideWorkspace(root, relative);
    if (!resolved.ok) throw new Error(resolved.error);
    const info = await stat(resolved.abs); if (!info.isDirectory() && !info.isFile()) return null;
    return { key: `workspace:${resolved.rel}`, name: path.basename(resolved.rel), path: resolved.rel, source: "workspace", kind: info.isDirectory() ? "folder" : "file", byteSize: info.size, modifiedAt: info.mtime.toISOString(), preview: preview(resolved.rel) };
  };
  if (options.source !== "library") {
    if (recent) {
      for (const key of recent) {
        if (!key.startsWith("workspace:")) continue;
        try { const entry = await entryAt(key.slice(10)); if (entry) accept(entry); } catch { /* A recent file may have been removed. */ }
      }
    } else {
      const directory = String(options.path || "."); const resolved = resolveInsideWorkspace(root, directory);
      if (!resolved.ok) throw new Error(resolved.error);
      const walk = async (relative: string): Promise<void> => {
        const folder = resolveInsideWorkspace(root, relative); if (!folder.ok) return;
        for (const item of await readdir(folder.abs, { withFileTypes: true })) {
          if (++visited > 10_000 && query) { truncated = true; return; }
          if (item.isSymbolicLink()) continue;
          const rel = relative === "." ? item.name : `${relative}/${item.name}`;
          let entry; try { entry = await entryAt(rel); } catch { continue; }
          if (!entry) continue;
          accept(entry);
          if (query && entry.kind === "folder") await walk(rel);
          if (truncated) return;
        }
      };
      await walk(resolved.rel);
    }
  }
  entries.sort((a,b) => {
    if (recent) return recent.indexOf(a.key)-recent.indexOf(b.key);
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (options.sort === "modified") return Date.parse(b.modifiedAt)-Date.parse(a.modifiedAt) || a.name.localeCompare(b.name);
    if (options.sort === "size") return b.byteSize-a.byteSize || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
  const offset = Number.isSafeInteger(options.offset) && options.offset! >= 0 ? options.offset! : 0;
  return { entries: entries.slice(offset, offset + 200), total: entries.length, truncated };
}
