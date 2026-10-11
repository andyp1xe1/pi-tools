import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { BridgeClient } from "../../src/agent-bridge/client.ts";
import { MessageIdSchema, TaskIdSchema, TaskSchema } from "../../src/agent-bridge/domain.ts";
import type { SessionBackend, SessionTarget } from "../../src/agent-bridge/frontend.ts";
import type { PreparedPrompt } from "../../src/agent-bridge/protocol.ts";
import { BridgeServer } from "../../src/agent-bridge/server.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { TelegramHttpClient } from "../../src/agent-bridge/telegram/api.ts";
import { TelegramClient } from "../../src/agent-bridge/telegram/client.ts";
import { TelegramFrontend } from "../../src/agent-bridge/telegram/frontend.ts";
import { TelegramUpdateSchema } from "../../src/agent-bridge/telegram/schemas.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(5); }
  throw new Error("Timed out waiting for thread operation");
}
function input(id: number, text?: string, parent?: number, topic = 42, extra: Record<string, unknown> = {}) {
  return v.parse(TelegramUpdateSchema, { update_id: id, message: {
    message_id: id, chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 7, username: "moss", first_name: "Moss" }, is_topic_message: true, message_thread_id: topic,
    text, ...(parent ? { reply_to_message: { message_id: parent, chat: { id: -1001, type: "supergroup" }, message_thread_id: topic, is_topic_message: true } } : {}), ...extra,
  } });
}
async function setup(held = new Set<string>(), afterAttach = new Set<string>()) {
  const root = mkdtempSync(join(tmpdir(), "thread-tools-")); chmodSync(root, 0o700);
  const cwd = join(root, "worktree"); mkdirSync(cwd);
  const socketPath = join(root, "bridge.sock");
  const store = new Store(":memory:");
  const peers = new Map<string, { client: BridgeClient; prompts: PreparedPrompt[] }>();
  const opens: SessionTarget[] = [];
  const gates = new Map<string, () => void>();
  const closeHeld = new Set<string>();
  const closeGates = new Map<string, () => void>();
  const pending = new Map<string, Promise<{sessionId:string;sessionFile:string}>>();
  const cancellations = new Map<string, () => void>();
  const calls: {method:string;body:Record<string,unknown>;id:number}[] = [];
  let sentId = 1000;
  const fetcher = async (url: string, init: RequestInit) => {
    const method = url.split("/").at(-1)!; const body = JSON.parse(String(init.body));
    const id = ++sentId; calls.push({ method, body, id });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? {message_id:id,chat:{id:Number(body.chat_id),type:"supergroup"}} : true }));
  };
  const backend: SessionBackend = {
    open(target) {
      const old = pending.get(target.routeId);
      if (old && (!peers.has(target.routeId) || peers.get(target.routeId)!.client.isAttached)) return old;
      opens.push({...target}); let cancelled = false;
      cancellations.set(target.routeId, () => { cancelled = true; gates.get(target.routeId)?.(); });
      const opening = (async () => {
        if (held.has(target.name)) await new Promise<void>((resolve) => gates.set(target.routeId, resolve));
        if (cancelled) throw new Error("Startup cancelled");
        const prompts: PreparedPrompt[] = [];
        const client = new BridgeClient({ socketPath, onAttached() {}, onPrompt: (p) => prompts.push(p), onDisconnect() {}, onAgentRequest: async (request) => request.operation === "snapshot" ? {idle:true,models:[],thinking:"off",supportedThinking:["off"],status:"idle"} : request.operation === "peek" ? {messages:[]} : true });
        const sessionId = target.sessionId ?? `native-${target.routeId}`;
        const sessionFile = target.sessionFile ?? join(root, `${sessionId}.jsonl`);
        await client.attach(sessionId, target.ownerId, target.routeId, target.cwd, target.attachmentToken, sessionFile);
        peers.set(target.routeId, {client,prompts});
        if (afterAttach.has(target.name)) await new Promise<void>((resolve) => gates.set(target.routeId, resolve));
        return {sessionId,sessionFile};
      })();
      pending.set(target.routeId, opening); void opening.catch(() => { if (pending.get(target.routeId) === opening) pending.delete(target.routeId); });
      return opening;
    },
    async closeRoute(id) { cancellations.get(id)?.(); await pending.get(id)?.catch(() => {}); await peers.get(id)?.client.disconnect(); pending.delete(id);
      if (closeHeld.has(id)) await new Promise<void>((resolve) => closeGates.set(id, resolve));
    },
    async peek(target) { return {messages:[{id:"saved",role:"user",text:`saved history for ${target.sessionId}`} ]}; },
    async close() { for (const release of closeGates.values()) release(); for (const release of cancellations.values()) release(); await Promise.allSettled([...pending.values()]); await Promise.all([...peers.values()].map((p) => p.client.disconnect())); },
  };
  const client = new TelegramClient(() => ({botToken:"99:fake"}), fetcher);
  client.downloadFile = async (_id, name) => join(root, name);
  client.transcribeAudio = async () => "voice instructions";
  const adapter = new TelegramFrontend({database:":memory:",ownerTelegramUserIds:["7"]},store,new TelegramHttpClient("99:fake",fetcher),{id:99,username:"bot"},client,backend);
  const server = new BridgeServer(adapter, () => {}); adapter.connect(server); await server.listen(socketPath);
  const project = store.registerProject(root);
  for (const channelId of ["42","43"]) store.bind({container:{platform:"telegram",spaceId:"-1001",channelId},projectId:project.id});
  cleanup.push(async () => { await Promise.all([adapter.close(),backend.close()]); await server.close(); store.close(); rmSync(root,{recursive:true,force:true}); });
  const main = async (id=1, topic=42, extra:Record<string,unknown>={}) => {
    const routed = await adapter.accept(input(id,"hello",undefined,topic,extra));
    if (routed?.kind !== "routed") throw new Error("Missing default thread");
    await until(() => peers.get(routed.task.id)?.prompts.length === 1); return routed.task;
  };
  return {root,cwd,socketPath,store,peers,opens,gates,closeHeld,closeGates,calls,adapter,main,client};
}

test("standalone text and voice use one default per topic, with a minimal named envelope", async () => {
  const h = await setup(); const main = await h.main();
  expect(h.opens[0]).toMatchObject({explicit:true,isDefault:true,cwd:h.root});
  expect(h.peers.get(main.id)!.prompts[0].content[0]).toEqual({type:"text",text:'[telegram from="@moss" user=7 message=1]\nhello'});
  const voice = await h.adapter.accept(input(2,undefined,undefined,42,{voice:{file_id:"voice"}}));
  expect(voice?.kind === "routed" && voice.task.id).toBe(main.id);
  await until(() => h.peers.get(main.id)!.prompts.length === 2);
  expect(h.peers.get(main.id)!.prompts[1].content[0]).toMatchObject({type:"text"});
  expect((h.peers.get(main.id)!.prompts[1].content[0] as {text:string}).text).toContain('message=2]\n\nLocal transcript');
  const other = await h.main(3,43); expect(other.id).not.toBe(main.id);
  expect(h.store.threadSettings(other).isDefault).toBe(true);
  expect(h.opens).toHaveLength(2);
});

test("create returns before worker startup; mixed user and peer communication has explicit return paths", async () => {
  const h = await setup(new Set(["Worker"])); const main = await h.main(); const sender = h.peers.get(main.id)!;
  const created = await sender.client.request("createThread",{cwd:h.cwd,title:"Worker",text:"investigate"}) as {threadId:string};
  expect(h.peers.has(created.threadId)).toBe(false);
  const listing = await sender.client.request("listThreads",{}) as {id:string;status:string;cwd:string}[];
  expect(listing.find((thread) => thread.id === created.threadId)).toMatchObject({status:"starting",cwd:h.cwd});
  const root = Number(h.store.task(v.parse(TaskIdSchema,created.threadId))!.rootId);
  expect(h.calls.find((call) => call.id === root)?.body).toMatchObject({text:"Worker",message_thread_id:42});
  h.gates.get(created.threadId)!(); await until(() => h.peers.get(created.threadId)?.prompts.length === 1);
  const worker = h.peers.get(created.threadId)!;
  expect((worker.prompts[0].content[0] as {text:string}).text).toMatch(new RegExp(`^\\[thread from=${main.id}\\]`));
  expect(h.opens[1]).toMatchObject({cwd:h.cwd,parentThreadId:main.id,explicit:true,isDefault:false});
  await h.adapter.accept(input(2,"also test edge cases",root)); await until(() => worker.prompts.length === 2);
  expect(sender.prompts).toHaveLength(1);
  worker.client.output({type:"turn-start",turnId:worker.prompts[1].id});
  worker.client.output({type:"text-start"});worker.client.output({type:"text-end",text:"private generic output"});worker.client.output({type:"settled"});
  await Bun.sleep(20); expect(h.calls.some((call) => call.body.text === "private generic output")).toBe(false);
  expect(sender.prompts).toHaveLength(1);
  const reply = await worker.client.request("replyMessage",{messageId:"2",text:"confirmed",mentions:["7"]}) as {messageIds:string[]};
  expect(reply.messageIds).toHaveLength(1);
  const published = h.calls.find((call) => call.id === Number(reply.messageIds[0]))!;
  expect(published.body).toMatchObject({text:"@moss\n\nconfirmed",reply_parameters:{message_id:2,allow_sending_without_reply:false},entities:[{type:"text_mention",offset:0,length:5,user:{id:7}}]});
  await worker.client.request("messageThread",{threadId:main.id,text:"Finished; edge cases included"});
  await until(() => sender.prompts.length === 2);
  expect((sender.prompts[1].content[0] as {text:string}).text).toContain(`from=${created.threadId}`);
  expect((sender.prompts[1].content[0] as {text:string}).text).toContain("Finished; edge cases included");
});

test("stop preserves identity/history, peek does not revive, and direct replies reopen the exact custom-cwd session", async () => {
  const h = await setup(); const main = await h.main(); const sender = h.peers.get(main.id)!;
  const created = await sender.client.request("createThread",{cwd:h.cwd,title:"Worker",text:"work"}) as {threadId:string};
  const taskId = v.parse(TaskIdSchema,created.threadId); await until(() => h.peers.get(taskId)?.prompts.length === 1);
  const saved = h.store.taskAttachment(taskId)!; const root = Number(h.store.task(taskId)!.rootId);
  await sender.client.request("stopThread",{threadId:taskId}); expect(h.peers.get(taskId)!.client.isAttached).toBe(false);
  expect(h.store.taskAttachment(taskId)).toEqual(saved);
  const count = h.opens.length;
  const history = await sender.client.request("peekThread",{threadId:taskId,limit:2}) as {status:string;messages:{text:string}[]};
  expect(history.status).toBe("stopped");expect(history.messages[0].text).toContain(saved.sessionId);expect(h.opens).toHaveLength(count);
  await h.adapter.accept(input(2,"resume",root));await until(() => h.opens.length === count+1 && h.peers.get(taskId)!.client.isAttached);
  await until(() => h.peers.get(taskId)!.prompts.length === 1);
  expect(h.opens.at(-1)).toMatchObject({cwd:h.cwd,sessionId:saved.sessionId,sessionFile:saved.sessionFile});
  expect((h.peers.get(taskId)!.prompts[0].content[0] as {text:string}).text).toContain("resume");
  expect(h.store.taskAttachment(taskId)).toEqual(saved);
});

test("thread and reply tools reject other project spaces, spoofed mentions, and self-stop", async () => {
  const h = await setup();const main = await h.main();const other = await h.main(2,43);const sender=h.peers.get(main.id)!;
  await expect(sender.client.request("messageThread",{threadId:other.id,text:"escape"})).rejects.toThrow("Unknown thread");
  await expect(sender.client.request("peekThread",{threadId:other.id})).rejects.toThrow("Unknown thread");
  await expect(sender.client.request("stopThread",{threadId:other.id})).rejects.toThrow("Unknown thread");
  await expect(sender.client.request("stopThread",{threadId:main.id})).rejects.toThrow("cannot stop itself");
  await expect(sender.client.request("replyMessage",{messageId:"2",text:"escape"})).rejects.toThrow("Reply target");
  await expect(sender.client.request("replyMessage",{messageId:"1",text:"hello",mentions:["999"]})).rejects.toThrow("previously seen");
  expect(h.calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
});

test("live peek uses the attached agent and thread listing supports scoped pagination", async () => {
  const h=await setup();const main=await h.main();const sender=h.peers.get(main.id)!;
  const live=await sender.client.request("peekThread",{threadId:main.id}) as {messages:unknown[]};expect(live.messages).toEqual([]);
  for(let id=2;id<=6;id++)await h.adapter.accept(input(id,`/new task ${id}`));
  const ids:string[]=[];let before:string|undefined;
  for(;;){const page=await sender.client.request("listThreads",{limit:2,...(before?{before}:{})}) as {id:string}[];
    if(!page.length)break;ids.push(...page.map((thread)=>thread.id));before=page.at(-1)!.id;}
  expect(ids).toHaveLength(6);expect(new Set(ids).size).toBe(6);expect(ids.at(-1)).toBe(main.id);
  await expect(sender.client.request("listThreads",{before:"task_unknown"})).rejects.toThrow("cursor");
});

test("visible task stop waits for agent abort before permitting a managed writer", async () => {
  const h=await setup();const main=await h.main();const sender=h.peers.get(main.id)!;
  const task=v.parse(TaskSchema,{id:"task_visible",projectId:main.projectId,container:main.container,rootId:"99",title:"Visible",createdAt:new Date().toISOString()});
  h.store.createTask(task);h.store.configureThread(task.id,h.cwd);h.store.mapMessage({container:task.container,messageId:v.parse(MessageIdSchema,"99"),taskId:task.id});
  let finishAbort:(()=>void)|undefined;
  const visible=new BridgeClient({socketPath:h.socketPath,onAttached(){},onPrompt(){},onDisconnect(){},onAgentRequest:async(request)=>request.operation==="abort"?await new Promise<boolean>((resolve)=>finishAbort=()=>resolve(true)):true});
  try{
    await visible.attach("visible-native","7",task.id,h.cwd,undefined,join(h.root,"visible.jsonl"));
    const stopping=sender.client.request("stopThread",{threadId:task.id});await until(()=>!!finishAbort);
    await h.adapter.accept(input(2,"after shutdown",99));await Bun.sleep(20);
    expect(visible.isAttached).toBe(true);expect(h.opens).toHaveLength(1);
    finishAbort!();await stopping;await until(()=>h.opens.length===2&&h.peers.get(task.id)?.prompts.length===1);
    expect(visible.isAttached).toBe(false);expect(h.opens[1]).toMatchObject({sessionId:"visible-native",sessionFile:join(h.root,"visible.jsonl"),cwd:h.cwd});
  }finally{finishAbort?.();await visible.disconnect();}
});

test("unconfirmed visible writers are quarantined until an explicit clean handoff", async () => {
  const h=await setup();const main=await h.main();const sender=h.peers.get(main.id)!;
  const task=v.parse(TaskSchema,{id:"task_visible",projectId:main.projectId,container:main.container,rootId:"99",title:"Visible",createdAt:new Date().toISOString()});
  h.store.createTask(task);h.store.configureThread(task.id,h.cwd);h.store.mapMessage({container:task.container,messageId:v.parse(MessageIdSchema,"99"),taskId:task.id});
  const connectVisible=async()=>{
    const peer=new BridgeClient({socketPath:h.socketPath,onAttached(){},onPrompt(){},onDisconnect(){},onAgentRequest:async()=>true});
    await peer.attach("visible-native","7",task.id,h.cwd,undefined,join(h.root,"visible.jsonl"));return peer;
  };
  const visible=await connectVisible();await visible.disconnect();
  expect(h.store.visibleWriter(task.id)).toBe("visible-native");
  const listing=await sender.client.request("listThreads",{}) as {id:string;status:string}[];
  expect(listing.find((thread)=>thread.id===task.id)?.status).toBe("unconfirmed");
  await expect(sender.client.request("messageThread",{threadId:task.id,text:"unsafe reopen"})).rejects.toThrow("not confirmed");
  await expect(sender.client.request("stopThread",{threadId:task.id})).rejects.toThrow("not confirmed");
  await h.adapter.accept(input(2,"unsafe direct reopen",99));await Bun.sleep(20);expect(h.opens).toHaveLength(1);
  expect(h.store.nextReply(h.adapter.transportId)?.text).toContain("not confirmed");
  const restored=await connectVisible();await restored.disconnect({quiesced:true});
  expect(h.store.visibleWriter(task.id)).toBeUndefined();
  await sender.client.request("messageThread",{threadId:task.id,text:"safe handoff"});await until(()=>h.peers.get(task.id)?.prompts.length===1);
  expect(h.opens[1]).toMatchObject({sessionId:"visible-native",sessionFile:join(h.root,"visible.jsonl")});
  expect((h.peers.get(task.id)!.prompts[0].content[0] as {text:string}).text).toContain("safe handoff");
});

test("newly attached but still starting threads preserve user/peer receipt FIFO", async () => {
  const h=await setup(new Set(),new Set(["Worker"]));const main=await h.main();const sender=h.peers.get(main.id)!;
  const child=await sender.client.request("createThread",{cwd:h.cwd,title:"Worker",text:"first delegated input"}) as {threadId:string};
  await until(()=>h.peers.get(child.threadId)?.client.isAttached===true&&h.gates.has(child.threadId));
  const worker=h.peers.get(child.threadId)!;const root=Number(h.store.task(v.parse(TaskIdSchema,child.threadId))!.rootId);
  await h.adapter.accept(input(2,"second user input",root));
  await sender.client.request("messageThread",{threadId:child.threadId,text:"third peer input"});
  expect(worker.prompts).toHaveLength(0);
  h.gates.get(child.threadId)!();await until(()=>worker.prompts.length===3);
  expect(worker.prompts.map((p)=>(p.content[0] as {text:string}).text.split("\n").at(-1))).toEqual(["first delegated input","second user input","third peer input"]);
});

test("peer input cannot overtake earlier slow user media preparation", async () => {
  const h=await setup();const main=await h.main();const sender=h.peers.get(main.id)!;
  const child=await sender.client.request("createThread",{cwd:h.cwd,title:"Worker",text:"initial"}) as {threadId:string};
  await until(()=>h.peers.get(child.threadId)?.prompts.length===1);const worker=h.peers.get(child.threadId)!;
  const root=Number(h.store.task(v.parse(TaskIdSchema,child.threadId))!.rootId);
  let release:((path:string)=>void)|undefined;h.client.downloadFile=async()=>new Promise((resolve)=>release=resolve);
  await h.adapter.accept(input(2,"slow image",root,42,{photo:[{file_id:"slow"}]}));await until(()=>!!release);
  await sender.client.request("messageThread",{threadId:child.threadId,text:"later peer"});await Bun.sleep(20);
  expect(worker.prompts).toHaveLength(1);release!(join(h.root,"slow.jpg"));await until(()=>worker.prompts.length===3);
  expect((worker.prompts[1].content[0] as {text:string}).text).toContain("slow image");
  expect((worker.prompts[2].content[0] as {text:string}).text).toContain("later peer");
});

test("a second stop fences input already waiting for the first shutdown", async () => {
  const h=await setup();const main=await h.main();const sender=h.peers.get(main.id)!;
  const child=await sender.client.request("createThread",{cwd:h.cwd,title:"Worker",text:"initial"}) as {threadId:string};
  await until(()=>h.peers.get(child.threadId)?.prompts.length===1);const root=Number(h.store.task(v.parse(TaskIdSchema,child.threadId))!.rootId);
  h.closeHeld.add(child.threadId);const first=sender.client.request("stopThread",{threadId:child.threadId});
  await until(()=>h.closeGates.has(child.threadId));const count=h.opens.length;
  await h.adapter.accept(input(2,"must be discarded",root));await Bun.sleep(10);
  const second=sender.client.request("stopThread",{threadId:child.threadId});await Bun.sleep(20);
  h.closeHeld.delete(child.threadId);h.closeGates.get(child.threadId)!();await Promise.all([first,second]);await Bun.sleep(30);
  expect(h.opens).toHaveLength(count);expect(h.peers.get(child.threadId)!.client.isAttached).toBe(false);
  await h.adapter.accept(input(3,"fresh reply",root));await until(()=>h.opens.length===count+1&&h.peers.get(child.threadId)!.client.isAttached&&h.peers.get(child.threadId)!.prompts.length===1);
  expect((h.peers.get(child.threadId)!.prompts[0].content[0] as {text:string}).text).toContain("fresh reply");
});

test("delayed peer-delivery failures do not enter a replacement requester session", async () => {
  const h=await setup(new Set(["Held"]));const main=await h.main();const sender=h.peers.get(main.id)!;
  const child=await sender.client.request("createThread",{cwd:h.cwd,title:"Held",text:"initial"}) as {threadId:string};
  await h.adapter.accept(input(2,"/release",1));await until(()=>!sender.client.isAttached);
  const prompts:PreparedPrompt[]=[];const replacement=new BridgeClient({socketPath:h.socketPath,onAttached(){},onPrompt:(p)=>prompts.push(p),onDisconnect(){},onAgentRequest:async()=>true});
  try {
    await replacement.attach("replacement","7",main.id,h.root,undefined,join(h.root,"replacement.jsonl"));
    await replacement.request("stopThread",{threadId:child.threadId});await Bun.sleep(30);
    expect(prompts).toHaveLength(0);
  } finally {await replacement.disconnect();}
});

test("stopping pending startup discards queued peer input without resurrecting it", async () => {
  const h=await setup(new Set(["Held"]));const main=await h.main();const sender=h.peers.get(main.id)!;
  const child=await sender.client.request("createThread",{cwd:h.cwd,title:"Held",text:"first"}) as {threadId:string};
  await sender.client.request("messageThread",{threadId:child.threadId,text:"second"});
  await sender.client.request("stopThread",{threadId:child.threadId});
  await Bun.sleep(30);expect(h.peers.has(child.threadId)).toBe(false);expect(h.store.taskAttachment(v.parse(TaskIdSchema,child.threadId))).toBeNull();
  const list=await sender.client.request("listThreads",{}) as {id:string;status:string}[];
  expect(list.find((thread)=>thread.id===child.threadId)?.status).toBe("stopped");
});
