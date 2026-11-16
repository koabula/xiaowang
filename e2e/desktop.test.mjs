import { modelText } from './fixtures/model-content.mjs';
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { WebSocketServer } from "ws";
import { Runtime } from "../src/runtime.ts";
import { launchPackaged, closeTestApp } from "./launch.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(50); }
  throw new Error("Expected desktop condition did not become true.");
}
function tone(ms = 180) {
  const pcm = Buffer.alloc(Math.floor(24000 * ms / 1000) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 7000), i * 2);
  return pcm.toString("base64");
}


function tinyPdf(sentence, pages = 3) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids=[];
  for(let page=1;page<=pages;page++) {
    const id=objects.length+1; kids.push(`${id} 0 R`);
    const content=`BT /F1 18 Tf 72 720 Td (${page===1?sentence:`PAGE-${page}-UNIQUE-SEARCH`}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id+1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let pdf="%PDF-1.4\n";const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset=>{pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;});
  return Buffer.from(pdf+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test("desktop: voice interruption, PDF Viewer, bot files, settings and saved state", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xw-desktop-"));
  const home = path.join(root, "home"); const userData = path.join(root, "profile");
  await mkdir(userData, { recursive: true });
  const seed = Runtime.open(home);
  const reference = seed.store.addLibraryBytes(seed.activeBot().id, "paper.pdf", tinyPdf("EVIDENCE-SENTENCE-42")).ref;
  seed.store.addLibraryBytes(seed.activeBot().id, "notes.md", Buffer.from("# Notes\nA short research note."));
  seed.close();
  let releaseFirstText;
  const firstTextGate = new Promise(resolve => { releaseFirstText = resolve; });
  let textRequests = 0;
  const model = createServer(async (request, response) => {
    if (request.url?.endsWith("/models")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [] })); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.stream, true);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const readPdf = input.messages.some(message => modelText(message).includes("阅读PDF"));
    const evidence = input.messages.findLast(message => message.role === "tool" && typeof message.content === "string" && message.content.includes("EVIDENCE-SENTENCE-42"));
    if (readPdf && !evidence) {
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read_pdf", function: { name: "read_document", arguments: JSON.stringify({ file: reference.id }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`); return;
    }
    if (readPdf) {
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `原文：EVIDENCE-SENTENCE-42。[来源，第1页](xwref://${reference.id}?page=1)` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); return;
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "已核对资料" } }] })}\n\n`);
    if (++textRequests === 1) await firstTextGate;
    await sleep(120);
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "，结果已经保存。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(resolve => server.once("listening", resolve));
  const realtimeUrl = `ws://127.0.0.1:${server.address().port}/realtime`;
  let connection; let requests = 0; let microphonePackets = 0; const outputs = []; let latestInstructions = ""; let forcedResponse = "";
  server.on("connection", (socket, request) => {
    connection = socket; assert.equal(request.headers.authorization, "Bearer test-realtime-key");
    const emit = value => socket.send(JSON.stringify(value));
    emit({ type: "session.created" });
    socket.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === "response.cancel" && forcedResponse) { emit({type:"response.done",response:{id:forcedResponse,status:"cancelled",output:[]}});forcedResponse="";return; }
      if (event.type === "input_audio_buffer.append") { microphonePackets++; return; }
      if (event.type === "session.update") { latestInstructions = event.session.instructions; emit({ type: "session.updated" }); return; }
      if (event.item?.type === "function_call_output") outputs.push(event.item);
      if (event.type !== "response.create") return;
      requests++;
      const id = `r${requests}`;
      emit({ type: "response.created", response: { id } });
      const tool = (name, args) => emit({ type: "response.function_call_arguments.done", response_id: id, call_id: `c${requests}`, name, arguments: JSON.stringify(args) });
      const speak = text => { emit({ type: "response.output_audio_transcript.done", response_id: id, transcript: text }); emit({ type: "response.output_audio.delta", response_id: id, item_id: `item${requests}`, content_index: 0, delta: tone() }); };
      if (requests === 1) tool("show_stage", { mode: "canvas", path: "deck.html", page: 1 });
      else if (requests === 2) speak("第一页：我们先明确研究问题。");
      else if (requests === 3) tool("show_stage", { mode: "canvas", path: "deck.html", page: 2 });
      else if (requests === 4) { speak("第二页：讨论结果和局限。这份材料已经讲完。"); tool("manage_presentation", { action: "complete" }); }
      else if (requests === 5) tool("delegate_task", { task: "核对语音任务", notify: "when_idle" });
      else if (requests === 6) speak("好，任务已经排队。完成后告诉你。");
      else if (requests >= 8) speak("已听到新的问题。");
      else if (latestInstructions.includes("后台任务状态数据")) speak("核对任务完成了，结果在任务记录里。");
      emit({ type: "response.done", response: { id, status: "completed", output: [] } });
    });
  });
  let app; let stage = "launch"; const processErrors = [];
  function reached(value) { stage = value; if (process.env.XIAOWANG_E2E_DEBUG) console.log(`Desktop check: ${value}`); }
  t.after(async () => {
    releaseFirstText();
    if (stage !== "complete") console.log(`Last desktop step: ${stage}\n${processErrors.join("").slice(-6000)}`);
    if (app) await closeTestApp(app);
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const env = { ...process.env, XIAOWANG_HOME: home, XIAOWANG_USER_DATA: userData, XIAOWANG_REALTIME_URL: realtimeUrl,
    XIAOWANG_MODEL: "fixture", XIAOWANG_BASE_URL: modelUrl, XIAOWANG_API_KEY: "local-test-key", XIAOWANG_REALTIME_SERVICE: "openai", XIAOWANG_REALTIME_MODEL: "gpt-realtime-2.1", XIAOWANG_REALTIME_KEY: "test-realtime-key" };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
  if (!process.env.XIAOWANG_E2E_EXECUTABLE) args.push("desktop/dist/main.js");
  app = process.env.XIAOWANG_E2E_EXECUTABLE ? await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE, args, env) : await electron.launch({ args, env, timeout: 15000 });
  app.process().stderr?.on("data", data => processErrors.push(data.toString()));
  const page = await app.firstWindow({ timeout: 15000 }); const errors = []; reached("window");
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForLoadState("load");
  await page.addInitScript(()=>{window.audioMeters=[];const create=AudioContext.prototype.createAnalyser;AudioContext.prototype.createAnalyser=function(...args){const meter=create.apply(this,args);window.audioMeters.push(meter);return meter;};});
  await page.reload();
  await page.waitForFunction(() => Boolean(window.xiaowang));
  reached("preload");
  await page.waitForSelector(".composer");
  await mkdir(path.join(home, "bots", "xiaowang", "workspace"), { recursive: true });
  await writeFile(path.join(home, "bots", "xiaowang", "workspace", "deck.html"), '<!doctype html><meta charset="utf-8"><title>测试材料</title><style>body{margin:0;font:24px sans-serif}.slide{padding:40px;min-height:400px}</style><section class="slide">研究问题</section><section class="slide" style="display:none">讨论与局限</section>');
  await mkdir(path.join(home,'bots','xiaowang','workspace','slides'),{recursive:true});
  await writeFile(path.join(home,'bots','xiaowang','workspace','slides','legacy.html'),`<!doctype html><style>body{margin:0;overflow:hidden}.s{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;padding:40px}.s.on{display:flex}</style>${Array.from({length:11},(_,i)=>`<div class="s ${i===0?'on':''}">Page ${i+1}</div>`).join('')}<script>const S=[...document.querySelectorAll('.s')];let i=0;function go(d){i=Math.max(0,Math.min(S.length-1,i+d));S.forEach((s,k)=>s.classList.toggle('on',k===i))}onkeydown=e=>{if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1)}</script>`);
  await page.evaluate(() => window.xiaowang.callStart("xiaowang"));
  await page.waitForSelector(".voice-panel"); reached("microphone setup"); await until(() => microphonePackets > 0); reached("microphone packets");
  connection.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  connection.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "带我把整份材料逐页讲完" }));
  connection.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  connection.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
  await until(() => requests >= 4); reached("walkthrough");
  await until(async () => (await page.locator(".voice-progress").textContent())?.includes("已讲完"));
  assert.equal(outputs.filter(output => output.call_id === "c1").length, 1);
  assert.match(outputs.find(output => output.call_id === "c1").output, /第 1 页，共 2 页/);
  assert.match(outputs.find(output => output.call_id === "c3").output, /第 2 页，共 2 页/);
  const frame = page.frameLocator(".canvas-frame"); assert.equal(await frame.locator(".slide.active").textContent(), "讨论与局限");
  await sleep(700); assert.equal(requests, 4, "Completed presentations do not loop forever.");
  await page.getByRole("button", { name: "静音", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "取消静音", exact: true }).getAttribute("aria-pressed"), "true");
  const composer = page.locator(".composer textarea");
  await composer.fill("核对这份资料");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  assert.equal((await page.evaluate(() => window.xiaowang.getState())).jobs.length, 0, "Confirming an IME candidate must not send a message.");
  await composer.press("Enter");
  await composer.fill("再核对一遍");
  await page.getByRole("button", { name: "排队新任务", exact: true }).click();
  releaseFirstText();
  await until(async () => (await page.evaluate(() => window.xiaowang.getState())).jobs.filter(job => job.status === "succeeded").length === 2);
  const state = await page.evaluate(() => window.xiaowang.getState());
  reached("queued text jobs");
  assert.equal(state.jobs.length, 2); assert.ok(state.jobs.every(job => job.result === "已核对资料，结果已经保存。"));
  connection.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  connection.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "帮我核对一下资料，完成后告诉我" }));
  connection.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  connection.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
  await until(() => requests >= 7); reached("voice job notification");
  assert.ok(outputs.some(output => output.call_id === "c5" && JSON.parse(output.output).id));
  await until(async () => (await page.locator(".voice-caption").textContent()).includes("核对任务完成了"));
  reached("audible interruption through the complete call pipeline");
  const outputEnergy=()=>page.evaluate(()=>{const meter=window.audioMeters.at(-1);if(!meter)return 0;const data=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);});
  const voiceEvent=value=>connection.send(JSON.stringify(value));
  for(const generated of [true,false]) {
    const id=generated?'already-generated':'still-generating';
    voiceEvent({type:'response.created',response:{id}});
    voiceEvent({type:'response.output_audio.delta',response_id:id,item_id:`item_${id}`,content_index:0,delta:tone(3000)});
    if(generated)voiceEvent({type:'response.done',response:{id,status:'completed',output:[]}});else forcedResponse=id;
    await until(async()=>await outputEnergy()>.08);
    const started=Date.now();voiceEvent({type:'input_audio_buffer.speech_started'});
    await until(async()=>await outputEnergy()<.001,1000);
    assert.ok(Date.now()-started<300,'Speech must stop at the renderer without waiting for server cancellation');
    voiceEvent({type:'input_audio_buffer.speech_stopped'});
    voiceEvent({type:'response.output_audio.delta',response_id:id,item_id:`item_${id}`,delta:tone(1000)});
    voiceEvent({type:'response.output_audio.delta',item_id:`item_${id}`,delta:tone(1000)});
    voiceEvent({type:'response.output_audio.delta',delta:tone(1000)});
    await sleep(160);assert.ok(await outputEnergy()<.001,'Old audio must stay silent after the user stops speaking');
    voiceEvent({type:'input_audio_buffer.committed'});
    await until(async()=>await outputEnergy()>.05);
    await until(async()=>await outputEnergy()<.001);
  }
  reached("PDF extraction"); await page.evaluate(() => window.xiaowang.ask("xiaowang", "阅读PDF并引用来源")); reached("PDF source link");
  await page.locator(`.bubble a[href^="xwref://"]`).last().click();
  await page.waitForFunction(() => document.querySelector(".pdf-scroll canvas")?.width > 0);
  await until(async () => await page.locator(".reader-loading").count() === 0);
  assert.equal(await page.locator(".reader-error").count(), 0);
  assert.equal(await page.locator('.pdfViewer .page').count(),3);
  await page.locator('.pdfViewer .textLayer').first().waitFor();
  await page.locator('.pdfViewer .textLayer span').filter({hasText:'EVIDENCE-SENTENCE-42'}).waitFor();
  await page.locator('.pdf-scroll').hover();await page.mouse.wheel(0,800);
  await until(async()=>Number(await page.getByRole('textbox',{name:'PDF page / PDF页码',exact:true}).inputValue())>=2);
  await page.getByRole('button',{name:'Search PDF / 搜索文档',exact:true}).click();
  await page.getByRole('textbox',{name:'Find in PDF / 在PDF中查找',exact:true}).fill('PAGE-3-UNIQUE-SEARCH');
  await page.locator('.textLayer .highlight').waitFor();
  await until(async()=>(await page.getByRole('textbox',{name:'PDF page / PDF页码',exact:true}).inputValue())==='3');
  await page.getByRole('button',{name:'Close PDF search / 关闭文档搜索',exact:true}).click();
  await page.getByRole('combobox',{name:'PDF zoom / PDF缩放',exact:true}).selectOption('125');
  const pdfZoom = page.getByRole('combobox', { name: 'PDF zoom / PDF缩放', exact: true });
  const pageWidth = await page.locator('.pdfViewer .page').first().evaluate(node => node.getBoundingClientRect().width);
  const appZoom = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(item => item.getType() === 'window').getZoomFactor());
  await page.locator('.pdf-scroll').evaluate(node => {
    const rect = node.getBoundingClientRect();
    const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: -24, clientX: rect.x + 100, clientY: rect.y + 100, bubbles: true, cancelable: true });
    node.dispatchEvent(event); if (!event.defaultPrevented) throw new Error('Pinch did not suppress application zoom');
  });
  await until(async () => Number(await pdfZoom.inputValue()) > 125);
  assert.ok(await page.locator('.pdfViewer .page').first().evaluate(node => node.getBoundingClientRect().width) > pageWidth);
  const pinchZoom = await pdfZoom.inputValue();
  await page.locator('.pdf-scroll').evaluate(node => node.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true })));
  assert.equal(await pdfZoom.inputValue(), pinchZoom, 'Ordinary scroll must not zoom');
  for (const [deltaY, expected] of [[-10000, '400'], [10000, '25']]) {
    await page.locator('.pdf-scroll').evaluate((node, deltaY) => { for (let n = 0; n < 20; n++) node.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY, bubbles: true, cancelable: true })); }, deltaY);
    assert.equal(await pdfZoom.inputValue(), expected);
  }
  assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(item => item.getType() === 'window').getZoomFactor()), appZoom);
  await page.waitForTimeout(100);
  await page.getByRole('combobox',{name:'PDF zoom / PDF缩放',exact:true}).selectOption('page-width');
  await page.evaluate(id=>window.xiaowang.openReference('xiaowang',id,1),reference.id);
  await until(async()=>(await page.getByRole('textbox',{name:'PDF page / PDF页码',exact:true}).inputValue())==='1');
  await page.setViewportSize({ width: 900, height: 800 });
  await page.screenshot({ path: path.join(root, "workspace.png") });
  if (process.env.XIAOWANG_SCREENSHOT_DIR) {
    await mkdir(process.env.XIAOWANG_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.XIAOWANG_SCREENSHOT_DIR, "workspace.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(process.env.XIAOWANG_SCREENSHOT_DIR, "workspace-dark.png") });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole("button", { name: "挂断", exact: true }).click();
  await page.waitForSelector(".voice-panel", { state: "detached" });
  assert.ok((await page.evaluate(() => window.xiaowang.events("xiaowang"))).some(item => item.kind === "call"));
  reached("file browser");
  await page.getByRole('button',{name:'从资料库打开',exact:true}).click();
  const files=page.getByRole('dialog',{name:'浏览任务资料',exact:true});await files.waitFor();
  await files.getByRole('button',{name:'工作区文件',exact:true}).click();
  await files.getByRole('row').filter({hasText:'deck.html'}).waitFor();
  await files.getByRole('row').filter({hasText:'slides'}).dblclick();
  const legacyFile=files.getByRole('row').filter({hasText:'legacy.html'});await legacyFile.waitFor();
  await files.getByRole('button',{name:'上级目录',exact:true}).click();await files.getByRole('row').filter({hasText:'deck.html'}).waitFor();
  await files.getByRole('row').filter({hasText:'slides'}).dblclick();await legacyFile.waitFor();await legacyFile.press('Enter');
  await page.locator('.canvas-stage .reader-pager').filter({hasText:'1 / 11'}).waitFor();
  assert.equal(await page.locator('.canvas-stage .reader-error').count(),0);
  await page.getByRole('button',{name:'Next page / 下一页',exact:true}).click();
  await page.frameLocator('.canvas-frame').locator('.s.on').filter({hasText:'Page 2'}).waitFor();
  await page.getByRole('button',{name:'从资料库打开',exact:true}).click();await files.waitFor();
  assert.equal(await files.getByRole('combobox',{name:'文件类型',exact:true}).inputValue(),'canvas');
  await files.getByRole('combobox',{name:'文件类型',exact:true}).selectOption('all');
  await files.getByRole('button',{name:'导入原件',exact:true}).click();
  await files.getByRole('textbox',{name:'搜索任务资料',exact:true}).fill('notes.md');
  const note=files.getByRole('row').filter({hasText:'notes.md'});await note.waitFor();await files.getByRole('row').filter({hasText:'paper.pdf'}).waitFor({state:'detached'});await note.click();
  if(process.env.XIAOWANG_SCREENSHOT_DIR){await page.setViewportSize({width:1280,height:840});await page.screenshot({path:path.join(process.env.XIAOWANG_SCREENSHOT_DIR,'file-browser.png')});}
  await note.dblclick();
  await page.locator('.document-reader .prose').filter({hasText:'A short research note.'}).waitFor();
  await page.getByRole('button',{name:'从资料库打开',exact:true}).click();
  await files.getByRole('button',{name:'最近打开',exact:true}).click();
  await files.getByRole('row').filter({hasText:'notes.md'}).waitFor();
  await files.getByRole('button',{name:'关闭资料浏览器',exact:true}).click();
  reached("unsaved settings");
  await page.locator('button.settings').click();
  const settings=page.getByRole('form',{name:'设置',exact:true});await settings.waitFor();
  assert.equal(await settings.getByText('网页搜索',{exact:true}).count(),0);
  const modelInput=settings.locator('input[placeholder="deepseek-chat"]');await modelInput.fill('unsaved-model');
  await settings.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await modelInput.inputValue(),'unsaved-model');
  await settings.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();await settings.waitFor({state:'detached'});
  assert.equal((await page.evaluate(()=>window.xiaowang.getState())).settings.model,'fixture');
  await page.locator('button.settings').click();await settings.waitFor();
  await modelInput.fill('saved-model');await settings.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'保存并关闭',exact:true}).click();await settings.waitFor({state:'detached'});
  assert.equal((await page.evaluate(()=>window.xiaowang.getState())).settings.model,'saved-model');
  await page.locator('button.settings').click();await settings.waitFor();await modelInput.fill('save-failure-draft');
  const secretFile=path.join(userData,'secrets.bin');await rename(secretFile,`${secretFile}.backup`);await mkdir(secretFile);
  await settings.getByRole('button',{name:'保存并进入',exact:true}).click();
  await settings.locator('footer p').waitFor();assert.equal(await modelInput.inputValue(),'save-failure-draft');
  await rm(secretFile,{recursive:true,force:true});await rename(`${secretFile}.backup`,secretFile);
  await settings.getByRole('button',{name:'关闭',exact:true}).click();
  if(process.env.XIAOWANG_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.XIAOWANG_SCREENSHOT_DIR,'unsaved-settings.png')});
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();await settings.waitFor({state:'detached'});
  await page.locator('button.settings').click();await settings.waitFor();
  await settings.getByRole('button',{name:'关闭',exact:true}).click();await settings.waitFor({state:'detached'});
  if(app.evaluate) {
    await page.locator('button.settings').click();await settings.waitFor();await modelInput.fill('native-close-unsaved');
    await page.waitForTimeout(80);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await page.getByRole('alertdialog').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    assert.equal(await modelInput.inputValue(),'native-close-unsaved');
    await app.evaluate(({app})=>app.quit());
    await page.getByRole('alertdialog').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    await settings.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  }
  assert.deepEqual(errors, []); reached("complete");
  console.log(`Verified real desktop flow: ${microphonePackets} microphone packets, ${requests} voice responses, queued jobs, long-audio interruptions, continuous PDF reading, file browsing, unsaved settings and failure recovery.`);
});
