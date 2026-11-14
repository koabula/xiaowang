import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { withCanvasPager } from '../desktop/renderer/canvas-pager.ts';

function tone(ms = 2000) {
  const data=Buffer.alloc(ms*48);for(let i=0;i<data.length/2;i++)data.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/24000)*9000),i*2);return data.toString('base64');
}
test('real renderer: Canvas adapters and interrupted audio never reopen old playback', {timeout:60000}, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'xw-surfaces-'));
  const main=path.join(root,'main.cjs');
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(root)});app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL('data:text/html,<html><body></body></html>');});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:['--no-sandbox','--autoplay-policy=no-user-gesture-required',main],env});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const legacy='<!doctype html><style>body{margin:0;overflow:hidden}.s{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center}.s.on{display:flex}</style><div class="s on">First</div><div class="s">Second</div><script>const S=[...document.querySelectorAll(".s")];let i=0;function go(d){i=Math.max(0,Math.min(S.length-1,i+d));S.forEach((s,k)=>s.classList.toggle("on",k===i))}onclick=()=>go(1)</script>';
  const decks=[
    {html:legacy,selector:'.s.on',layout:'flex'},
    {html:'<style>.slide{display:none}.slide.active{display:grid}</style><section class="slide active">First</section><section class="slide">Second</section>',selector:'.slide.active',layout:'grid'},
    {html:'<div data-xw-slide class="active">First</div><div data-xw-slide hidden>Second</div><script>let p=1;window.xiaowangSlides={getState:()=>({page:p,totalPages:2}),goToPage:n=>setTimeout(()=>{p=n;document.querySelectorAll("[data-xw-slide]").forEach((s,i)=>{s.hidden=i!==n-1;s.classList.toggle("active",i===n-1)})},120)}</script>',selector:'[data-xw-slide].active',layout:'block'}
  ];
  for(const deck of decks){
    await page.evaluate(html=>{document.body.innerHTML='<iframe title="deck" sandbox="allow-scripts" style="width:800px;height:600px"></iframe>';window.reports=[];window.onmessage=e=>{if(e.data?.type==='xiaowang:position')window.reports.push(e.data)};document.querySelector('iframe').srcdoc=html;},withCanvasPager(deck.html));
    const frame=page.frameLocator('iframe');await frame.locator(deck.selector).waitFor();
    const flip=number=>page.evaluate(n=>document.querySelector('iframe').contentWindow.postMessage({type:'xiaowang:page',page:n,requestId:`page-${n}`},'*'),number);
    await flip(1);await page.waitForFunction(()=>window.reports.some(r=>r.requestId==='page-1'&&r.totalPages===2&&!r.error));
    await flip(2);await page.waitForFunction(()=>window.reports.some(r=>r.requestId==='page-2'&&r.page===2&&!r.error));
    assert.equal(await frame.locator(deck.selector).textContent(),'Second');
    assert.equal(await frame.locator(deck.selector).evaluate(el=>getComputedStyle(el).display),deck.layout);
    assert.equal(await page.evaluate(()=>window.reports.some(r=>r.error)),false);
    await flip(3);await page.waitForFunction(()=>window.reports.some(r=>r.error?.includes('超出')));
  }
  // Legacy native controls and the external pager share one cursor.
  await page.evaluate(html=>{document.querySelector('iframe').srcdoc=html;window.reports=[];},withCanvasPager(legacy));
  await page.frameLocator('iframe').locator('.s.on').click();
  await page.waitForFunction(()=>window.reports.some(r=>r.page===2&&!r.error));
  await page.evaluate(()=>document.body.innerHTML='');
  const bundle=await build({entryPoints:['desktop/renderer/call-audio.ts'],bundle:true,platform:'browser',format:'iife',globalName:'AudioModule',write:false});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(async()=>{window.levels=[];window.drains=[];window.audio=AudioModule.createCallAudio(()=>{},serial=>window.drains.push(serial));window.audio.subscribeLevels(v=>window.levels.push({time:performance.now(),...v}));await window.audio.startPlayback(24000);});
  const pcm=tone();
  await page.evaluate(pcm=>window.audio.play(pcm,1,{callId:'call',responseId:'old',itemId:'old-item',playbackEpoch:0}),pcm);
  await page.waitForFunction(()=>window.levels.at(-1)?.output>.1);
  const stop=await page.evaluate(()=>{const at=performance.now();const position=window.audio.interrupt({callId:'call',playbackEpoch:1,throughSerial:1,responseId:'old',itemId:'old-item'});return {at,position};});
  assert.ok(stop.position.playedMs<2000);
  await page.waitForFunction(at=>window.levels.some(v=>v.time>at&&v.output<.001),stop.at);
  const silence=await page.evaluate(at=>window.levels.find(v=>v.time>at&&v.output<.001).time-at,stop.at);
  assert.ok(silence<200,`Audio should stop immediately; observed ${silence} ms`);
  await page.evaluate(pcm=>{window.levels=[];window.audio.play(pcm,2,{callId:'call',responseId:'old',itemId:'old-item',playbackEpoch:0});window.audio.play(pcm,3,{callId:'call',playbackEpoch:0});},pcm);
  await page.waitForTimeout(180);
  assert.ok(await page.evaluate(()=>window.levels.every(v=>v.output<.001)),'Late audio must not restart playback');
  assert.deepEqual(await page.evaluate(()=>window.drains),[],'Interruptions never acknowledge natural completion');
  await page.evaluate(pcm=>window.audio.play(pcm,4,{callId:'call',responseId:'new',itemId:'new-item',playbackEpoch:1}),pcm);
  await page.waitForFunction(()=>window.levels.at(-1)?.output>.1);
  await page.evaluate(()=>window.audio.stop());
  assert.deepEqual(errors,[]);
  console.log(`Verified Canvas native/custom navigation and real audio silence after ${Math.round(silence)} ms.`);
});
