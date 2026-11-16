import { launchNative, launchPackaged, closeTestApp } from '../launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(30); }
  throw new Error('Browser control condition did not become true');
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function closeServer(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
function fixtureHtml(extra = '') {
  return `<!doctype html><style>body{margin:0;height:2400px}#normal{position:absolute;left:40px;top:40px;width:180px;height:60px}#entry{position:absolute;left:40px;top:130px}dialog{width:400px;height:200px}dialog button{margin:30px}iframe{position:absolute;left:350px;top:40px;width:300px;height:180px}</style><button id="normal" onclick="window.hits++">Normal action</button><input id="entry" aria-label="entry"><dialog id="modal"><button id="modalButton" onclick="window.dialogHits++">Dialog action</button></dialog>${extra}<script>window.hits=0;window.dialogHits=0;window.globalHits=0;window.wheels=0;window.contexts=0;window.drops=0;window.addEventListener('click',()=>window.globalHits++);window.addEventListener('wheel',()=>window.wheels++);window.addEventListener('contextmenu',e=>{e.preventDefault();window.contexts++});window.addEventListener('drop',e=>{e.preventDefault();window.drops++});</script>`;
}

test('native browser: ownership gates mouse, wheel, keyboard, IME, modals, frames and loading', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-browser-control-'));
  let releaseSlow = () => {};
  const frames = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<style>body{height:2000px}</style><button style="margin:10px" onclick="window.hits++">Frame action</button><input id="frameEntry"><script>window.hits=0</script>'); });
  const frameUrl = await listen(frames);
  const server = createServer((request, response) => {
    if (request.url === '/slow.png') { releaseSlow = () => { if (!response.writableEnded) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(); } }; return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(fixtureHtml(request.url === '/loading' ? '<img src="/slow.png">' : `<iframe id="child" src="${frameUrl}/frame"></iframe>`));
  });
  const base = await listen(server);
  const main = path.join(root, 'main.mjs');
  await copyFile('desktop/main/browser-preload.cjs', path.join(root, 'browser-preload.cjs'));
  await build({ stdin: { contents: `import {app,BrowserWindow} from 'electron';import {BrowserPane} from './desktop/main/browser.ts';app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({width:900,height:740,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});globalThis.pane=new BrowserPane(()=>{},()=>({id:"unused",filename:"unused.pdf"}));globalThis.pane.attach(win);globalThis.pane.setBounds({x:0,y:0,width:800,height:600});await win.loadURL('data:text/html,<input id="host" placeholder="chat">');});`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', external: ['electron'], outfile: main, logLevel: 'silent' });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchNative({ args: ['--no-sandbox', main], env });
  t.after(async () => { releaseSlow(); await closeTestApp(app); await closeServer(server); await closeServer(frames); await rm(root, { recursive: true, force: true }); });
  const host = await app.firstWindow();
  const run = script => app.evaluate(async (_, script) => globalThis.pane.view.webContents.executeJavaScript(script), script);
  const action = (name, ...args) => app.evaluate(async (_, { name, args }) => globalThis.pane[name](...args), { name, args });
  const bot = (name, ...args) => app.evaluate(async (_, { name, args }) => globalThis.pane.driver[name](...args), { name, args });
  const input = async (...events) => { await app.evaluate(({ BrowserWindow }, events) => { BrowserWindow.getAllWindows()[0]?.focus(); const wc = globalThis.pane.view.webContents; wc.focus(); for (const event of events) wc.sendInputEvent(event); }, events); await sleep(80); };
  const click = (x, y, button = 'left') => input({ type: 'mouseMove', x, y }, { type: 'mouseDown', x, y, button, clickCount: 1 }, { type: 'mouseUp', x, y, button, clickCount: 1 });
  const key = () => input({ type: 'keyDown', keyCode: 'A' }, { type: 'char', keyCode: 'a' }, { type: 'keyUp', keyCode: 'A' });
  let browserPage;
  // Chromium trusted wheel input also exercises the isolated preload guard;
  // Electron's sendInputEvent wheel synthesis is not delivered under Linux Xvfb.
  const wheelAt = async (x, y) => { await browserPage.mouse.move(x, y); await browserPage.mouse.wheel(0, 300); await sleep(80); };
  const wheel = () => wheelAt(250, 250);
  const read = () => run('({hits,dialogHits,globalHits,wheels,contexts,drops,value:document.getElementById("entry").value,scrollY})');
  await bot('navigate', `${base}/normal`);
  browserPage = await until(() => app.context().pages().find(page => page.url().startsWith(base)));
  assert.deepEqual(await app.evaluate(() => { const p = globalThis.pane.view.webContents.getLastWebPreferences(); return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration }; }), { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(await run('typeof require'), 'undefined');
  assert.equal(await app.evaluate(async () => globalThis.pane.view.webContents.mainFrame.frames[0].executeJavaScript('typeof require')), 'undefined');
  assert.equal((await action('viewState')).holder, 'bot');
  await assert.rejects(action('userNavigate', `${base}/forbidden`), /取得浏览器控制权/);
  await assert.rejects(action('userBack'), /取得浏览器控制权/);
  await assert.rejects(action('userForward'), /取得浏览器控制权/);
  await click(100, 70); await click(100, 70, 'right'); await wheel();
  await bot('type', 'entry', 'agent'); await key();
  await app.evaluate(async () => { await globalThis.pane.view.webContents.insertText('IME'); });
  const locked = await read();
  assert.equal(locked.hits, 0); assert.equal(locked.globalHits, 0); assert.equal(locked.wheels, 0); assert.equal(locked.contexts, 0); assert.equal(locked.scrollY, 0); assert.equal(locked.value, 'agent');
  await run('document.getElementById("modal").showModal()');
  const modal = await run('(()=>{const r=document.getElementById("modalButton").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await click(modal.x, modal.y); assert.equal((await read()).dialogHits, 0);
  await bot('click', 'Dialog action'); assert.equal((await read()).dialogHits, 1, 'Agent DOM actions still work while user input is locked');
  await run('document.getElementById("modal").close();window.globalHits=0');
  await click(400, 70);
  assert.equal(await app.evaluate(async () => { const frame = globalThis.pane.view.webContents.mainFrame.frames[0]; return frame.executeJavaScript('window.hits'); }), 0, 'Native input is blocked inside a cross-origin frame');
  await wheelAt(400, 70);
  assert.equal(await app.evaluate(async () => globalThis.pane.view.webContents.mainFrame.frames[0].executeJavaScript('window.scrollY')), 0, 'Wheel input is blocked inside a cross-origin frame');
  await app.evaluate(async () => { const wc = globalThis.pane.view.webContents; await wc.mainFrame.frames[0].executeJavaScript('document.getElementById("frameEntry").focus()'); await wc.insertText('BLOCKED'); });
  assert.equal(await app.evaluate(async () => globalThis.pane.view.webContents.mainFrame.frames[0].executeJavaScript('document.getElementById("frameEntry").value')), '', 'Text insertion is blocked inside a cross-origin frame');

  await action('setHolder', 'user'); await click(100, 70); assert.equal((await read()).hits, 1);
  await click(400, 70);
  assert.equal(await app.evaluate(async () => globalThis.pane.view.webContents.mainFrame.frames[0].executeJavaScript('window.hits')), 1);
  await click(100, 140); await key();
  await app.evaluate(async () => { await globalThis.pane.view.webContents.insertText('IME'); });
  assert.match((await read()).value, /aIME/);
  // Starting between the scroll bounds tests movement independent of native wheel direction.
  await run('window.scrollTo(0,600)');
  const scrollBefore = (await read()).scrollY;
  await wheel();
  await until(async () => (await read()).scrollY !== scrollBefore).catch(async error => {
    throw new Error(`${error.message}: ${JSON.stringify(await run('({scrollY,wheels,focused:document.hasFocus(),height:innerHeight,scrollHeight:document.documentElement.scrollHeight})'))}`);
  });
  await sleep(200); // Let the wheel action that was accepted while owned settle.
  for (const [name, args] of [['navigate', [`${base}/bot-forbidden`]], ['click', ['Normal action']], ['type', ['entry', 'bad']], ['scroll', ['down']], ['back', []]]) await assert.rejects(bot(name, ...args), /用户正在控制浏览器/);
  assert.match(await bot('snapshot'), /Normal action/);

  await action('setHolder', 'bot');
  const before = await read(); await click(100, 70); await wheel(); await key();
  await app.evaluate(async () => { await globalThis.pane.view.webContents.insertText('BLOCKED'); });
  assert.deepEqual(await read(), before, 'Revocation takes effect immediately without a page reload');
  await assert.rejects(action('setHolder', 'invalid'), /无效/);
  assert.equal((await action('viewState')).holder, 'bot');
  await host.locator('#host').fill('Chat still works'); assert.equal(await host.locator('#host').inputValue(), 'Chat still works');

  await app.evaluate((_, url) => { void globalThis.pane.driver.navigate(url); }, `${base}/loading`);
  await until(() => app.evaluate(() => globalThis.pane.viewState().loading)); await sleep(150);
  await app.evaluate(() => { globalThis.pendingClick = globalThis.pane.driver.click('Normal action').then(() => 'unexpected success', error => error.message); });
  await click(100, 70); // The document is visible but its resource has not finished loading.
  await action('setHolder', 'user'); await click(100, 70);
  await action('setHolder', 'bot'); await click(100, 70);
  releaseSlow(); await until(async () => !(await action('viewState')).loading);
  assert.equal((await read()).hits, 1, 'Only the click made after takeover was accepted during loading');
  assert.match(await app.evaluate(() => globalThis.pendingClick), /控制权已切换/, 'An old queued Agent action cannot run after a takeover/release cycle');
  console.log('Verified native input lock, wheel/keyboard/IME, page handlers, modal and cross-origin frame clicks, loading-time takeover/revocation, agent actions and main-window chat.');
});

