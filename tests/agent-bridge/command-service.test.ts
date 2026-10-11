import { afterEach, expect, test } from "bun:test";
import * as v from "valibot";
import { IncomingMessageSchema, ProjectSchema, type Task } from "../../src/agent-bridge/domain.ts";
import type { SessionBackend, SessionTarget } from "../../src/agent-bridge/frontend.ts";
import type { AgentSnapshot, PreparedPrompt } from "../../src/agent-bridge/protocol.ts";
import type { BridgeServer } from "../../src/agent-bridge/server.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { BotCommandService, executeSessionControl } from "../../src/bot/command-service.ts";
import { BotRuntime, type ThreadSession } from "../../src/bot/runtime.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i=0;i<100;i++) { if (check()) return; await Bun.sleep(1); }
  throw new Error("Timed out waiting for a shared control");
}
class FakeSession implements ThreadSession {
  isLive = true;
  isRunning = false;
  received: PreparedPrompt["content"][] = [];
  receivePrepared(content: PreparedPrompt["content"]): void { this.received.push(content); }
  output(): void {}
  async sendAttachment(): Promise<void> {}
  async close(): Promise<void> { this.isLive = false; }
}
const snapshot: AgentSnapshot = {
  idle:true, models:[{provider:"fake",id:"model",name:"Model"}],
  thinking:"off",supportedThinking:["off","high"],status:"saved writer status",
};
function setup(options: { savedOwner?: string; live?: boolean; backend?: SessionBackend } = {}) {
  const store = new Store(":memory:");
  const project = v.parse(ProjectSchema,{id:"project_controls",name:"Controls",directory:"/tmp"});
  const container = {platform:"telegram" as const,spaceId:"-100",channelId:"42"};
  store.saveProject(project);store.bind({container,projectId:project.id});
  const primary = new FakeSession();
  const releases: (() => void)[] = [];
  const runtime = new BotRuntime({
    store, ownerIds:["2","1"],identity:{id:"test",label:"Test"},platform:"telegram",
    backend: options.backend ?? { async open() { throw new Error("Unexpected backend startup"); }, async closeRoute() {}, async close() {} },
    transport:{async publishAnchor(){return "100";},async reply(){return []; }},
    session:(value): value is FakeSession => value instanceof FakeSession,
  });
  const commands = new BotCommandService(runtime);
  let id=0;
  const message = (authorId: string, text = "request", parentId?: string) => v.parse(IncomingMessageSchema,{
    id:String(++id),container,authorId,text,route:parentId ? {kind:"reply",parentId} : {kind:"default"},
  });
  const initial = commands.dispatch(message("1"),null);
  if(initial.result?.kind!=="routed")throw new Error("Missing starter's Main thread");
  const task: Task=initial.result.task;
  if(options.savedOwner!==undefined)store.attachTask({taskId:task.id,ownerId:options.savedOwner,sessionId:"saved-session",sessionFile:"/tmp/saved-session.jsonl"});
  const peer = (frontend: FakeSession, ownerId = options.savedOwner ?? "1") => ({identity:{userId:ownerId,routeId:task.id,frontend:runtime.options.identity},frontend});
  let current = options.live === false ? undefined : peer(primary);
  const calls: {operation:string;body:unknown;peer:typeof current}[]=[];
  let inspect = async (operation:string):Promise<unknown> => operation==="snapshot" ? snapshot : operation==="setThinking" ? "high" : true;
  const server = {
    attachment: (routeId:string) => routeId===task.id ? current : undefined,
    detachRoute: (routeId:string) => { if(routeId===task.id)current=undefined; },
    inspectAgent: async (_routeId:string,operation:string,body?:unknown) => {
      calls.push({operation,body,peer:current});return inspect(operation);
    },
  };
  runtime.connect(server as unknown as BridgeServer);
  cleanup.push(async()=>{for(const release of releases)release();await runtime.close();store.close();});
  return {store,runtime,commands,task,primary,calls,message,releases,
    replace(frontend=new FakeSession()) {current=peer(frontend);return frontend;},
    inspect(handler: (operation:string)=>Promise<unknown>) {inspect=handler;},
  };
}

// Real FIFO generation checks are used below, rather than reading private queue state.
test("another configured owner cannot fence pending live input; the saved owner can stop and accept fresh input", async () => {
  const h=setup({savedOwner:"1"});const delivered:string[]=[];
  const held=deferred<ThreadSession>();h.releases.push(()=>held.resolve(h.primary));
  let entered=0;h.runtime.ensureSession=async()=>{entered++;return held.promise;};
  const first=h.runtime.enqueueInput(h.task,()=>delivered.push("first"));
  const second=h.runtime.enqueueInput(h.task,()=>delivered.push("second"));
  await until(()=>entered===1);
  const rejected=h.commands.dispatch(h.message("2","/stop",h.task.rootId),{name:"stop",argument:""});
  expect(rejected.reply).toContain("saved session owner");
  expect(h.runtime.hasPendingInputs(h.task.id)).toBe(true);
  expect(h.runtime.ownerForTask(h.task)).toBe("1");
  held.resolve(h.primary);await Promise.all([first,second]);
  expect(delivered).toEqual(["first","second"]); // Unauthorized stop did not change their generation.

  const next=deferred<ThreadSession>();h.releases.push(()=>next.resolve(h.primary));
  entered=0;h.runtime.ensureSession=async()=>{entered++;return next.promise;};
  const third=h.runtime.enqueueInput(h.task,()=>delivered.push("discarded third"));void third.catch(()=>{});
  const fourth=h.runtime.enqueueInput(h.task,()=>delivered.push("discarded fourth"));void fourth.catch(()=>{});
  await until(()=>entered===1);
  const stopped=h.commands.dispatch(h.message("1","/stop",h.task.rootId),{name:"stop",argument:""});
  expect(stopped.control).toBe(true);expect(stopped.reply).toBeNull();
  expect(h.runtime.hasPendingInputs(h.task.id)).toBe(false);
  next.resolve(h.primary);
  await expect(third).rejects.toThrow("cancelled");await expect(fourth).rejects.toThrow("cancelled");
  expect(delivered).toEqual(["first","second"]);expect(h.primary.isLive).toBe(true);
  await h.runtime.enqueueInput(h.task,()=>delivered.push("fresh"));
  expect(delivered).toEqual(["first","second","fresh"]);
  expect(h.store.taskAttachment(h.task.id)?.ownerId).toBe("1");
});

test("the original configured starter owns pending startup before a saved association exists", async () => {
  const opening=deferred<{sessionId:string;sessionFile:string}>();
  const targets:SessionTarget[]=[];const closed:string[]=[];
  const h=setup({live:false,backend:{
    open(target){targets.push(target);return opening.promise;},
    async closeRoute(id){closed.push(id);opening.resolve({sessionId:"cancelled",sessionFile:"/tmp/cancelled.jsonl"});},
    async close(){},
  }});
  h.releases.push(()=>opening.resolve({sessionId:"cancelled",sessionFile:"/tmp/cancelled.jsonl"}));
  const delivered:string[]=[];
  const first=h.runtime.enqueueInput(h.task,()=>delivered.push("first"));void first.catch(()=>{});
  const second=h.runtime.enqueueInput(h.task,()=>delivered.push("second"));void second.catch(()=>{});
  await until(()=>targets.length===1);
  expect(h.store.taskAttachment(h.task.id)).toBeNull();
  expect(targets[0].ownerId).toBe("1"); // Owner 2 is first in config, but did not start this thread.
  const start=h.runtime.starts.get(h.task.id);
  const rejected=h.commands.dispatch(h.message("2","/stop",h.task.rootId),{name:"stop",argument:""});
  expect(rejected.reply).toContain("saved session owner");
  expect(h.runtime.starts.get(h.task.id)).toBe(start);expect(start?.cancelled).toBe(false);
  expect(h.runtime.hasPendingInputs(h.task.id)).toBe(true);expect(closed).toEqual([]);
  const stopped=h.commands.dispatch(h.message("1","/stop",h.task.rootId),{name:"stop",argument:""});
  expect(stopped.reply).toBe("Aborted current turn.");
  await expect(first).rejects.toThrow("cancelled");await expect(second).rejects.toThrow("cancelled");
  expect(closed).toEqual([h.task.id]);expect(delivered).toEqual([]);
  expect(h.store.taskAttachment(h.task.id)).toBeNull();expect(h.runtime.starts.has(h.task.id)).toBe(false);
});

test("ownerForTask honors the persisted owner rather than the original starter or configured-owner order", async () => {
  const h=setup({savedOwner:"2"});const saved=h.store.taskAttachment(h.task.id);
  expect(String(h.store.taskAuthor(h.task.id))).toBe("1");expect(h.runtime.ownerForTask(h.task)).toBe("2");
  expect(h.commands.dispatch(h.message("1","/stop"),{name:"stop",argument:""}).reply).toContain("saved session owner");
  expect(await executeSessionControl(h.runtime,h.task,"status","","1")).toContain("configured owner");
  expect(h.calls).toEqual([]);
  expect(await executeSessionControl(h.runtime,h.task,"status","","2")).toBe(snapshot.status);
  expect(h.calls.map(call=>call.operation)).toEqual(["snapshot"]);expect(h.store.taskAttachment(h.task.id)).toEqual(saved);
});

test("a delayed model snapshot cannot change the replacement writer, even for the same saved session", async () => {
  const h=setup({savedOwner:"1"});const gate=deferred<AgentSnapshot>();h.releases.push(()=>gate.resolve(snapshot));
  h.inspect(async operation=>operation==="snapshot" ? gate.promise : true);
  const pending=executeSessionControl(h.runtime,h.task,"model","fake/model","1");void pending.catch(()=>{});
  await until(()=>h.calls.length===1);
  const saved=h.store.taskAttachment(h.task.id);const replacement=h.replace();
  gate.resolve(snapshot);await expect(pending).rejects.toThrow("writer changed");
  expect(h.calls.map(call=>call.operation)).toEqual(["snapshot"]);
  expect(h.store.taskAttachment(h.task.id)).toEqual(saved);
  // A fresh control is permitted and mutates only the replacement captured by that control.
  h.inspect(async operation=>operation==="snapshot" ? snapshot : true);
  expect(await executeSessionControl(h.runtime,h.task,"model","fake/model","1")).toBe("Model: fake/model");
  expect(h.calls.map(call=>call.operation)).toEqual(["snapshot","snapshot","setModel"]);
  expect(h.calls[2].peer?.frontend).toBe(replacement);
});

test("a delayed model snapshot after unbind fails before model mutation", async () => {
  const h=setup({savedOwner:"1"});const gate=deferred<AgentSnapshot>();h.releases.push(()=>gate.resolve(snapshot));
  h.inspect(async operation=>operation==="snapshot" ? gate.promise : true);
  const pending=executeSessionControl(h.runtime,h.task,"model","fake/model","1");void pending.catch(()=>{});
  await until(()=>h.calls.length===1);h.store.unbind(h.task.container);gate.resolve(snapshot);
  await expect(pending).rejects.toThrow("writer changed");
  expect(h.calls.map(call=>call.operation)).toEqual(["snapshot"]);
});

test("a mutating control acknowledged after unbind cannot report stale success", async () => {
  const h=setup({savedOwner:"1"});const gate=deferred<boolean>();h.releases.push(()=>gate.resolve(true));
  h.inspect(async()=>gate.promise);
  const pending=executeSessionControl(h.runtime,h.task,"compact","","1");void pending.catch(()=>{});
  await until(()=>h.calls.length===1);expect(h.calls[0].operation).toBe("compact");
  h.store.unbind(h.task.container);gate.resolve(true);
  await expect(pending).rejects.toThrow("writer changed");
  expect(h.calls).toHaveLength(1);
});

test("writer replacement while ensureSession resolves prevents even the first inspection", async () => {
  const h=setup({savedOwner:"1"});const gate=deferred<ThreadSession>();h.releases.push(()=>gate.resolve(h.primary));
  let entered=false;h.runtime.ensureSession=async()=>{entered=true;return gate.promise;};
  const pending=executeSessionControl(h.runtime,h.task,"thinking","high","1");void pending.catch(()=>{});
  await until(()=>entered);h.replace();gate.resolve(h.primary);
  await expect(pending).rejects.toThrow("writer changed");expect(h.calls).toEqual([]);
});

test("a stop/cancel generation fences delayed controls even if the same binding and peer reappear", async () => {
  const h=setup({savedOwner:"1"});const gate=deferred<AgentSnapshot>();h.releases.push(()=>gate.resolve(snapshot));
  h.inspect(async operation=>operation==="snapshot" ? gate.promise : true);
  const pending=executeSessionControl(h.runtime,h.task,"model","fake/model","1");void pending.catch(()=>{});
  await until(()=>h.calls.length===1);
  const generation=h.runtime.threadGeneration(h.task.id);
  expect(h.commands.dispatch(h.message("1","/stop"),{name:"stop",argument:""}).reply).toBeNull();
  expect(h.runtime.threadGeneration(h.task.id)).toBe(generation+1);
  h.store.unbind(h.task.container);h.store.bind({container:h.task.container,projectId:h.task.projectId});
  gate.resolve(snapshot);await expect(pending).rejects.toThrow("writer changed");
  expect(h.calls.map(call=>call.operation)).toEqual(["snapshot"]);
});
