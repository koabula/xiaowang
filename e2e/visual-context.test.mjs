import { electron, closeTestApp } from './launch.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label) { for (let n=0;n<250;n++) {const value=await check();if(value)return value;await sleep(30);}throw Error(label); }
function coloredPdf() {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for (const color of ['1 0 0','0 0 1']) {const id=objects.length+1,content=`${color} rg 0 0 400 500 re f`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Contents ${id+1} 0 R >>`,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);}
  let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;offsets.slice(1).forEach(o=>pdf+=`${String(o).padStart(10,'0')} 00000 n \n`);return Buffer.from(pdf+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
for (const service of ['gemini','openai','qwen']) test(`${service}: sent image + current PDF pixels, silent synchronization, stale/bot isolation and aligned controls`, {timeout:60000}, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),`xw-visual-${service}-`)),profile=path.join(root,'profile');await mkdir(profile);
  const requests=[],packets=[];let socket;
  const model=createServer(async(req,res)=>{if(req.url?.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[]}));return;}let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert.ok(body.tools?.some(tool=>tool.function?.name==='inspect_event'),'No hidden summary request');requests.push(body);res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'Background actual result 731'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);});await new Promise(r=>model.listen(0,'127.0.0.1',r));
  const ws=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>ws.once('listening',r));
  ws.on('connection',client=>{socket=client;if(service!=='gemini')client.send(JSON.stringify({type:'session.created'}));client.on('message',raw=>{const p=JSON.parse(raw.toString());packets.push(p);if(p.setup)client.send(JSON.stringify({setupComplete:{}}));if(p.type==='session.update')client.send(JSON.stringify({type:'session.updated'}));});});
  const selected={gemini:['gemini-3.8-live','Kore'],openai:['gpt-realtime-2.1','marin'],qwen:['qwen3.5-omni-plus-realtime','Cherry']}[service];
  await writeFile(path.join(profile,'secrets.bin'),JSON.stringify({baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'fixture',apiKey:'local',realtimeService:service,realtimeModel:selected[0],realtimeVoice:selected[1],realtimeKey:'fixture-key',locale:'zh'}));
  const env={...process.env,XIAOWANG_HOME:path.join(root,'home'),XIAOWANG_USER_DATA:profile,XIAOWANG_DISABLE_UPDATES:'1',XIAOWANG_REALTIME_URL:`ws://127.0.0.1:${ws.address().port}/${service==='qwen'?'qwencloud':''}`};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required','desktop/dist/main.js'],env});
  t.after(async()=>{await closeTestApp(app);for(const c of ws.clients)c.terminate();await new Promise(r=>ws.close(r));model.closeAllConnections();await new Promise(r=>model.close(r));await rm(root,{recursive:true,force:true,maxRetries:10});});
  const page=await app.firstWindow();page.setDefaultTimeout(12000);await page.waitForSelector('.composer');
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(()=>{window.visualNotes=[];window.xiaowang.onCall(n=>{if(n.phase==='visual')window.visualNotes.push(n);});});
  const png=await app.evaluate(({nativeImage})=>nativeImage.createFromBitmap(Buffer.from([0,255,0,255,0,255,0,255,0,255,0,255,0,255,0,255]),{width:2,height:2}).toPNG().toString('base64'));
  const image=await page.evaluate(data=>window.xiaowang.attach('xiaowang','image.png',Uint8Array.from(atob(data),c=>c.charCodeAt(0))),png);
  await page.evaluate(()=>window.xiaowang.callStart('xiaowang'));await page.locator('.voice-panel.phase-listening').waitFor();
  const frames=()=>packets.flatMap(p=>p.realtimeInput?.video?[p.realtimeInput.video.data]:p.type==='input_image_buffer.append'?[p.image]:p.item?.content?.filter(c=>c.type==='input_image').map(c=>c.image_url.split(',')[1])??[]);
  await sleep(300);assert.equal(frames().length,0,'Imported but unsent draft stays private');
  await page.evaluate(id=>window.xiaowang.ask('xiaowang','看看这张图',[id]),image.refId);await until(()=>frames().length===1,'Sent image not shared');
  assert.equal(await app.evaluate(({nativeImage},data)=>{const img=nativeImage.createFromBuffer(Buffer.from(data,'base64')),p=img.toBitmap();return p[1]>220&&p[0]<30&&p[2]<30;},frames()[0]),true);
  const pdf=await page.evaluate(bytes=>window.xiaowang.attach('xiaowang','pages.pdf',new Uint8Array(bytes)),[...coloredPdf()]);
  await page.evaluate(id=>window.xiaowang.openReference('xiaowang',id,1),pdf.refId);await until(()=>frames().length>=2,'First PDF page not shared');
  await page.getByRole('button',{name:'Next page / 下一页',exact:true}).click();await until(async()=> (await page.evaluate(()=>window.visualNotes)).some(n=>n.visual.phase==='shared'&&n.visual.source==='pages.pdf'&&n.visual.page===2),'Second PDF page not shared');
  const pixels=await app.evaluate(({nativeImage},data)=>{const i=nativeImage.createFromBuffer(Buffer.from(data,'base64')),s=i.getSize(),p=i.toBitmap(),offset=(Math.floor(s.height/2)*s.width+Math.floor(s.width/2))*4;return {size:s,color:[...p.subarray(offset,offset+3)]};},frames().at(-1));
  assert.ok(Math.max(pixels.size.width,pixels.size.height)<=1600);assert.ok(pixels.color[0]>230&&pixels.color[2]<20,'PDF page 2 must be blue, not the previous red page or a blank canvas');
  const stale=await page.evaluate(id=>window.xiaowang.stageVisual('xiaowang',{refId:id,page:1,revision:-1,data:'YWJj'}),pdf.refId);assert.equal(stale,false);
  const before=requests.length;await page.evaluate(()=>window.xiaowang.ask('xiaowang','当前页是什么颜色？'));
  const current=requests[before].messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url');
  assert.ok(current.some(p=>p.image_url.url===`data:image/jpeg;base64,${frames().at(-1)}`),'Background receives the same frozen PDF page pixels');
  assert.equal(packets.some(p=>p.type==='response.create'||p.clientContent?.turnComplete===true),false,'Passive updates cannot request responses');
  if(service==='qwen')assert.ok(packets.findIndex(p=>p.type==='input_audio_buffer.append')<packets.findIndex(p=>p.type==='input_image_buffer.append'));
  const layout=await page.evaluate(()=>{const h=document.querySelector('.thread > header'),m=document.querySelector('.messages'),title=document.querySelector('.bot-title');return {position:getComputedStyle(h).position,border:getComputedStyle(h).borderBottomWidth,header:h.getBoundingClientRect().bottom,messages:m.getBoundingClientRect().top,title:title.getBoundingClientRect().width};});
  assert.equal(layout.position,'absolute');assert.equal(layout.border,'0px');assert.equal(layout.header-layout.messages,64);assert.ok(layout.title>80);
  await page.screenshot({path:path.join(os.tmpdir(),`xw-visual-${service}.png`)});
  const other=await page.evaluate(()=>window.xiaowang.createBot('Other'));await page.locator('.thread > header .bot-title').filter({hasText:'Other'}).waitFor();
  assert.equal(await page.evaluate(id=>window.xiaowang.stageVisual('xiaowang',{refId:id,page:2,revision:2,data:'YWJj'}),pdf.refId),false);
  await page.evaluate(()=>window.xiaowang.callStop());assert.deepEqual(errors,[]);
});
