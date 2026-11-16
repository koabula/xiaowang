import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { closeTestApp } from './launch.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('desktop sends supplements as chat, queues new work explicitly and plays one hangup cue per call', {timeout:60000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xw-followup-'));
  const profile = path.join(root, 'profile'); await mkdir(profile);
  const first = deferred(), release = deferred();
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    if (requests.length === 1) { first.resolve(); await release.promise; }
    const content = requests.length === 1 ? 'Original answer' : requests.length === 2 ? 'Updated answer' : 'Queued answer';
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'secrets.bin'), JSON.stringify({baseUrl:`http://127.0.0.1:${server.address().port}/v1`, model:'fixture', apiKey:'local',locale:'zh'}));
  const env = {...process.env,XIAOWANG_HOME:path.join(root,'home'),XIAOWANG_USER_DATA:profile,XIAOWANG_DISABLE_UPDATES:'1'}; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({args:['--no-sandbox','desktop/dist/main.js'],env});
  t.after(async()=>{release.resolve();await closeTestApp(app);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:10});});
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const input = page.locator('.composer textarea'); await input.waitFor();
  await input.fill('Analyze the paper'); await input.press('Enter'); await first.promise;
  await input.fill('Focus on experiments'); await input.press('Enter');
  await page.waitForFunction(async()=> (await window.xiaowang.events('xiaowang')).some(item=>item.text==='Focus on experiments'));
  await input.fill('Keep it brief'); await input.press('Enter');
  const accepted = await page.evaluate(() => window.xiaowang.ask('xiaowang', 'Also explain the baseline'));
  assert.ok(accepted.some(item => item.text === 'Also explain the baseline'), 'Accepted supplements resolve while the model is still working');
  await input.fill('SEPARATE-TASK'); await page.getByRole('button',{name:'排队新任务',exact:true}).click();
  await page.waitForFunction(async()=> (await window.xiaowang.getState()).jobs.length===2);
  release.resolve();
  await page.waitForFunction(async()=> (await window.xiaowang.getState()).jobs.every(job=>job.status==='succeeded'));
  assert.equal(requests.length,3);
  const middle=JSON.stringify(requests[1].messages);
  assert.match(middle,/Focus on experiments/); assert.match(middle,/Keep it brief/); assert.doesNotMatch(middle,/SEPARATE-TASK/);
  const messages=await page.evaluate(()=>window.xiaowang.events('xiaowang'));
  assert.equal(messages.filter(item=>item.kind==='user').length,5);
  assert.equal(await page.getByText('已收到，将在下一步处理',{exact:true}).count(),0);

  await page.evaluate(()=>{
    window.hangupNotes=[];window.soundClosed=0;
    window.AudioContext=class {
      currentTime=0;destination={};
      resume(){return Promise.resolve()}
      close(){window.soundClosed++;return Promise.resolve()}
      createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}}
      createOscillator(){
        const oscillator={frequency:{value:0},connect(gain){return gain},start(){window.hangupNotes.push(this.frequency.value)},stop(){setTimeout(()=>this.onended?.(),5)}};
        return oscillator;
      }
    };
  });
  const send = note => app.evaluate(({BrowserWindow}, data)=>BrowserWindow.getAllWindows()[0].webContents.send('call',data),{slug:'xiaowang',...note});
  await send({callId:'first',phase:'connecting'});
  await send({callId:'first',phase:'closed'});
  await page.waitForFunction(()=>window.soundClosed===1);
  await send({callId:'first',phase:'closed'});
  await send({callId:'second',phase:'connecting'});
  await send({callId:'second',phase:'closed',preview:true});
  await send({callId:'second',phase:'closed'});
  await page.waitForFunction(()=>window.soundClosed===2);
  assert.deepEqual(await page.evaluate(()=>window.hangupNotes),[660,440,660,440]);
  assert.deepEqual(errors,[]);
});
