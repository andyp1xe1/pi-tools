import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { BridgeClient } from "../../src/agent-bridge/client.ts";
import { type AgentSnapshot, type PreparedPrompt, type ServerFrame, ServerFrameSchema } from "../../src/agent-bridge/protocol.ts";
import { BridgeServer } from "../../src/agent-bridge/server.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { TelegramFrontend } from "../../src/agent-bridge/telegram/frontend.ts";
import { TelegramHttpClient } from "../../src/agent-bridge/telegram/api.ts";
import { TelegramClient } from "../../src/agent-bridge/telegram/client.ts";
import { TelegramUpdateSchema, type TelegramUpdate } from "../../src/agent-bridge/telegram/schemas.ts";
import { MessageIdSchema } from "../../src/agent-bridge/domain.ts";
import type { SessionBackend, SessionTarget } from "../../src/agent-bridge/frontend.ts";
import * as v from "valibot";
const roots:string[]=[];const servers:BridgeServer[]=[];const stores:Store[]=[];
afterEach(async()=>{for(const server of servers.splice(0))await server.close();for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function setup(owners=["7"], backend?:SessionBackend){
 const root=mkdtempSync(join(tmpdir(),"bridge-ipc-"));roots.push(root);chmodSync(root,0o700);
 const path=join(root,"bridge.sock");const calls:{method:string;body:Record<string,unknown>}[]=[];
 const fetcher=async(url:string,init:RequestInit)=>{
  const method=url.split("/").at(-1) ?? "";
  const body=init.body instanceof FormData?{chat_id:init.body.get("chat_id"),message_thread_id:init.body.get("message_thread_id"),reply_parameters:init.body.get("reply_parameters")}: JSON.parse(String(init.body));calls.push({method,body});
  return new Response(JSON.stringify({ok:true,result:method==="sendMessage"||method==="sendDocument"||method==="sendPhoto"?{message_id:50+calls.length,chat:{id:Number(body.chat_id),type:Number(body.chat_id)<0?"supergroup":"private"},message_thread_id:Number(body.message_thread_id)||undefined,is_topic_message:!!body.message_thread_id}:true}));
 };
 const api=new TelegramClient(()=>({botToken:"99:fake"}),fetcher);
 const store=new Store(":memory:");stores.push(store);
 const adapter=new TelegramFrontend({database:":memory:",ownerTelegramUserIds:owners},store,new TelegramHttpClient("99:fake",fetcher),{id:99,username:"existing_bot"},api,backend);
 const server=new BridgeServer(adapter,()=>{});adapter.connect(server);servers.push(server);await server.listen(path);
 return{root,path,calls,server,adapter,store,api};
}
const snapshot:AgentSnapshot={idle:true,models:[{provider:"fake",id:"model",name:"Model"}],thinking:"off",supportedThinking:["off","high"],status:"Model: fake/model"};
async function connect(path:string,sessionId="session",userId?:string,routeId?:string,cwd?:string,attachmentToken?:string){
 const prompts:PreparedPrompt[]=[];const commands:unknown[]=[];const errors:Error[]=[];
 const client=new BridgeClient({socketPath:path,onAttached:()=>{},onPrompt:prompt=>prompts.push(prompt),onAgentRequest:async request=>{commands.push(request);return request.operation==="snapshot"?snapshot:request.operation==="setThinking"?"high":true;},onDisconnect:error=>errors.push(error)});
 await client.attach(sessionId,userId,routeId,cwd,attachmentToken);return{client,prompts,commands,errors};
}
function dm(text="hello",id=1,user=7):TelegramUpdate{return{update_id:id,message:{message_id:id,chat:{id:user,type:"private"},from:{id:user,is_bot:false,first_name:"Owner"},text}};}
async function until(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await Bun.sleep(5);}throw new Error("Timed out waiting for IPC");}
async function raw(path:string):Promise<{socket:Socket;next():Promise<ServerFrame>;send(frame:unknown):void}>{
 const socket=createConnection(path);await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
 const frames:ServerFrame[]=[];const readers:((frame:ServerFrame)=>void)[]=[];let buffer="";
 socket.on("data",chunk=>{buffer+=chunk.toString();for(;;){const i=buffer.indexOf("\n");if(i<0)break;const frame=v.parse(ServerFrameSchema,JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);const reader=readers.shift();if(reader)reader(frame);else frames.push(frame);}});
 return{socket,next:()=>frames.length?Promise.resolve(frames.shift()!):new Promise(resolve=>readers.push(resolve)),send:frame=>socket.write(`${JSON.stringify(frame)}\n`)};
}
test("daemon prepares owner-only prompts and owns Telegram rendering and scoped attachments",async()=>{
 const h=await setup();const peer=await connect(h.path);
 await h.adapter.accept(dm());await until(()=>peer.prompts.length===1);
 const prompt=v.parse(v.object({id:v.string(),content:v.array(v.object({type:v.literal("text"),text:v.string()}))}),peer.prompts[0]);
 expect(prompt.content[0]?.text).toBe("[telegram] hello");await h.adapter.accept(dm("not owner",2,8));expect(peer.prompts).toHaveLength(1);
 peer.client.output({type:"turn-start",turnId:prompt.id});peer.client.output({type:"text-start"});peer.client.output({type:"text-end",text:"reply from agent"});peer.client.output({type:"settled"});
 await until(()=>h.calls.some(call=>call.body.text==="reply from agent"));
 const file=join(h.root,"report.txt");writeFileSync(file,"report");await peer.client.sendAttachment({path:file,fileName:"report.txt"});
 expect(h.calls.find(call=>call.method==="sendDocument")?.body.chat_id).toBe("7");
 await expect(peer.client.request("sendAttachment",{path:"report.txt",fileName:"report.txt"})).rejects.toThrow("Bridge request failed");
 await expect(peer.client.request("sendAttachment",{path:file,fileName:"report.txt",chatId:8})).rejects.toThrow("Bridge request failed");await peer.client.disconnect();
});
test("one attachment per owner; acknowledged detach releases ownership without stopping daemon",async()=>{
 const h=await setup();const first=await connect(h.path);await expect(connect(h.path,"second")).rejects.toThrow("already has an attached");
 await first.client.disconnect();const second=await connect(h.path,"second");await second.client.disconnect();
 const inspect=await raw(h.path);inspect.send({type:"status"});expect((await inspect.next()).type).toBe("status");inspect.socket.destroy();
});
test("owner selection and protocol prohibit exposing raw Telegram RPCs",async()=>{
 const h=await setup(["7","8"]);await expect(connect(h.path)).rejects.toThrow("Choose a configured owner");const peer=await connect(h.path,"session","7");
 const untrusted=await raw(h.path);untrusted.send({type:"request",id:"bad",operation:"sendMessage",body:{chat_id:8,text:"escape"}});
 expect(await untrusted.next()).toEqual({type:"error",message:"Invalid bridge request."});untrusted.socket.destroy();
 await h.adapter.accept(dm("/status"));await until(()=>h.calls.some(call=>call.body.text==="Model: fake/model"));expect(peer.commands).toHaveLength(1);
 await peer.client.disconnect();
});
test("Node portable client attaches to Bun server and reattaches across acknowledged handoff",async()=>{
 const h=await setup();const cwd=fileURLToPath(new URL("../../",import.meta.url));
 const source=`import {BridgeClient} from './src/agent-bridge/client.ts';
 const make=()=>new BridgeClient({socketPath:process.env.TEST_BRIDGE_SOCKET,onAttached:()=>{},onPrompt:()=>{},onAgentRequest:async()=>true,onDisconnect:()=>{}});
 const a=make();await a.attach('node-original');await a.disconnect();const b=make();await b.attach('node-next');await b.disconnect();console.log('node-handoff-ok');`;
 const child=spawn("node",["--experimental-transform-types","--input-type=module","-e",source],{cwd,env:{...process.env,TEST_BRIDGE_SOCKET:h.path},stdio:["ignore","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
 const code=await new Promise<number|null>(resolve=>child.once("exit",resolve));expect(code,stderr).toBe(0);expect(stdout).toContain("node-handoff-ok");
});
test("transcription is daemon-owned; controls and cancellation are independent of slow work",async()=>{
 const h=await setup();const whisper=join(h.root,"whisper");
 writeFileSync(whisper,`#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output_dir" ]; then shift;out="$1";fi;shift;done\nsleep 0.15\nprintf 'daemon transcript' > "$out/voice.txt"\n`,{mode:0o700});
 const old=process.env.PATH;process.env.PATH=`${h.root}:${old}`;
 const peer=await connect(h.path);
 try{const audio=join(h.root,"voice.wav");writeFileSync(audio,"fake audio");const result=peer.client.transcribeAudio(audio);await h.adapter.accept(dm("/stop"));await until(()=>h.calls.some(call=>call.body.text==="Aborted current turn."));expect(await result).toBe("daemon transcript");
 const controller=new AbortController();const cancelled=peer.client.transcribeAudio(audio,undefined,undefined,controller.signal);await Bun.sleep(10);controller.abort();await expect(cancelled).rejects.toThrow("Aborted");await Bun.sleep(20);expect(peer.client.isAttached).toBe(true);
 }finally{process.env.PATH=old;await peer.client.disconnect();}
});
test("live socket is not replaced and detached DMs do not become execution queues",async()=>{
 const h=await setup();await expect(h.server.listen(h.path)).rejects.toThrow("already owns");await h.adapter.accept(dm("/status"));expect(h.calls[0]?.body.text).toContain("No agent session attached");
 const peer=await connect(h.path);expect(peer.prompts).toHaveLength(0);await peer.client.disconnect();
});

function group(id:number, text:string|undefined, parent?:number, author=7, topic=42, extra:Record<string,unknown>={}):TelegramUpdate {
 return v.parse(TelegramUpdateSchema,{update_id:id,message:{message_id:id,chat:{id:-1001,type:"supergroup",is_forum:true},from:{id:author,is_bot:false},is_topic_message:true,message_thread_id:topic,text,...(text?.startsWith("/")?{entities:[{type:"bot_command",offset:0,length:text.split(/\s+/)[0]!.length}]}:{}),...(parent?{reply_to_message:{message_id:parent,chat:{id:-1001,type:"supergroup",is_forum:true},is_topic_message:true,message_thread_id:topic}}:{}),...extra}});
}
async function groupSetup(owners=["7"]){
 const h=await setup(owners);const project=h.store.registerProject(h.root);
 h.store.bind({container:{platform:"telegram",spaceId:"-1001",channelId:"42"},projectId:project.id});
 h.store.bind({container:{platform:"telegram",spaceId:"-1001",channelId:"43"},projectId:project.id});
 const a=await h.adapter.accept(group(10,"@existing_bot A",undefined,7,42,{entities:[{type:"mention",offset:0,length:13}]}));
 const b=await h.adapter.accept(group(11,"@existing_bot B",undefined,7,42,{entities:[{type:"mention",offset:0,length:13}]}));
 if(a?.kind!=="routed"||b?.kind!=="routed")throw new Error("Missing group threads");
 return{...h,a:a.task,b:b.task};
}
function answer(client:BridgeClient,prompt:PreparedPrompt,text:string){
 client.output({type:"turn-start",turnId:prompt.id});client.output({type:"text-start"});client.output({type:"text-end",text});client.output({type:"settled"});
}
test("two threads under one owner attach separate sessions; bubbles, menus and uploads map back to their own thread",async()=>{
 const h=await groupSetup();
 const a=await connect(h.path,"pi-A","7",h.a.id,h.root),b=await connect(h.path,"pi-B","7",h.b.id,h.root);
 expect(a.prompts).toHaveLength(0);expect(b.prompts).toHaveLength(0);
 await h.adapter.accept(group(12,"A input",10));await h.adapter.accept(group(13,"B input",11));
 await until(()=>a.prompts.length===1&&b.prompts.length===1);
 answer(a.client,a.prompts[0]!,"A answer");answer(b.client,b.prompts[0]!,"B answer");
 await until(()=>h.calls.some(c=>c.body.text==="A answer")&&h.calls.some(c=>c.body.text==="B answer"));
 for(const [text,task,requestId] of [["A answer",h.a,12],["B answer",h.b,13]] as const){
  const call=h.calls.find(c=>c.body.text===text)!;expect(call.body).toMatchObject({chat_id:-1001,message_thread_id:42,reply_parameters:{message_id:requestId,allow_sending_without_reply:false}});
  const id=51+h.calls.indexOf(call);expect(h.store.taskForMessage({container:task.container,messageId:v.parse(MessageIdSchema,String(id))})?.id).toBe(task.id);
 }
 const bubble=h.calls.find(c=>c.body.text==="A answer")!;await h.adapter.accept(group(14,"@existing_bot continue",51+h.calls.indexOf(bubble),8,42,{entities:[{type:"mention",offset:0,length:13}]}));
 await until(()=>a.prompts.length===2);expect(b.prompts).toHaveLength(1);expect(h.store.snapshot().tasks).toHaveLength(2);
 await h.adapter.accept(group(15,"/model",11));await until(()=>h.calls.some(c=>c.body.reply_markup));
 const menu=h.calls.find(c=>c.body.reply_markup)!;expect(menu.body.reply_parameters).toEqual({message_id:15,allow_sending_without_reply:false});
 expect(h.store.taskForMessage({container:h.b.container,messageId:v.parse(MessageIdSchema,String(51+h.calls.indexOf(menu)))})?.id).toBe(h.b.id);
 a.client.output({type:"turn-start",turnId:a.prompts[1]!.id});
 const file=join(h.root,"group-report.txt");writeFileSync(file,"group report");await a.client.sendAttachment({path:file,fileName:"group-report.txt"});
 const upload=h.calls.find(c=>c.method==="sendDocument")!;expect(upload.body).toMatchObject({chat_id:"-1001",message_thread_id:"42"});
 expect(JSON.parse(String(upload.body.reply_parameters))).toEqual({message_id:14,allow_sending_without_reply:false});
 expect(h.store.taskForMessage({container:h.a.container,messageId:v.parse(MessageIdSchema,String(51+h.calls.indexOf(upload)))})?.id).toBe(h.a.id);
 await a.client.disconnect();await b.client.disconnect();
});
test("attachment cwd, durable session identity, selected owner and cross-route conflicts fail closed",async()=>{
 const h=await groupSetup(["7","8"]);
 await expect(connect(h.path,"pi-A",undefined,h.a.id,h.root)).rejects.toThrow("Choose a configured owner");
 await expect(connect(h.path,"pi-A","7",h.a.id,tmpdir())).rejects.toThrow("cwd");
 const a=await connect(h.path,"pi-A","7",h.a.id,h.root);
 await expect(connect(h.path,"pi-A","7",h.b.id,h.root)).rejects.toThrow("already has an attached route");
 expect(h.store.taskAttachment(h.b.id)).toBeNull();await a.client.disconnect();
 await expect(connect(h.path,"pi-other","7",h.a.id,h.root)).rejects.toThrow("/release");
 await expect(connect(h.path,"pi-A","8",h.a.id,h.root)).rejects.toThrow("/release");
 await expect(connect(h.path,"pi-A","8")).rejects.toThrow("assigned to a group thread");
 await expect(connect(h.path,"pi-A","7",h.b.id,h.root)).rejects.toThrow();
 const restored=await connect(h.path,"pi-A","7",h.a.id,h.root);expect(restored.prompts).toHaveLength(0);await restored.client.disconnect();
});
test("group members can submit but controls and callbacks are attachment-owner-only; foreign bot commands are ignored",async()=>{
 const h=await groupSetup(["7","8"]);const a=await connect(h.path,"pi-A","7",h.a.id,h.root);
 await h.adapter.accept(group(12,"member input",10,8));await until(()=>a.prompts.length===1);
 for(const [i,text] of ["/stop","/status","/model","/thinking","/compact","/new"].entries()) await h.adapter.accept(group(13+i,text,10,8));
 await until(()=>h.calls.filter(c=>String(c.body.text).includes("Only the attachment owner")).length===6);expect(a.commands).toHaveLength(0);
 await h.adapter.accept(group(20,"/stop@other_bot",10));expect(a.commands).toHaveLength(0);
 await h.adapter.accept(group(21,"/model@existing_bot",10));await until(()=>h.calls.some(c=>c.body.reply_markup));
 const menu=h.calls.find(c=>c.body.reply_markup)!;const menuId=51+h.calls.indexOf(menu);const markup=menu.body.reply_markup as {inline_keyboard:{callback_data:string}[][]};
 const callback=(id:number,author:number,topic=42)=>v.parse(TelegramUpdateSchema,{update_id:id,callback_query:{id:`callback-${id}`,from:{id:author},message:{message_id:menuId,chat:{id:-1001,type:"supergroup",is_forum:true},message_thread_id:topic,is_topic_message:true},data:markup.inline_keyboard[0]![0]!.callback_data}});
 await h.adapter.accept(callback(22,8));await h.adapter.accept(callback(23,7,43));expect(a.commands).toHaveLength(1);
 await h.adapter.accept(callback(24,7));await until(()=>h.calls.some(c=>c.method==="editMessageText"));
 await h.adapter.accept(group(25,"/release",10,8));expect(h.store.taskAttachment(h.a.id)?.ownerId).toBe("7");expect(a.client.isAttached).toBe(true);
 for (const [index,text] of ["/new", "/NEW@EXISTING_BOT", "/new ignored-argument"].entries()) await h.adapter.accept(group(26+index,text,10));
 await until(()=>h.calls.filter(c=>String(c.body.text).includes("bound to its existing")).length===3);expect(a.commands).toHaveLength(2);
 await h.adapter.accept(group(29,"/release",10));await until(()=>!a.client.isAttached);expect(h.store.taskAttachment(h.a.id)).toBeNull();
 const replacement=await connect(h.path,"pi-new","8",h.a.id,h.root);expect(replacement.prompts).toHaveLength(0);await replacement.client.disconnect();
});
test("group media albums retain uncaptioned pieces and FIFO without crossing author, topic or thread",async()=>{
 const h=await groupSetup();const a=await connect(h.path,"pi-A","7",h.a.id,h.root),b=await connect(h.path,"pi-B","7",h.b.id,h.root);
 const downloads:string[]=[];h.api.downloadFile=async(id,name)=>{downloads.push(id);return join(h.root,name);};
 const photo=(file:string)=>({photo:[{file_id:file}]});
 await h.adapter.accept(group(12,"album caption",10,8,42,{media_group_id:"album",...photo("one")}));
 await h.adapter.accept(group(13,"later A",10));await h.adapter.accept(group(14,undefined,undefined,8,42,{media_group_id:"album",...photo("two")}));
 await h.adapter.accept(group(15,undefined,undefined,7,42,{media_group_id:"album",...photo("wrong-author")}));
 await h.adapter.accept(group(16,undefined,undefined,8,43,{media_group_id:"album",...photo("wrong-topic")}));
 await h.adapter.accept(group(17,undefined,11,8,42,{media_group_id:"album",...photo("wrong-thread")}));
 await h.adapter.accept(group(18,"B photo",11,8,42,{...photo("B")}));
 await until(()=>b.prompts.length===1);expect(a.prompts).toHaveLength(0);
 await Bun.sleep(1300);await until(()=>a.prompts.length===2);
 expect(downloads.sort()).toEqual(["B","one","two"]);expect(a.prompts[0]?.content.filter(c=>c.type==="image-file")).toHaveLength(2);expect(a.prompts[1]?.content[0]).toMatchObject({text:"[telegram] later A"});
 expect(b.prompts[0]?.content.filter(c=>c.type==="image-file")).toHaveLength(1);
 await a.client.disconnect();await h.adapter.accept(group(19,undefined,10,8,42,photo("detached")));await Bun.sleep(30);expect(downloads).not.toContain("detached");
 const restored=await connect(h.path,"pi-A","7",h.a.id,h.root);expect(restored.prompts).toHaveLength(0);await restored.client.disconnect();await b.client.disconnect();
});
test("late accepted output cannot map into a released or replacement attachment",async()=>{
 const h=await groupSetup();const a=await connect(h.path,"pi-A","7",h.a.id,h.root);
 await h.adapter.accept(group(12,"request",10));await until(()=>a.prompts.length===1);
 const call=h.api.call.bind(h.api);let complete:(()=>void)|undefined;
 h.api.call=async(method,body,options)=>{const result=await call(method,body,options);if(method==="sendMessage"&&body.text==="late accepted bubble")await new Promise<void>(resolve=>complete=resolve);return result;};
 answer(a.client,a.prompts[0]!,"late accepted bubble");await until(()=>!!complete);
 const bubble=h.calls.find(c=>c.body.text==="late accepted bubble")!;const bubbleId=51+h.calls.indexOf(bubble);
 await h.adapter.accept(group(13,"/release",10));await until(()=>!a.client.isAttached);
 const replacement=await connect(h.path,"pi-new","7",h.a.id,h.root);complete!();await Bun.sleep(30);
 expect(h.store.taskForMessage({container:h.a.container,messageId:v.parse(MessageIdSchema,String(bubbleId))})).toBeNull();
 await h.adapter.accept(group(14,"unmapped reply",bubbleId));expect(replacement.prompts).toHaveLength(0);await replacement.client.disconnect();
});
test("owner unbind detaches every live conversation in that topic but retains saved associations",async()=>{
 const h=await groupSetup(["7","8"]);
 const a=await connect(h.path,"pi-A","7",h.a.id,h.root),b=await connect(h.path,"pi-B","8",h.b.id,h.root),dmPeer=await connect(h.path,"pi-DM","7");
 const otherResult=await h.adapter.accept(group(12,"@existing_bot other",undefined,7,43,{entities:[{type:"mention",offset:0,length:13}]}));
 if(otherResult?.kind!=="routed")throw new Error("Missing other topic conversation");
 const other=await connect(h.path,"pi-other","7",otherResult.task.id,h.root);
 await h.adapter.accept(group(13,"/unbind",undefined,9));expect(h.store.binding(h.a.container)).not.toBeNull();expect(a.client.isAttached).toBe(true);
 h.api.downloadFile=async()=>join(h.root,"image.jpg");
 await h.adapter.accept(group(14,"image emitted to Pi",10,7,42,{photo:[{file_id:"image"}]}));
 // IPC must close even when Pi has not yet acknowledged the prepared image.
 await until(()=>a.prompts.length===1);
 await h.adapter.accept(group(15,"/unbind"));await until(()=>!a.client.isAttached&&!b.client.isAttached);
 expect(h.store.binding(h.a.container)).toBeNull();expect(h.store.taskAttachment(h.a.id)?.sessionId).toBe("pi-A");expect(h.store.taskAttachment(h.b.id)?.sessionId).toBe("pi-B");
 expect(other.client.isAttached).toBe(true);expect(dmPeer.client.isAttached).toBe(true);
 await other.client.disconnect();await dmPeer.client.disconnect();
});
test("binding changes fence prepared media, output and uploads",async()=>{
 const h=await groupSetup();const a=await connect(h.path,"pi-A","7",h.a.id,h.root);
 let finish:((value:string)=>void)|undefined;h.api.downloadFile=async()=>new Promise(resolve=>finish=resolve);
 await h.adapter.accept(group(12,"slow image",10,7,42,{photo:[{file_id:"slow"}]}));await until(()=>!!finish);
 h.store.unbind(h.a.container);finish!(join(h.root,"slow.jpg"));await Bun.sleep(30);expect(a.prompts).toHaveLength(0);
 await expect(a.client.sendAttachment({path:join(h.root,"none"),fileName:"none"})).rejects.toThrow();
 a.client.output({type:"text-end",text:"must remain local"});await Bun.sleep(30);expect(h.calls.some(c=>c.body.text==="must remain local")).toBe(false);await a.client.disconnect();
});

async function managedSetup(heldNames:string[]=[], owners=["7"]){
 let h:Awaited<ReturnType<typeof setup>>;
 let closed=false;
 const targets:SessionTarget[]=[];
 const gates=new Map<string,()=>void>();
 const peers=new Map<string,Awaited<ReturnType<typeof connect>>>();
 const pending=new Map<string,Promise<{sessionId:string;sessionFile:string}>>();
 const cancel=new Map<string,()=>void>();
 const backend:SessionBackend={
  open(target){
   const existing=pending.get(target.routeId);
   if(existing&&(!peers.has(target.routeId)||peers.get(target.routeId)!.client.isAttached))return existing;
   targets.push({...target});
   let cancelled=false;cancel.set(target.routeId,()=>{cancelled=true;gates.get(target.name)?.();});
   const job=(async()=>{
    if(heldNames.includes(target.name))await new Promise<void>(resolve=>gates.set(target.name,resolve));
    if(closed||cancelled)throw new Error("Backend closed");
    const sessionId=target.sessionId??`native-${target.routeId}`;
    const peer=await connect(h.path,sessionId,target.ownerId,target.routeId,target.cwd,target.attachmentToken);peers.set(target.routeId,peer);
    return{sessionId,sessionFile:target.sessionFile??join(h.root,`${sessionId}.jsonl`)};
   })();
   pending.set(target.routeId,job);void job.catch(()=>pending.delete(target.routeId));return job;
  },
  async closeRoute(routeId){cancel.get(routeId)?.();await pending.get(routeId)?.catch(()=>{});await peers.get(routeId)?.client.disconnect();},
  async close(){closed=true;for(const release of gates.values())release();await Promise.allSettled([...pending.values()]);await Promise.all([...peers.values()].map(peer=>peer.client.disconnect()));},
 };
 h=await setup(owners,backend);
 const bind=()=>{const project=h.store.registerProject(h.root);h.store.bind({container:{platform:"telegram",spaceId:"-1001",channelId:"42"},projectId:project.id});};
 return{...h,targets,peers,bind,release:(name:string)=>gates.get(name)?.(),stop:()=>Promise.all([h.adapter.close(),backend.close()])};
}
const replyTexts=(h:{store:Store})=>v.parse(v.array(v.object({text:v.string()})),h.store.db.query("SELECT text FROM outbox ORDER BY id").all()).map(row=>row.text);
const mention=(id:number,text:string,parent?:number)=>group(id,`@existing_bot ${text}`,parent,7,42,{entities:[{type:"mention",offset:0,length:13}]});
test("managed bind → mention → reply delivers immediately, keeps FIFO, and does not serialize independent sessions",async()=>{
 const h=await managedSetup(["A"]);try{
  await h.adapter.accept(group(1,`/bind ${h.root}`));
  const a=await h.adapter.accept(mention(10,"A")),b=await h.adapter.accept(mention(11,"B"));
  if(a?.kind!=="routed"||b?.kind!=="routed")throw new Error("Missing managed tasks");
  await h.adapter.accept(group(12,"A follow-up",10));
  await until(()=>h.peers.get(b.task.id)?.prompts.length===1);
  expect(h.peers.has(a.task.id)).toBe(false);expect(h.targets).toHaveLength(2);
  h.release("A");await until(()=>h.peers.get(a.task.id)?.prompts.length===2);
  expect(h.peers.get(a.task.id)!.prompts.map(prompt=>prompt.content[0])).toEqual([{type:"text",text:"[telegram] A"},{type:"text",text:"[telegram] A follow-up"}]);
  expect(h.store.taskAttachment(a.task.id)?.sessionFile).toBe(join(h.root,`native-${a.task.id}.jsonl`));
  expect(replyTexts(h).every(text=>!text.includes("/bot-connect"))).toBe(true);
 }finally{await h.stop();}
});
test("managed reconnect resumes the exact persisted session identity and file, without replaying prior input",async()=>{
 const h=await managedSetup();try{
  h.bind();const a=await h.adapter.accept(mention(10,"A"));if(a?.kind!=="routed")throw new Error("Missing task");
  await until(()=>h.peers.get(a.task.id)?.prompts.length===1);
  const saved=h.store.taskAttachment(a.task.id)!;await h.peers.get(a.task.id)!.client.disconnect();
  await h.adapter.accept(group(11,"after restart",10));await until(()=>h.targets.length===2&&h.peers.get(a.task.id)?.client.isAttached===true&&h.peers.get(a.task.id)?.prompts.length===1);
  expect(h.targets[1]).toMatchObject({sessionId:saved.sessionId,sessionFile:saved.sessionFile});
  expect(h.peers.get(a.task.id)!.prompts[0]?.content[0]).toEqual({type:"text",text:"[telegram] after restart"});
  expect(h.store.taskAttachment(a.task.id)).toEqual(saved);
 }finally{await h.stop();}
});
test("managed /new creates a separate saved conversation instead of resetting an attached thread",async()=>{
 const h=await managedSetup();try{
  h.bind();const a=await h.adapter.accept(mention(10,"A"));if(a?.kind!=="routed")throw new Error("Missing task");
  await until(()=>h.peers.get(a.task.id)?.prompts.length===1);const old=h.store.taskAttachment(a.task.id)!;
  const b=await h.adapter.accept(group(11,"/NEW@EXISTING_BOT fresh request",10));if(b?.kind!=="routed")throw new Error("Missing fresh task");
  await until(()=>h.peers.get(b.task.id)?.prompts.length===1);
  expect(b.task.id).not.toBe(a.task.id);expect(h.store.taskAttachment(a.task.id)).toEqual(old);
  expect(h.peers.get(a.task.id)!.commands).toHaveLength(0);
  expect(h.peers.get(b.task.id)!.prompts[0]?.content[0]).toEqual({type:"text",text:"[telegram] fresh request"});
  const c=await h.adapter.accept(group(12,"/new"));if(c?.kind!=="routed")throw new Error("Missing empty task");
  await until(()=>!!h.store.taskAttachment(c.task.id)?.sessionFile);
  expect(h.peers.get(c.task.id)!.prompts).toHaveLength(0);
  expect(replyTexts(h).includes("New conversation ready. Reply with your request.")).toBe(true);
 }finally{await h.stop();}
});
test("managed topic commands report their scope explicitly and controls select only an unambiguous conversation",async()=>{
 const h=await managedSetup();try{
  await h.adapter.accept(group(1,"/stop"));await h.adapter.accept(group(2,"/start"));
  expect(replyTexts(h).some(text=>text.includes("Use /bind"))).toBe(true);
  expect(replyTexts(h).some(text=>text.includes("Sessions start automatically"))).toBe(true);
  h.bind();const a=await h.adapter.accept(mention(10,"A"));if(a?.kind!=="routed")throw new Error("Missing task");
  await until(()=>h.peers.get(a.task.id)?.prompts.length===1);
  await h.adapter.accept(group(11,"/model"));await until(()=>h.peers.get(a.task.id)!.commands.length===1);
  await h.adapter.accept(group(12,"/status"));
  expect(replyTexts(h).some(text=>text.includes("Backend: native Pi SDK\nActive sessions: 1"))).toBe(true);
  const b=await h.adapter.accept(mention(13,"B"));if(b?.kind!=="routed")throw new Error("Missing second task");
  await until(()=>h.peers.get(b.task.id)?.prompts.length===1);
  await h.adapter.accept(group(14,"/stop"));
  expect(replyTexts(h).some(text=>text.includes("Reply to the conversation you want to control with /stop"))).toBe(true);
  expect(h.peers.get(a.task.id)!.commands).toHaveLength(1);expect(h.peers.get(b.task.id)!.commands).toHaveLength(0);
 }finally{await h.stop();}
});
test("managed startup finishing after /unbind cannot attach or deliver stale input",async()=>{
 const h=await managedSetup(["A"]);try{
  h.bind();const a=await h.adapter.accept(mention(10,"A"));if(a?.kind!=="routed")throw new Error("Missing task");
  await h.adapter.accept(group(11,"/unbind"));h.bind();h.release("A");await until(()=>h.targets.length===1);
  await Bun.sleep(30);expect(h.server.inspect().sessions).toHaveLength(0);expect(h.peers.get(a.task.id)?.prompts.length??0).toBe(0);
  const target=h.targets[0]!;
  await expect(connect(h.path,`late-${a.task.id}`,target.ownerId,a.task.id,h.root,target.attachmentToken)).rejects.toThrow("startup was cancelled");
  expect(h.store.taskAttachment(a.task.id)).toBeNull();
 }finally{await h.stop();}
});
test("release during startup fences late managed attachment before it can recreate a saved association",async()=>{
 const h=await managedSetup(["A"]);try{
  h.bind();const a=await h.adapter.accept(mention(10,"A"));if(a?.kind!=="routed")throw new Error("Missing task");
  const target=h.targets[0]!;await h.adapter.accept(group(11,"/release",10));
  await expect(connect(h.path,`late-${a.task.id}`,target.ownerId,a.task.id,h.root,target.attachmentToken)).rejects.toThrow("startup was cancelled");
  expect(h.store.taskAttachment(a.task.id)).toBeNull();expect(h.server.inspect().sessions).toHaveLength(0);
 }finally{await h.stop();}
});
test("/stop cancels slow frontend media and album debounce without disabling future input",async()=>{
 const h=await groupSetup();const peer=await connect(h.path,"pi-A","7",h.a.id,h.root);
 let finish:((path:string)=>void)|undefined;h.api.downloadFile=async()=>new Promise(resolve=>finish=resolve);
 try{
  await h.adapter.accept(group(12,"slow media",10,7,42,{photo:[{file_id:"slow"}]}));await until(()=>!!finish);
  await h.adapter.accept(group(13,"/stop",10));await until(()=>peer.commands.length===1);
  finish!(join(h.root,"slow.jpg"));await Bun.sleep(30);expect(peer.prompts).toHaveLength(0);
  await h.adapter.accept(group(14,"album",10,7,42,{photo:[{file_id:"album"}],media_group_id:"cancelled-album"}));
  await h.adapter.accept(group(15,"/stop",10));await until(()=>peer.commands.length===2);
  await h.adapter.accept(group(16,"fresh input",10));await until(()=>peer.prompts.length===1);
  expect(peer.prompts[0]?.content[0]).toEqual({type:"text",text:"[telegram] fresh input"});
  await Bun.sleep(1300);expect(peer.prompts).toHaveLength(1);
 }finally{finish?.(join(h.root,"slow.jpg"));await peer.client.disconnect();}
});
test("managed DMs bind a project, continue by default and authorize their own owner, preserving legacy manual DMs",async()=>{
 const h=await managedSetup([],["7","8"]);try{
  await h.adapter.accept(dm(`/bind ${h.root}`,1,8));
  const a=await h.adapter.accept(dm("plain request",2,8));if(a?.kind!=="routed")throw new Error("Missing private task");
  await h.adapter.accept(dm("follow-up",3,8));await until(()=>h.peers.get(a.task.id)?.prompts.length===2);
  expect(h.targets[0]?.ownerId).toBe("8");
  await expect(connect(h.path,"intruder","7",a.task.id,h.root)).rejects.toThrow("belongs to another owner");
  await h.adapter.accept(dm("/status",4,8));await until(()=>h.peers.get(a.task.id)!.commands.length===1);
  const b=await h.adapter.accept(dm("/new fresh",5,8));if(b?.kind!=="routed")throw new Error("Missing fresh private task");
  await until(()=>h.peers.get(b.task.id)?.prompts.length===1);expect(b.task.id).not.toBe(a.task.id);
 }finally{await h.stop();}
});
