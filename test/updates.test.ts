import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpdateController, type UpdateEngine, type UpdateState } from '../desktop/main/update-state.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(patch: Partial<UpdateEngine> = {}) {
  const states: UpdateState[] = []; let checks = 0; let downloads = 0; let installs = 0; let idle = true;
  const engine: UpdateEngine = {
    async check() { checks++; return '0.1.6'; },
    async download(progress) { downloads++; progress(50); progress(100); },
    async install() { installs++; }, ...patch,
  };
  const controller = new UpdateController('0.1.5', engine, state => states.push(state), () => idle);
  return { controller, states, counts: () => ({ checks, downloads, installs }), setIdle: (value: boolean) => { idle = value; } };
}

test('updates only offer newer stable versions and never download without a click', async () => {
  const f = fixture(); await f.controller.check();
  assert.equal(f.controller.snapshot().version, '0.1.6'); assert.equal(f.controller.snapshot().phase, 'available');
  assert.deepEqual(f.counts(), { checks: 1, downloads: 0, installs: 0 });
  for (const version of ['0.1.5', '0.1.4', '0.2.0-beta.1', 'not-a-version']) {
    const other = fixture({ check: async () => version }); await other.controller.check();
    assert.equal(other.controller.snapshot().phase, 'idle'); assert.equal(other.controller.snapshot().version, undefined);
  }
});

test('duplicate checks/clicks share the same operation and expose real progress', async () => {
  const gate = deferred<void>(); let downloads = 0;
  const f = fixture({ download: async progress => { downloads++; progress(37); await gate.promise; } });
  await Promise.all([f.controller.check(), f.controller.check()]);
  assert.equal(f.counts().checks, 1);
  const first = f.controller.update(); const second = f.controller.update();
  assert.equal(downloads, 1); assert.equal(f.controller.snapshot().percent, 37);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.counts().installs, 1);
});

test('a downloaded update waits for work/calls/settings and installs only once when idle', async () => {
  const f = fixture(); f.setIdle(false); await f.controller.check(); await f.controller.update();
  assert.equal(f.controller.snapshot().phase, 'ready'); assert.equal(f.counts().installs, 0);
  await f.controller.installWhenIdle(); assert.equal(f.counts().installs, 0);
  f.setIdle(true); await f.controller.installWhenIdle(); assert.equal(f.counts().installs, 1);
  assert.equal(f.controller.snapshot().phase, 'installing');
  await f.controller.installWhenIdle();
  assert.equal(f.counts().installs, 1, 'A resolved installer is not invoked a second time');
});

test('download and installation failures are recoverable without losing the offered version', async () => {
  let fail = true; let attempts = 0;
  const f = fixture({ download: async () => { if (fail) throw new Error('checksum mismatch'); }, install: async () => { attempts++; if (attempts === 1) throw new Error('read-only directory'); } });
  await f.controller.check(); await f.controller.update();
  assert.equal(f.controller.snapshot().error, 'checksum mismatch'); assert.equal(f.controller.snapshot().version, '0.1.6');
  fail = false; await f.controller.update(); assert.equal(f.controller.snapshot().error, 'read-only directory');
  await f.controller.update(); assert.equal(f.controller.snapshot().phase, 'installing'); assert.equal(attempts, 2);
});

test('work starting during preparation defers installation rather than interrupting it', async () => {
  let attempts = 0; const f = fixture({ install: async () => { attempts++; return attempts !== 1; } });
  await f.controller.check(); await f.controller.update();
  assert.equal(f.controller.snapshot().phase, 'ready');
  await f.controller.installWhenIdle(); assert.equal(attempts, 2); assert.equal(f.controller.snapshot().phase, 'installing');
});

test('offline checks and an absent first release leave no spurious update offer', async () => {
  const f = fixture({ check: async () => { throw new Error('404 no release'); } });
  await f.controller.check(); assert.equal(f.controller.snapshot().phase, 'error'); assert.equal(f.controller.snapshot().version, undefined);
});


test('simultaneous update requests before discovery still download and install once', async () => {
  const check = deferred<string>(); const f = fixture({ check: () => check.promise });
  const a = f.controller.update(); const b = f.controller.update();
  check.resolve('0.1.6'); await Promise.all([a, b]);
  assert.deepEqual(f.counts(), { checks: 0, downloads: 1, installs: 1 });
});

test('manual checks refresh an already offered release and record successful check time', async () => {
  let version = '0.1.6', checks = 0;
  const f = fixture({ check: async () => { checks++; return version; } });
  await f.controller.check(); version = '0.1.7'; await f.controller.check(); assert.equal(checks, 1);
  await f.controller.check(true); assert.equal(checks, 2); assert.equal(f.controller.snapshot().version, '0.1.7'); assert.ok(f.controller.snapshot().lastCheckedAt);
});
test('download waits for a manual check and uses the refreshed version without parallel checks', async () => {
  const gate = deferred<string>(); let refreshing = false, downloads = 0;
  const f = fixture({ check: async () => refreshing ? gate.promise : '0.1.6', download: async () => { downloads++; assert.equal(f.controller.snapshot().version, '0.1.7'); } });
  await f.controller.check(); refreshing = true;
  const check = f.controller.check(true), update = f.controller.update(); assert.equal(downloads, 0);
  gate.resolve('0.1.7'); await Promise.all([check, update]); assert.equal(downloads, 1);
});
test('100 percent is verification rather than installation; waiting reasons track the actual blockers', async () => {
  const gate = deferred<void>(); let reasons = ['call'];
  const engine: UpdateEngine = { check: async () => '0.1.6', download: async progress => { progress(100, { transferred: 500, total: 500, bytesPerSecond: 10 }); await gate.promise; }, install: async () => {} };
  const controller = new UpdateController('0.1.5', engine, () => {}, () => reasons.length === 0, () => reasons);
  await controller.check(); const download = controller.update();
  assert.equal(controller.snapshot().phase, 'verifying'); assert.equal(controller.snapshot().transferred, 500);
  gate.resolve(); await download; assert.equal(controller.snapshot().phase, 'ready'); assert.deepEqual(controller.snapshot().waitingFor, ['call']);
  reasons = ['settings']; await controller.installWhenIdle(); assert.deepEqual(controller.snapshot().waitingFor, ['settings']);
  reasons = []; await controller.installWhenIdle(); assert.equal(controller.snapshot().phase, 'installing');
});
