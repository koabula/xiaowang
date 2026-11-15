import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MAC_INSTALL_SCRIPT, prepareMacUpdate } from '../desktop/main/mac-update.ts';

const run = promisify(execFile);
const mac = process.platform === 'darwin';
async function root(t: { after: (callback: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xw-update test's-"));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('mac updates validate the bundle and version before touching the installed app', { skip: !mac }, async t => {
  const dir = await root(t); const target = path.join(dir, 'Installed 小王.app'); await mkdir(target);
  await writeFile(path.join(target, 'original'), 'keep me');
  const bundle = path.join(dir, 'New 小王.app'); await mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  await writeFile(path.join(bundle, 'Contents/MacOS/xiaowang'), '#!/bin/sh\nexit 0', { mode: 0o755 });
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.xiaowang.assistant</string><key>CFBundleShortVersionString</key><string>0.1.6</string><key>CFBundleExecutable</key><string>xiaowang</string></dict></plist>`);
  const archive = path.join(dir, 'update.zip'); await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, archive]);
  await assert.rejects(prepareMacUpdate(archive, target, '0.1.7'), /版本不匹配/);
  assert.equal((await readdir(dir)).filter(name => name.startsWith('.xiaowang-update-')).length, 0, 'Failed preparation cleans its stage');
  const prepared = await prepareMacUpdate(archive, target, '0.1.6');
  await access(path.join(prepared.replacement, 'Contents/MacOS/xiaowang'));
  assert.equal(await readFile(path.join(target, 'original'), 'utf8'), 'keep me');
  await assert.rejects(prepareMacUpdate(archive, '/Volumes/Test/xiaowang.app', '0.1.6'), /应用程序/);
});

test('mac replacement waits for exit, handles spaces and rolls back install or launch failures', { skip: !mac }, async t => {
  const dir = await root(t);
  for (const scenario of ['success', 'missing-replacement', 'launch-failure']) {
    const stage = path.join(dir, scenario); await mkdir(stage);
    const target = path.join(dir, `${scenario} 小王's.app`); await mkdir(target); await writeFile(path.join(target, 'version'), 'old');
    const replacement = path.join(stage, 'new.app');
    if (scenario !== 'missing-replacement') { await mkdir(replacement); await writeFile(path.join(replacement, 'version'), 'new'); }
    const backup = path.join(stage, 'old.app'); const outcome = path.join(dir, `${scenario}.json`); const script = path.join(stage, 'install.sh');
    // Keep filesystem operations real; substitute only the launch-service dependency.
    await writeFile(script, MAC_INSTALL_SCRIPT.replaceAll('/usr/bin/open', scenario === 'launch-failure' ? '/usr/bin/false' : '/usr/bin/true'));
    const result = run('/bin/sh', [script, '99999999', target, replacement, backup, stage, outcome]);
    if (scenario === 'success') {
      await result; assert.equal(await readFile(path.join(target, 'version'), 'utf8'), 'new');
      await assert.rejects(access(stage));
    } else {
      await assert.rejects(result); assert.equal(await readFile(path.join(target, 'version'), 'utf8'), 'old');
      assert.match(await readFile(outcome, 'utf8'), /已恢复原版本/);
    }
  }
});
