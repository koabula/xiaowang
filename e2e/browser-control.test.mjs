import { electron, launchPackaged, closeTestApp } from './launch.mjs';
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

test('desktop browser: IPC ownership, takeover UI, reload hydration and navigation', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-browser-ui-')); const profile = path.join(root, 'profile'); await mkdir(profile);
  const web = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(fixtureHtml()); }); const url = await listen(web);
  const model = createServer(async (request, response) => {
    if (request.url?.endsWith("/models")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw);
    const navigated = input.messages.some(message => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: navigated ? { content: '浏览器已就绪。' } : { content: '打开测试网页。', tool_calls: [{ id: 'browse', type: 'function', function: { name: 'browser_navigate', arguments: JSON.stringify({ url: `${url}/one` }) } }] } }] }));
  }); const modelUrl = await listen(model);
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({ model: 'fixture', baseUrl: `${modelUrl}/v1`, apiKey: 'local', locale: 'zh' }));
  const env = { ...process.env, XIAOWANG_HOME: path.join(root, 'home'), XIAOWANG_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = process.env.XIAOWANG_E2E_EXECUTABLE ? await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, ['--no-sandbox'], env) : await electron.launch({ args: ['--no-sandbox', 'desktop/dist/main.js'], env });
  t.after(async () => { await closeTestApp(app); await closeServer(web); await closeServer(model); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.composer');
  await page.evaluate(() => window.xiaowang.ask('xiaowang', '打开测试网页'));
  await page.getByRole('button', { name: '取得控制权', exact: true }).waitFor();
  for (const method of ['browserGo', 'browserBack', 'browserForward']) await assert.rejects(page.evaluate(({ method, url }) => window.xiaowang[method](url), { method, url: `${url}/blocked` }), /取得浏览器控制权/);
  await page.getByRole('button', { name: '取得控制权', exact: true }).click();
  await page.locator('.capsule').filter({ hasText: '你正在控制' }).waitFor();
  await page.evaluate(url => window.xiaowang.browserGo(url), `${url}/two`);
  await page.reload(); await page.waitForSelector('.composer');
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await page.locator('.capsule').filter({ hasText: '你正在控制' }).waitFor();
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).browser.holder, 'user');
  await page.evaluate(() => window.xiaowang.browserBack());
  await until(async () => (await page.evaluate(() => window.xiaowang.getState())).browser.url.endsWith('/one'));
  await page.evaluate(() => window.xiaowang.browserForward());
  await until(async () => (await page.evaluate(() => window.xiaowang.getState())).browser.url.endsWith('/two'));
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '取得控制权', exact: true }).waitFor();
  await assert.rejects(page.evaluate(url => window.xiaowang.browserGo(url), `${url}/blocked-again`), /取得浏览器控制权/);
  await assert.rejects(page.evaluate(() => window.xiaowang.browserHolder('invalid')), /无效/);
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).browser.holder, 'bot');
  console.log('Verified actual desktop IPC guards, takeover/release controls, allowed back/forward navigation and ownership hydration after renderer reload.');
});
