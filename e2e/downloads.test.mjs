import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { electron, closeTestApp } from './launch.mjs';

const MiB = 1024 * 1024, cap = 80 * MiB;
async function until(check) { const end = Date.now() + 12000; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Download did not settle'); }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('browser downloads import once and clean temporary files after success, rejection, cancellation, failure and quit', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-download-e2e-')), profile = path.join(root, 'profile'), temporary = path.join(root, 'downloads'); await mkdir(profile); await mkdir(temporary);
  const server = createServer((req, res) => {
    if (req.url === '/page') { res.setHeader('content-type', 'text/html'); res.end('<title>Download source</title><h1>Research</h1><a href="/ok" download>Download source</a>'); return; }
    const slow = req.url.startsWith('/slow'), large = req.url === '/large';
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${req.url === '/failure' ? 'secret.pem' : req.url === '/ok' ? 'source.txt' : 'partial.txt'}"`, 'content-length': large ? cap + 1 : slow ? MiB : 8 });
    // Chromium sniffs initial bytes before emitting will-download.
    if (large || slow) { res.flushHeaders(); res.write(Buffer.alloc(1024, 65)); return; }
    res.end('original');
  }); const url = await listen(server);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: url + '/v1', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile, XIAOWANG_DISABLE_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env }); let closed = false;
  t.after(async () => { if (!closed) await closeTestApp(app); await stop(server); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.waitForSelector('.composer');
  await app.evaluate(({ app, session }, temporary) => {
    app.setPath('temp', temporary); globalThis.downloadItems = [];
    session.fromPartition('persist:xiaowang').prependListener('will-download', (_event, item) => {
      const record = { item, state: '' }; globalThis.downloadItems.push(record);
      item.once('done', (_event, state) => { record.state = state; });
    });
  }, temporary);
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await page.evaluate(async url => { await window.xiaowang.browserHolder('user'); await window.xiaowang.browserGo(url + '/page'); }, url);
  const download = async route => {
    const index = await app.evaluate(() => globalThis.downloadItems.length);
    // Start each native transfer independently of resource-tab changes after import.
    await app.evaluate(({ webContents }, url) => {
      webContents.getAllWebContents().find(wc => wc.getURL().endsWith('/page')).downloadURL(url);
    }, url + route);
    await until(() => app.evaluate((_, i) => globalThis.downloadItems.length > i, index));
    return index;
  };
  const settled = async index => { await until(() => app.evaluate((_, i) => globalThis.downloadItems[i].state, index)); await until(async () => (await readdir(temporary)).length === 0); };
  await settled(await download('/ok'));
  let refs = await page.evaluate(() => window.xiaowang.library('xiaowang')); assert.equal(refs.length, 1);
  assert.equal(await page.evaluate(async id => new TextDecoder().decode(await window.xiaowang.readFile('xiaowang', id)), refs[0].id), 'original');
  await settled(await download('/large')); await page.locator('.toast').filter({ hasText: '超过' }).waitFor();
  await settled(await download('/failure')); await page.locator('.toast').filter({ hasText: '拒绝' }).waitFor();
  const cancelled = await download('/slow');
  await app.evaluate((_, i) => globalThis.downloadItems[i].item.cancel(), cancelled); await settled(cancelled);
  refs = await page.evaluate(() => window.xiaowang.library('xiaowang')); assert.equal(refs.length, 1);
  await download('/slow-quit'); const child = app.process(); await closeTestApp(app); closed = true;
  assert.equal(child.signalCode, null, 'Shutdown completes without force-killing the app');
  assert.deepEqual(await readdir(temporary), []);
});

test('PDF capture uses the browser session, cancels oversized streams and abandons work on control change', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-pdf-download-')), main = path.join(root, 'main.mjs');
  const sent = new Map(), closed = new Set();
  const server = createServer(async (req, res) => {
    if (!req.headers.cookie?.includes('research=session')) { res.writeHead(401); res.end(); return; }
    res.on('close', () => closed.add(req.url));
    if (req.url === '/pdf/ok') { res.setHeader('content-type', 'application/pdf'); res.end('%PDF-1.4\nSOURCE'); return; }
    if (req.url === '/pdf/header') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': 96 * MiB }); res.flushHeaders(); return; }
    if (req.url === '/pdf/slow') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write('%PDF-'); sent.set(req.url, 5); return; }
    res.writeHead(200, { 'content-type': 'application/pdf' }); res.flushHeaders();
    const chunk = Buffer.alloc(MiB, 65); chunk.write('%PDF-');
    for (let n = 0; n < 96 && !res.destroyed; n++) {
      sent.set(req.url, (n + 1) * MiB);
      if (!res.write(chunk)) await new Promise(resolve => {
        const finished = () => { res.off('drain', finished); res.off('close', finished); res.off('error', finished); resolve(); };
        res.once('drain', finished); res.once('close', finished); res.once('error', finished);
      });
    }
    if (!res.destroyed) res.end();
  }); const url = await listen(server);
  await build({ stdin: { contents: `import {app,BrowserWindow,session} from 'electron';import {BrowserPane} from './desktop/main/browser.ts';import {testWindowOptions} from './desktop/main/test-mode.ts';app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({...testWindowOptions(),width:900,height:740});await win.loadURL('data:text/html,host');await session.fromPartition('persist:xiaowang').cookies.set({url:${JSON.stringify(url)},name:'research',value:'session'});globalThis.saved=[];globalThis.pane=new BrowserPane(()=>{},(filename,bytes)=>{saved.push({filename,bytes:bytes.length});return{id:'fixture',filename}});pane.attach(win);});`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', external: ['electron'], outfile: main, logLevel: 'silent' });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', main], env });
  t.after(async () => { await closeTestApp(app); await stop(server); await rm(root, { recursive: true, force: true }); });
  await app.firstWindow(); await until(() => app.evaluate(() => Boolean(globalThis.pane)));
  const capture = route => app.evaluate(async (_, url) => globalThis.pane.capturePdf(url), url + route);
  assert.equal((await capture('/pdf/ok')).id, 'fixture');
  await assert.rejects(capture('/pdf/header'), /超过/); await until(() => closed.has('/pdf/header'));
  await assert.rejects(capture('/pdf/chunked'), /超过/); await until(() => closed.has('/pdf/chunked'));
  assert.ok(sent.get('/pdf/chunked') < 96 * MiB, 'Unknown-length transfer stops before the entire file arrives');
  await app.evaluate((_, url) => { globalThis.pendingCapture = globalThis.pane.capturePdf(url); }, url + '/pdf/slow');
  await until(() => sent.has('/pdf/slow'));
  await app.evaluate(() => globalThis.pane.setHolder('user'));
  assert.equal(await app.evaluate(() => globalThis.pendingCapture), null); await until(() => closed.has('/pdf/slow'));
  assert.equal(await app.evaluate(() => globalThis.saved.length), 1);
});
