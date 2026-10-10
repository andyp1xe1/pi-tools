import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramSession } from "../../../src/agent-bridge/telegram/session.ts";
import { TelegramUpdateSchema } from "../../../src/agent-bridge/telegram/schemas.ts";
import * as v from "valibot";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail("frontend timed out");}
function fixture(t){
 let current=true;let nextId=50;
 const prompts=[],calls=[],commands=[],errors=[];
 let snapshot={idle:true,model:{provider:"p",id:"m",name:"M"},models:[{provider:"p",id:"m",name:"M"}],thinking:"off",supportedThinking:["off","high"],status:"Model: p/m"};
 const agent={current:()=>current,snapshot:async()=>snapshot,setModel:async model=>{commands.push(["model",model]);return true;},setThinking:async level=>{commands.push(["thinking",level]);return level;},abort:async()=>{commands.push(["abort"]);return true;},compact:async()=>{commands.push(["compact"]);return true;},newSession:async()=>{commands.push(["new"]);return true;},prompt:prompt=>prompts.push(prompt)};
 const transport={
  call:async(method,body,options)=>{calls.push({method,body,options});return{message_id:nextId++};},
  downloadFile:async(id,name,signal)=>{calls.push({method:"download",id,name,signal});return `/tmp/${name}`;},
  transcribeAudio:async(path,model,language,signal)=>{calls.push({method:"transcribe",path,model,language,signal});return "voice words";},
 };
 const session=new TelegramSession(7,agent,transport,error=>errors.push(error));t.after(()=>session.close());
 return{session,agent,transport,prompts,calls,commands,errors,detach:()=>{current=false;},busy:()=>snapshot={...snapshot,idle:false}};
}
const dm=(id,text,extra={})=>({update_id:id,message:{message_id:id,chat:{id:7,type:"private"},from:{id:7,is_bot:false},text,...extra}});
test("plain text, edited messages and image-file paths are prepared in daemon",async t=>{
 const h=fixture(t);h.session.receive(dm(1,"hello"));h.session.receive({update_id:2,edited_message:{...dm(2,"photo").message,photo:[{file_id:"image",file_size:10}]}});
 await until(()=>h.prompts.length===2);assert.equal(h.prompts[0].content[0].text,"[telegram] hello");
 assert.deepEqual(h.prompts[1].content[1],{type:"image-file",path:"/tmp/photo-2.jpg",mimeType:"image/jpeg"});
 assert.equal("source" in h.prompts[1],false);assert.equal("chatId" in h.prompts[0],false);
});
test("static stickers are inline images; animated and video stickers remain correctly named attachments",async t=>{
 const h=fixture(t);
 for (const [index,sticker] of [{file_id:"static"},{file_id:"animated",is_animated:true},{file_id:"video",is_video:true}].entries()) {
  const update=v.parse(TelegramUpdateSchema,dm(index+1,sticker.file_id,{sticker}));
  h.session.receive(update);
 }
 await until(()=>h.prompts.length===3);
 assert.deepEqual(h.prompts[0].content[1],{type:"image-file",path:"/tmp/sticker-1.webp",mimeType:"image/webp"});
 assert.equal(h.prompts[1].content.length,1);assert.match(h.prompts[1].content[0].text,/sticker-2\.tgs/);
 assert.equal(h.prompts[2].content.length,1);assert.match(h.prompts[2].content[0].text,/sticker-3\.webm/);
});

test("stop cancels in-flight voice and queued text without poisoning later input",async t=>{
 const h=fixture(t);let complete,voiceSignal;
 h.transport.transcribeAudio=async(_path,_model,_language,signal)=>{voiceSignal=signal;return new Promise(resolve=>complete=resolve);};
 h.session.receive(dm(1,undefined,{voice:{file_id:"voice"}}));await until(()=>complete);
 h.session.receive(dm(2,"later"));h.session.receive(dm(3,"/stop"));
 await until(()=>h.commands.length);assert.equal(h.prompts.length,0);assert.deepEqual(h.commands[0],["abort"]);assert.equal(voiceSignal.aborted,true);
 complete("voice words");await tick();assert.equal(h.prompts.length,0);
 h.session.receive(dm(4,"fresh"));await until(()=>h.prompts.length===1);
 assert.equal(h.prompts[0].content[0].text,"[telegram] fresh");assert.equal(h.errors.length,0);
});
test("albums reserve first arrival position and combine captions without embedding base64",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});const h=fixture(t);
 h.session.receive(dm(1,"first caption",{media_group_id:"a",photo:[{file_id:"one"}]}));h.session.receive(dm(2,"later"));
 h.session.receive(dm(3,"second caption",{media_group_id:"a",photo:[{file_id:"two"}]}));await tick();assert.equal(h.prompts.length,0);
 t.mock.timers.tick(1200);await tick();await tick();
 assert.equal(h.prompts.length,2);assert.match(h.prompts[0].content[0].text,/first caption\n\nsecond caption/);assert.equal(h.prompts[0].content.filter(c=>c.type==="image-file").length,2);
 assert.equal(h.prompts[1].content[0].text,"[telegram] later");
});
test("voice transcription inherits daemon defaults and carries cancellation signals",async t=>{
 const h=fixture(t);h.session.receive(dm(1,undefined,{voice:{file_id:"voice",mime_type:"audio/ogg"}}));await until(()=>h.prompts.length===1);
 const call=h.calls.find(c=>c.method==="transcribe");assert.equal(call.model,undefined);assert.equal(call.language,undefined);assert.ok(call.signal instanceof AbortSignal);
 assert.match(h.prompts[0].content[0].text,/Local transcript of voice-1.ogg/);await h.session.close();assert.equal(call.signal.aborted,true);
});
test("streaming, typing, final errors and attribution live in Telegram frontend",async t=>{
 const h=fixture(t);h.session.receive(dm(1,"request"));await until(()=>h.prompts.length===1);const id=h.prompts[0].id;
 h.session.output({type:"text-start"});h.session.output({type:"text-end",text:"terminal-only"});await tick();assert.equal(h.calls.length,0);
 h.session.output({type:"turn-start",turnId:id});h.session.output({type:"text-start"});h.session.output({type:"text-end",text:"answer",error:"agent failed"});h.session.output({type:"settled"});
 await until(()=>h.calls.some(c=>c.body?.text==="agent failed"));assert.ok(h.calls.some(c=>c.method==="sendChatAction"));assert.ok(h.calls.some(c=>c.body?.text==="answer"));
 assert.deepEqual(h.calls.find(c=>c.body?.text==="agent failed").body.reply_parameters,{message_id:1,allow_sending_without_reply:false});
});
test("all retained bot controls use agent capabilities rather than Pi SDK",async t=>{
 const h=fixture(t);for(const [i,command] of ["/help","/start","/status","/compact","/new","/model","/thinking"].entries())h.session.receive(dm(i+1,command));
 await until(()=>h.commands.length===2 && h.calls.some(c=>c.body?.reply_markup));
 assert.deepEqual(h.commands,[ ["compact"],["new"] ]);assert.ok(h.calls.some(c=>c.body?.text==="Model: p/m"));assert.equal(h.prompts.length,0);
});
test("expired menus and other users cannot issue model changes",async t=>{
 const h=fixture(t);h.session.receive({update_id:1,callback_query:{id:"old",from:{id:7,is_bot:false},message:{message_id:1,chat:{id:7,type:"private"}},data:"bridge:1"}});
 h.session.receive({...dm(2,"/new"),message:{...dm(2,"/new").message,from:{id:8}}});await tick();
 assert.equal(h.commands.length,0);assert.match(h.calls[0].body.text,/expired/);
});
test("model/thinking menus, provider pagination and selection are daemon-owned",async t=>{
 const h=fixture(t);h.session.receive(dm(1,"/model"));await until(()=>h.calls.length===1);
 const menu=h.calls[0];const callback=data=>({update_id:2,callback_query:{id:`cb-${h.calls.length}`,from:{id:7,is_bot:false},message:{message_id:50,chat:{id:7,type:"private"}},data}});
 h.session.receive(callback(menu.body.reply_markup.inline_keyboard[0][0].callback_data));await until(()=>h.calls.some(c=>c.method==="editMessageText"));
 const page=h.calls.find(c=>c.method==="editMessageText");h.session.receive(callback(page.body.reply_markup.inline_keyboard[0][0].callback_data));await until(()=>h.commands.length===1);
 assert.deepEqual(h.commands[0],["model",{provider:"p",id:"m",name:"M"}]);
});
test("detach prevents prepared prompts and in-flight model completions from leaking",async t=>{
 const h=fixture(t);let complete;h.transport.transcribeAudio=async()=>new Promise(resolve=>complete=resolve);
 h.session.receive(dm(1,undefined,{voice:{file_id:"v"}}));await until(()=>complete);h.detach();complete("late voice");await tick();assert.equal(h.prompts.length,0);
 h.session.output({type:"text-end",text:"late"});assert.equal(h.calls.filter(c=>c.body?.text==="late").length,0);
});
