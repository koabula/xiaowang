import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCall, type AudioIdentity, type VoiceState } from "../desktop/main/call.ts";
import { doubaoSession, DOUBAO_REALTIME_URL, parseRealtimeEvent, realtimeEndpoint } from "../src/realtime.ts";

const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t: { after(fn: () => void): void }, runTool = async (_name: string, _args: string) => "实际工具结果", preview = "") {
  let receive: (event: { data?: unknown }) => void = () => {};
  const sent: Record<string, any>[] = [], states: VoiceState[] = [], audio: Array<{ serial: number; identity?: AudioIdentity }> = [];
  const interruptions: unknown[] = []; const lines: Array<{ who: string; text: string }> = [];
  const call = new LiveCall(DOUBAO_REALTIME_URL, "fake-key", doubaoSession({ instructions: "test", tools: [] }), {
    onPhase() {}, onState(value) { states.push(value); }, onAudio(_pcm, serial, identity) { audio.push({ serial, identity }); },
    onInterrupt(note) { interruptions.push(note); }, onLine(who,text) { lines.push({who,text}); }, onTranscript() {}, runTool,
  }, () => ({send(data) { sent.push(JSON.parse(data)); },close() {},addEventListener(type, callback) { if(type === "message") receive = callback; }}), preview);
  call.start();const emit = (event: unknown) => receive({data:JSON.stringify(event)});emit({type:"session.created"});t.after(()=>call.hangup());
  const asr = (id: string, text: string) => { emit({type:"conversation.item.input_audio_transcription.started",item_id:id});emit({type:"conversation.item.input_audio_transcription.completed",item_id:id,text}); };
  const start = (id: string, question = "q1") => emit({type:"response.output_audio.started",response_id:id,question_id:question,tts_type:"default"});
  const packet = () => emit({type:"response.output_audio.delta",delta:Buffer.alloc(960).toString("base64")});
  const end = (id: string, question = "q1") => emit({type:"response.output_audio.done",response_id:id,question_id:question});
  const usage = () => emit({type:"response.done",response:{usage:{output_audio_tokens:1}}});
  return {call,emit,asr,start,packet,end,usage,audio,sent,states,interruptions,lines};
}

test("Doubao native first reply and later turns play anonymous deltas without response.created", async t => {
  const f=fixture(t);f.asr("q1","你好");
  f.emit({type:"response.output_text.delta",question_id:"q1",response_id:"r1",delta:"你好"});
  f.start("r1");f.packet();f.usage();f.packet();
  assert.equal(f.audio.length,2,"Usage must not stop a live TTS stream");
  assert.equal(f.audio[0]?.identity?.responseId,"r1");
  f.emit({type:"response.output_text.done",question_id:"q1",response_id:"r1",text:"你好"});f.end("r1");f.call.noteSpeakerIdle(2);await delay(400);
  assert.equal(f.states.at(-1)?.phase,"listening");
  f.asr("q2","第二个问题");f.start("r2","q2");f.packet();f.end("r2","q2");f.call.noteSpeakerIdle(3);await delay(400);
  assert.equal(f.audio.length,3);assert.equal(f.states.at(-1)?.phase,"listening");
  assert.ok(f.call.transcript().some(line=>line.who==="user"&&line.text==="第二个问题"));
});

test("Doubao cancellation acknowledgement fences anonymous old audio and permits the next stream", t => {
  const f=fixture(t);f.start("old");f.packet();f.asr("q2","等一下");
  assert.ok(f.sent.some(event=>event.type==="response.cancel"));
  f.packet();f.start("premature","q2");f.packet();assert.equal(f.audio.length,1);
  f.emit({type:"response.canceled"});f.packet();f.start("old");f.packet();assert.equal(f.audio.length,1);
  f.start("new","q2");f.packet();f.usage();f.packet();assert.equal(f.audio.length,3);
  assert.ok(f.audio[1]!.identity!.playbackEpoch!>f.audio[0]!.identity!.playbackEpoch!);
  f.emit({type:"response.canceled"});f.packet();assert.equal(f.audio.length,4,"A duplicate cancel ACK cannot close the new stream");
});

test("Doubao can interrupt already generated but still buffered speech", t => {
  const f=fixture(t);f.start("done");f.packet();f.end("done");f.asr("q2","换一个问题");
  assert.ok(f.sent.some(event=>event.type==="response.cancel"));
  f.emit({type:"response.canceled"});f.packet();assert.equal(f.audio.length,1);
  f.start("new","q2");f.packet();assert.equal(f.audio.length,2);
});

test("a native recognizer reset after cancel is not user speech and cannot cancel the next reply", t => {
  const f=fixture(t);f.start("old");f.packet();f.asr("q2","等一下");f.emit({type:"response.canceled"});
  f.emit({type:"conversation.item.input_audio_transcription.started",item_id:"recognizer-reset",round_id:2});
  const before=f.sent.filter(event=>event.type==="response.cancel").length;
  f.start("new","q2");f.packet();assert.equal(f.audio.length,2);
  assert.equal(f.sent.filter(event=>event.type==="response.cancel").length,before);
});

test("Doubao FC results resume native audio without OpenAI lifecycle events", async t => {
  const calls:string[]=[];const f=fixture(t,async name=>{calls.push(name);return "找到了资料";});f.asr("q1","把文章打开");
  f.emit({type:"response.function_call_arguments.done",question_id:"q1",items:[{call_id:"one",name:"list_files",arguments:{}},{call_id:"two",name:"read_file",arguments:{path:"note.md"}}]});
  await delay();assert.deepEqual(calls,["list_files","read_file"]);
  const returned=f.sent.filter(event=>event.items?.[0]?.role==="tool");assert.deepEqual(returned.map(event=>event.items[0].call_id),["one","two"]);
  f.usage();assert.equal(f.states.at(-1)?.phase,"thinking","Usage from the preceding turn cannot finish the awaited tool reply");
  f.start("after-tool");f.packet();f.end("after-tool");f.call.noteSpeakerIdle(1);await delay(400);
  assert.equal(f.states.at(-1)?.phase,"listening");assert.equal(f.audio.length,1);
  assert.equal(f.sent.some(event=>event.type==="response.create"),false);
});

test("Doubao presentation continuation waits for playback before returning its real tool result", async t => {
  const f=fixture(t);f.call.presentation.start("讲完");f.start("segment");f.packet();
  f.emit({type:"response.function_call_arguments.done",question_id:"q1",items:[{call_id:"continue1",name:"continue_speaking",arguments:{}}]});f.end("segment");
  await delay();assert.equal(f.sent.some(event=>event.items?.[0]?.call_id==="continue1"),false);
  f.call.noteSpeakerIdle(1);await delay(400);assert.ok(f.sent.some(event=>event.items?.[0]?.call_id==="continue1"));
});

test("pausing a native walkthrough holds its continuation until an explicit resume", async t => {
  const f=fixture(t);f.call.presentation.start("讲完");f.start("segment");f.packet();
  f.emit({type:"response.function_call_arguments.done",question_id:"q1",items:[{call_id:"resume-later",name:"continue_speaking",arguments:{}}]});f.end("segment");
  f.call.control("pause");f.emit({type:"response.canceled"});await delay(400);
  assert.equal(f.sent.some(event=>event.items?.[0]?.call_id==="resume-later"),false);
  f.call.control("resume");await delay(400);assert.ok(f.sent.some(event=>event.items?.[0]?.call_id==="resume-later"));
  f.start("resumed");f.packet();assert.equal(f.audio.length,2);
});

test("Doubao preview closes only after native audio ends and the speaker drains", t => {
  const f=fixture(t,undefined,"你好");assert.ok(f.sent.some(event=>event.type==="input_audio_mute.commit"));
  f.start("preview");f.packet();f.end("preview");assert.equal(f.call.isClosed(),false);f.call.noteSpeakerIdle(1);assert.equal(f.call.isClosed(),true);
});

test("Doubao mute sends the provider keepalive mode and resumes input when unmuted", t => {
  const f=fixture(t);f.call.setMuted(true);f.call.sendAudio(Buffer.alloc(640));
  assert.equal(f.sent.filter(event=>event.type==="input_audio_buffer.append").length,0);
  f.call.setMuted(false);f.call.sendAudio(Buffer.alloc(640));assert.equal(f.sent.filter(event=>event.type==="input_audio_buffer.append").length,1);
  assert.ok(f.sent.some(event=>event.type==="input_audio_unmute.commit"));
  assert.equal(parseRealtimeEvent(JSON.stringify({type:"conversation.item.input_audio_transcription.completed",text:"完整文本"}))[0]?.kind,"user_transcript");
});

test("a local endpoint override retains the explicitly selected Doubao protocol and sample rates", () => {
  const endpoint=realtimeEndpoint({url:"ws://localhost:1234/realtime",model:"1.2.6.1",family:"doubao"});
  assert.equal(endpoint.family,"doubao");assert.equal(endpoint.inputRate,16000);assert.equal(endpoint.outputRate,24000);
});

test("Doubao completion notices synthesize a short status rather than speaking internal instructions", async t => {
  const f=fixture(t);f.call.notify("job",JSON.stringify({status:"succeeded",result:"全文结果",task:"内部任务说明"}));await delay(400);
  const greeting=f.sent.find(event=>event.type==="speech_text_buffer.commit");assert.match(greeting?.text,/任务完成/);
  assert.equal(greeting?.text.includes("内部任务说明"),false);assert.equal(f.sent.some(event=>event.items?.[0]?.role==="user"),false);
  f.start("notice");f.packet();f.end("notice");f.call.noteSpeakerIdle(1);await delay(400);assert.equal(f.states.at(-1)?.phase,"listening");
});
