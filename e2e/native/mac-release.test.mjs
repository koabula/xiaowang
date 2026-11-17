import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchPackaged, closeTestApp } from '../launch.mjs';
const run = promisify(execFile);

// Exercise final distribution artifacts with fresh profiles. Ad-hoc signatures
// validate integrity; Gatekeeper's developer trust still requires user approval.
test('mac release: both architectures have complete signatures; native ZIP and DMG apps launch with fresh data', {
  skip: process.platform !== 'darwin' || !process.env.XIAOWANG_MAC_RELEASE_DIR, timeout: 180000,
}, async t => {
  const directory = path.resolve(process.env.XIAOWANG_MAC_RELEASE_DIR);
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const artifacts = (await readdir(directory)).filter(name => new RegExp(`^XiaoWang-${version.replaceAll('.', '\\.')}\\-mac-(arm64|x64)\\.(zip|dmg)$`).test(name));
  assert.equal(artifacts.length, 4, 'Both ZIP and DMG artifacts are required for arm64 and x64');
  for (const name of artifacts.sort()) await t.test(name, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xw-first-launch-'));
    const extracted = path.join(root, 'First install'); await mkdir(extracted);
    const disk = name.endsWith('.dmg'); let mounted = false, app;
    try {
      if (disk) {
        await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', extracted, path.join(directory, name)]);
        mounted = true;
      } else await run('/usr/bin/ditto', ['-x', '-k', path.join(directory, name), extracted]);
      const bundles = (await readdir(extracted)).filter(item => item.endsWith('.app'));
      assert.equal(bundles.length, 1);
      const bundle = path.join(extracted, bundles[0]);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
      assert.ok((await stat(path.join(bundle, 'Contents/_CodeSignature/CodeResources'))).size > 0);
      const signature = (await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle])).stderr;
      assert.match(signature, /Identifier=com\.xiaowang\.assistant/);
      assert.doesNotMatch(signature, /Sealed Resources=none|Info.plist=not bound/);
      const entitlements = (await run('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundle])).stdout;
      for (const key of ['allow-jit', 'device.audio-input']) assert.ok(entitlements.includes(key));
      if (signature.includes('Signature=adhoc')) assert.ok(entitlements.includes('disable-library-validation'));
      const architecture = name.includes('-arm64.') ? 'arm64' : 'x64';
      const binary = path.join(bundle, 'Contents/MacOS/xiaowang');
      const file = (await run('/usr/bin/file', [binary])).stdout;
      assert.ok(file.includes(architecture === 'arm64' ? 'arm64' : 'x86_64'));
      console.log(`Verified complete ${architecture} signature in ${name}`);
      if (architecture !== process.arch) {
        console.log(`Launch covered by native ${process.arch} artifacts; ${architecture} signature verified on this runner`);
        return;
      }
      const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: path.join(root, 'profile'), XIAOWANG_DISABLE_UPDATES: '1' };
      for (const key of Object.keys(env)) if (key.startsWith('XIAOWANG_') && !['XIAOWANG_HOME', 'XIAOWANG_USER_DATA', 'XIAOWANG_DISABLE_UPDATES'].includes(key)) delete env[key];
      delete env.ELECTRON_RUN_AS_NODE;
      app = await launchPackaged(binary, [], env, { native: true });
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.xiaowang));
      const state = await page.evaluate(() => window.xiaowang.getState());
      assert.equal(state.version, version); assert.equal(state.settings.ready, false);
      await page.getByRole('form', { name: '设置', exact: true }).waitFor();
      assert.equal(app.process().exitCode, null);
      // Signing must survive the first launch without resources being rewritten.
      await closeTestApp(app); app = undefined;
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
      console.log(`Fresh-profile first launch and post-launch integrity passed for ${name}`);
    } finally {
      if (app) await closeTestApp(app);
      if (mounted) await run('/usr/bin/hdiutil', ['detach', extracted]);
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
