import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { Runtime } from '../src/runtime.ts';
import { launchPackaged, closeTestApp } from './launch.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(40); } throw new Error('Bot browser condition timed out'); }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function closeServer(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('per-bot native pages share sign-ins, isolate history/control, route headers/downloads and dispose independently', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-bot-pages-'));
  const server = createServer((req, res) => {
    if (req.url.startsWith('/pdf/')) { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF-1.4\n%%EOF'); return; }
    if (req.url === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="source.txt"' }); res.end('download'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title><style>body{height:2500px}</style><p>${req.url}</p><input aria-label="entry"><a href="/download">Download source</a>`);
  }); const base = await listen(server);
  await copyFile('desktop/main/browser-preload.cjs', path.join(root, 'browser-preload.cjs'));
  const main = path.join(root, 'main.mjs');
  await build({ stdin: { contents: `import {app,BrowserWindow,session} from 'electron';import {BotBrowsers} from './desktop/main/browser.ts';app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({width:900,height:740});await win.loadURL('data:text/html,host');globalThis.saved=[];globalThis.downloads=[];globalThis.browsers=new BotBrowsers(()=>{},(slug,filename,bytes)=>{globalThis.saved.push({slug,filename,bytes:bytes.length});return{id:slug,filename}});browsers.attach(win);browsers.activate('a');browsers.forBot('a');browsers.forBot('b');session.fromPartition('persist:xiaowang').on('will-download',(event,item,wc)=>{downloads.push(browsers.slugForContents(wc.id));event.preventDefault()});});`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', external: ['electron'], outfile: main, logLevel: 'silent' });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', main], env });
  t.after(async () => { await closeTestApp(app); await closeServer(server); await rm(root, { recursive: true, force: true }); });
  await until(() => app.evaluate(() => !!globalThis.browsers));
  const bot = (slug, name, ...args) => app.evaluate(async (_, { slug, name, args }) => globalThis.browsers.forBot(slug).driver[name](...args), { slug, name, args });
  const run = (slug, script) => app.evaluate(async (_, { slug, script }) => globalThis.browsers.forBot(slug).view.webContents.executeJavaScript(script), { slug, script });
  await Promise.all([bot('a', 'navigate', `${base}/a`), bot('b', 'navigate', `${base}/b`)]);
  await run('a', 'document.cookie="login=shared; path=/";localStorage.setItem("session-account","same-user");window.scrollTo(0,450)');
  assert.equal(await run('b', 'document.cookie'), 'login=shared');
  assert.equal(await run('b', 'localStorage.getItem("session-account")'), 'same-user');
  assert.equal(await app.evaluate(() => browsers.forBot('a').view.webContents.session === browsers.forBot('b').view.webContents.session), true);
  await bot('b', 'navigate', `${base}/b-next`);
  await app.evaluate(() => { browsers.activate('b'); browsers.setBounds('b', { x: 0, y: 0, width: 700, height: 500 }); browsers.forBot('a').setHolder('user'); });
  assert.equal(await bot('a', 'holder'), 'user'); assert.equal(await bot('b', 'holder'), 'bot');
  await app.evaluate(async () => { const wc = browsers.forBot('a').view.webContents; await wc.executeJavaScript('document.querySelector("input").focus()'); await wc.insertText('HIDDEN-INPUT'); });
  assert.equal(await run('a', 'document.querySelector("input").value'), '', 'A hidden user-owned page cannot receive keyboard or IME input');
  await run('a', 'window.scrollTo(0,450)');
  await assert.rejects(bot('a', 'type', 'entry', 'denied'), /用户正在控制/);
  await bot('b', 'type', 'entry', 'only-b');
  assert.equal(await run('a', 'document.querySelector("input").value'), '');
  assert.equal(await run('b', 'document.querySelector("input").value'), 'only-b');
  await bot('b', 'back'); await until(async () => (await run('b', 'location.pathname')) === '/b');
  assert.equal(await run('a', 'location.pathname'), '/a');
  await app.evaluate(() => { browsers.activate('a'); browsers.setBounds('a', { x: 0, y: 0, width: 700, height: 500 }); browsers.setBounds('b', null); });
  assert.deepEqual(await app.evaluate(() => ({ a: browsers.forBot('a').view.getVisible(), b: browsers.forBot('b').view.getVisible() })), { a: true, b: false });
  assert.equal(await run('a', 'scrollY'), 450);
  // A hidden bot's download belongs to its originating page, not the active bot.
  await bot('b', 'click', 'Download source'); await until(() => app.evaluate(() => downloads.length));
  assert.deepEqual(await app.evaluate(() => downloads), ['b']);
  await app.evaluate(() => browsers.forBot('a').setHolder('bot'));
  await Promise.all([bot('a', 'navigate', `${base}/pdf/a`), bot('b', 'navigate', `${base}/pdf/b`)]);
  assert.deepEqual((await app.evaluate(() => saved)).map(x => x.slug).sort(), ['a', 'b']);
  await bot('b', 'navigate', `${base}/b-live`);
  await app.evaluate(() => { globalThis.oldContents = browsers.forBot('a').view.webContents; browsers.clearBot('a'); });
  await until(() => app.evaluate(() => oldContents.isDestroyed()));
  assert.match(await bot('b', 'snapshot'), /b-live/);
});

test('desktop bots browse concurrently and switching restores scoped UI and control rights', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-bot-browser-ui-')); const profile = path.join(root, 'profile'); await mkdir(profile);
  const runtime = Runtime.open(path.join(root, 'home')); const child = runtime.store.createBot({ name: 'Child browser', systemPrompt: 'Child test', slug: 'child' }); runtime.close();
  const web = createServer((req, res) => {
    if (req.url === '/source') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="child-source.txt"' }); res.end('CHILD-ORIGINAL'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title><p>${req.url}</p><a href="/source">Download source</a>`);
  }); const base = await listen(web);
  let releaseParent = () => {}; let parentWaiting = false;
  const model = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const childRequest = body.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('child-browse'));
    const navigated = body.messages.some(m => m.role === 'tool');
    const send = message => { if (res.writableEnded || res.destroyed) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); };
    if (!navigated) send({ content: 'Browsing', tool_calls: [{ id: 'nav', type: 'function', function: { name: 'browser_navigate', arguments: JSON.stringify({ url: `${base}/${childRequest ? 'child' : 'parent'}` }) } }] });
    else if (!childRequest) { parentWaiting = true; releaseParent = () => send({ content: 'PARENT-DONE' }); }
    else if (!body.messages.some(m => m.role === 'tool' && m.content.startsWith('已点击'))) send({ content: 'Getting source', tool_calls: [{ id: 'download', type: 'function', function: { name: 'browser_click', arguments: JSON.stringify({ target: 'Download source' }) } }] });
    else send({ content: 'CHILD-DONE' });
  }); const modelUrl = await listen(model);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: `${modelUrl}/v1`, apiKey: 'local', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = process.env.XIAOWANG_E2E_EXECUTABLE ? await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, ['--no-sandbox'], env) : await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { releaseParent(); await closeTestApp(app); await closeServer(model); await closeServer(web); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.composer');
  await page.evaluate(() => { void window.xiaowang.ask('xiaowang', 'parent-browse'); });
  await until(() => parentWaiting);
  await page.evaluate(() => window.xiaowang.browserHolder('user'));
  const initial = await page.evaluate(() => window.xiaowang.getState()); assert.ok(initial.jobs.some(j => j.status === 'running'));
  await page.evaluate(() => { void window.xiaowang.ask('child', 'child-browse'); });
  await until(() => page.evaluate(async () => (await window.xiaowang.events('child')).some(e => e.text === 'CHILD-DONE')));
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).browser.url, `${base}/parent`);
  await until(() => page.evaluate(async () => (await window.xiaowang.library('child')).some(ref => ref.filename === 'child-source.txt')));
  assert.equal((await page.evaluate(() => window.xiaowang.library('xiaowang'))).length, 0, 'A background download must not land in the foreground bot library');
  await page.evaluate(() => window.xiaowang.setActive('child'));
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await page.locator('.capsule').filter({ hasText: '观看' }).waitFor();
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).browser.holder, 'bot');
  await assert.rejects(page.evaluate(url => window.xiaowang.browserGo(url), `${base}/forbidden`), /取得浏览器控制权/);
  await page.evaluate(() => window.xiaowang.setActive('xiaowang'));
  await page.locator('.capsule').filter({ hasText: '你正在控制' }).waitFor();
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).browser.url, `${base}/parent`);
  // One resource row replaces the old content modes and nested file strip.
  const metrics = await page.locator('.stage').evaluate(el => {
    const tabs = [...el.querySelectorAll('[role="tab"]')].map(button => button.getBoundingClientRect());
    return { count: tabs.length, height: el.querySelector('.workspace-header').getBoundingClientRect().height, top: tabs.map(rect => rect.top), scrollbar: getComputedStyle(document.querySelector('.messages')).scrollbarWidth };
  });
  assert.ok(metrics.count >= 3);
  assert.ok(Math.max(...metrics.top) - Math.min(...metrics.top) < 1);
  assert.ok(metrics.height <= 44); assert.equal(metrics.scrollbar, 'thin');
  await page.reload(); await page.waitForSelector('.composer');
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).browser.holder, 'user');
  releaseParent();
  await until(() => page.evaluate(async () => (await window.xiaowang.events('xiaowang')).some(e => e.text === 'PARENT-DONE')));
  assert.equal(child.slug, 'child');
});
