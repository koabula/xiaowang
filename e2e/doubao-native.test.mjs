import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron} from 'playwright';
import {WebSocketServer} from 'ws';
import {launchPackaged, closeTestApp} from './launch.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await sleep(30);}throw new Error('Expected native Doubao condition did not become true');}
function tone(ms=400){const pcm=Buffer.alloc(ms*48);for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/24000)*8000),i*2);return pcm.toString('base64');}

test('desktop: native Doubao anonymous audio, ASR interruption, FC continuation and mute keepalive', {timeout:60000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'xw-doubao-'));const profile=path.join(root,'profile');await mkdir(profile);
 await writeFile(path.join(profile,"secrets.bin"),JSON.stringify({model:"fixture",baseUrl:"http://localhost:1",apiKey:"local-key",realtimeService:"doubao",realtimeModel:"1.2.6.1",realtimeKey:"local-doubao-key",locale:"zh"}));
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(resolve=>server.once('listening',resolve));
 let socket;let micPackets=0;let muted=false;const outputs=[];
 const emit=value=>socket.send(JSON.stringify(value));
 const speak=(id,text,ms=400)=>{emit({type:'response.output_text.delta',response_id:id,question_id:id,delta:text});emit({type:'response.output_audio.started',response_id:id,question_id:id,tts_type:'default'});emit({type:'response.output_text.done',response_id:id,question_id:id,text});emit({type:'response.output_audio.delta',delta:tone(ms)});emit({type:'response.output_audio.done',response_id:id,question_id:id});emit({type:'response.done',response:{usage:{output_audio_tokens:1}}});};
 server.on('connection',(connection,request)=>{socket=connection;assert.equal(request.headers['x-api-key'],'local-doubao-key');connection.on('message',raw=>{
  const event=JSON.parse(raw.toString());
  if(event.type==='session.create'){emit({type:'session.created',session:{id:'native-session'}});return;}
  if(event.type==='session.update'){emit({type:'session.updated'});return;}
  if(event.type==='input_audio_buffer.append'){micPackets++;return;}
  if(event.type==='input_audio_mute.commit'){muted=true;return;}if(event.type==='input_audio_unmute.commit'){muted=false;return;}
  if(event.type==='response.cancel'){emit({type:'response.canceled'});return;}
  if(event.type==='conversation.item.create'&&event.items?.[0]?.role==='tool'){outputs.push(...event.items);speak('after-tool','文件查看完成，工作区是空的。');return;}
  if(event.type==='speech_text_buffer.commit')speak('notice',event.text);
 });});
 const env={...process.env,XIAOWANG_HOME:path.join(root,'home'),XIAOWANG_USER_DATA:profile,XIAOWANG_REALTIME_URL:`ws://127.0.0.1:${server.address().port}/realtime`};delete env.ELECTRON_RUN_AS_NODE;
 const args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'];
 const app=process.env.XIAOWANG_E2E_EXECUTABLE?await launchPackaged(process.env.XIAOWANG_E2E_EXECUTABLE,args,env):await electron.launch({args:[...args,'desktop/dist/main.js'],env});
 t.after(async()=>{await closeTestApp(app);for(const c of server.clients)c.terminate();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForLoadState('load');
 await page.addInitScript(()=>{window.meters=[];const create=AudioContext.prototype.createAnalyser;AudioContext.prototype.createAnalyser=function(...args){const meter=create.apply(this,args);window.meters.push(meter);return meter;};});await page.reload();
 await page.waitForSelector('.composer');await page.evaluate(()=>window.xiaowang.callStart('xiaowang'));await until(()=>micPackets>0);
 const energy=()=>page.evaluate(()=>{const meter=window.meters.at(-1);if(!meter)return 0;const values=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(values);return Math.sqrt(values.reduce((sum,v)=>sum+v*v,0)/values.length);});
 const user=(id,text)=>{emit({type:'conversation.item.input_audio_transcription.started',item_id:id});emit({type:'conversation.item.input_audio_transcription.delta',item_id:id,delta:text});emit({type:'conversation.item.input_audio_transcription.completed',item_id:id,text});};
 user('q1','你好');speak('first','你好，我在。',2500);await until(async()=>await energy()>.08);
 const at=Date.now();user('q2','等一下');await until(async()=>await energy()<.001);assert.ok(Date.now()-at<300);
 emit({type:'response.output_audio.delta',delta:tone(1000)});await sleep(160);assert.ok(await energy()<.001);
 speak('second','已听到新的问题。');await until(async()=>await energy()>.08);await until(async()=>await energy()<.001);
 await page.locator('.voice-caption').filter({hasText:'已听到新的问题。'}).waitFor();
 user('q3','查看工作区');emit({type:'response.function_call_arguments.done',question_id:'q3',items:[{call_id:'native-tool',name:'list_files',arguments:{}}]});
 await until(()=>outputs.some(item=>item.call_id==='native-tool'));await until(async()=>await energy()>.08);await until(async()=>await energy()<.001);
 await page.getByRole('button',{name:'静音',exact:true}).click();await until(()=>muted);await page.getByRole('button',{name:'取消静音',exact:true}).click();await until(()=>!muted);
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.locator('.voice-panel').waitFor({state:'detached'});assert.deepEqual(errors,[]);
 console.log(`Verified native Doubao end to end: ${micPackets} microphone packets, audible first and next replies, interruption fence, FC output and mute keepalive.`);
});
