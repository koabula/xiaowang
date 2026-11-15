import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export interface PreparedMacUpdate { stage: string; replacement: string; target: string; backup: string; }

/** All replacement paths are prepared on the same volume before the running app quits. */
export async function prepareMacUpdate(archive: string, target: string, version: string): Promise<PreparedMacUpdate> {
  if (!target.endsWith('.app') || target.includes('/AppTranslocation/') || target.startsWith('/Volumes/')) throw new Error('请先将小王同学移至“应用程序”文件夹，再进行更新。');
  await access(path.dirname(target), constants.W_OK).catch(() => { throw new Error('应用所在文件夹不可写，请将小王同学移至你可写的“应用程序”文件夹后重试。'); });
  const stage = await mkdtemp(path.join(path.dirname(target), '.xiaowang-update-'));
  try {
    // Reject archive paths that could escape the staging directory during extraction.
    const listing = await run('/usr/bin/unzip', ['-Z1', archive], { maxBuffer: 16 * 1024 * 1024 });
    for (const entry of listing.stdout.split('\n').filter(Boolean)) {
      if (entry.startsWith('/') || entry.split('/').includes('..') || entry.includes('\\')) throw new Error('更新包包含不安全的文件路径。');
    }
    const contents = path.join(stage, 'contents'); await mkdir(contents);
    await run('/usr/bin/ditto', ['-x', '-k', archive, contents]);
    const bundles = (await readdir(contents)).filter(name => name.endsWith('.app'));
    if (bundles.length !== 1) throw new Error('更新包中未找到唯一的应用。');
    const replacement = path.join(contents, bundles[0]!);
    if (!(await lstat(replacement)).isDirectory()) throw new Error('更新包中的应用格式不正确。');
    const plist = path.join(replacement, 'Contents/Info.plist');
    const read = async (key: string) => (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim();
    if (await read('CFBundleIdentifier') !== 'com.xiaowang.assistant' || await read('CFBundleShortVersionString') !== version) throw new Error('更新包的应用标识或版本不匹配。');
    const executable = await read('CFBundleExecutable');
    if (!executable || path.basename(executable) !== executable) throw new Error('更新包的启动文件不正确。');
    await access(path.join(replacement, 'Contents/MacOS', executable), constants.X_OK);
    // Signed installations must retain their publisher; unsigned development builds
    // use the SHA-512 verified release archive without weakening OS security settings.
    const publisher = await teamOf(target);
    if (publisher) {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', replacement]);
      if (await teamOf(replacement) !== publisher) throw new Error('更新包的签名发布者与当前应用不一致。');
    }
    return { stage, replacement, target, backup: path.join(stage, 'previous.app') };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

async function teamOf(bundle: string): Promise<string | undefined> {
  try {
    const result = await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
    const team = /TeamIdentifier=(.+)/.exec(result.stderr)?.[1]?.trim();
    return team && team !== 'not set' ? team : undefined;
  } catch { return undefined; }
}

// Arguments, rather than interpolated shell text, preserve app paths containing spaces.
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
set -eu
pid="$1"
target="$2"
replacement="$3"
backup="$4"
stage="$5"
outcome="$6"
shift 6
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    printf '%s' '{"error":"应用未能退出，更新尚未安装，请重试。"}' > "$outcome"
    exit 1
  fi
  sleep 0.2
done
if ! /bin/mv "$target" "$backup"; then
  printf '%s' '{"error":"无法替换应用，原版本保持不变。"}' > "$outcome"
  /usr/bin/open -n "$target" "$@" || true
  exit 1
fi
if ! /bin/mv "$replacement" "$target"; then
  /bin/mv "$backup" "$target"
  printf '%s' '{"error":"更新安装失败，已恢复原版本。"}' > "$outcome"
  /usr/bin/open -n "$target" "$@" || true
  exit 1
fi
if ! /usr/bin/open -n "$target" "$@"; then
  /bin/mv "$target" "$replacement"
  /bin/mv "$backup" "$target"
  printf '%s' '{"error":"更新启动失败，已恢复原版本。"}' > "$outcome"
  /usr/bin/open -n "$target" "$@" || true
  exit 1
fi
/bin/rm -f "$outcome"
/bin/rm -rf "$stage"
`;

export async function launchMacInstaller(prepared: PreparedMacUpdate, userData: string, pid = process.pid): Promise<void> {
  const script = path.join(prepared.stage, 'install.sh');
  await writeFile(script, MAC_INSTALL_SCRIPT, { mode: 0o700 });
  const log = await open(path.join(userData, 'update-install.log'), 'a', 0o600);
  try {
    const launchArgs: string[] = [];
    for (const key of ['XIAOWANG_HOME', 'XIAOWANG_USER_DATA', 'XIAOWANG_UPDATE_TEST_FEED']) {
      if (process.env[key]) launchArgs.push('--env', `${key}=${process.env[key]}`);
    }
    if (process.env.XIAOWANG_UPDATE_TEST_FEED) launchArgs.push('--args', ...process.argv.filter(arg => arg.startsWith('--remote-debugging-port=') || ['--no-sandbox', '--use-mock-keychain'].includes(arg)));
    const child = spawn('/bin/sh', [script, String(pid), prepared.target, prepared.replacement, prepared.backup, prepared.stage, path.join(userData, 'update-outcome.json'), ...launchArgs], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
}
