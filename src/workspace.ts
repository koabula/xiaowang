import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type ResolvedPath =
  | { ok: true; abs: string; rel: string }
  | { ok: false; error: string };

/**
 * 把模型给的路径收进当前 Bot 的工作区。
 * 相对路径和已经落在工作区内的绝对路径都可以；`..` 和指向外部的符号链接会被拒绝，
 * 错误信息里写明工作区根目录，方便模型自己改。
 */
export function resolveInsideWorkspace(root: string, inputPath: string): ResolvedPath {
  const raw = inputPath.trim();
  if (!raw) {
    return { ok: false, error: "缺少路径。请传工作区内的相对路径，例如 notes/reading.md。" };
  }
  if (raw.includes("\0")) {
    return { ok: false, error: "路径里不能有空字符。" };
  }

  const abs = path.resolve(root, raw);
  if (!existingAncestorInside(root, abs)) {
    return {
      ok: false,
      error: `路径超出了当前 Bot 的工作区。请改用相对路径，例如 notes/reading.md。工作区根目录是 ${root}`,
    };
  }

  const rel = path.relative(root, abs);
  if (rel === "") {
    return { ok: true, abs, rel: "." };
  }
  return { ok: true, abs, rel: rel.split(path.sep).join("/") };
}

function existingAncestorInside(root: string, candidate: string): boolean {
  const realRoot = realpathSync(root);
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  const real = realpathSync(current);
  const rel = path.relative(realRoot, real);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
