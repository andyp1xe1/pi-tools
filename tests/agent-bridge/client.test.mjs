import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_FRAME_BYTES } from "../../src/agent-bridge/protocol.ts";
import { BridgeClient, BridgeDeliveryUnknown } from "../../src/agent-bridge/client.ts";
import { loadConfig, preparePrivatePath } from "../../src/agent-bridge/config.ts";
import { BridgeServer } from "../../src/agent-bridge/server.ts";

function minimalFrontend() {
  const outputs = [], uploads = [], bindings = [], closed = [];
  const frontend = {
    identity: { id: "fake:transport", label: "Fake frontend" },
    mode: "routing",
    authorize: request => ({ userId: request.userId, routeId: request.routeId, frontend: frontend.identity }),
    bind: (request, identity) => bindings.push({ request, identity }),
    open: identity => ({
      output: event => outputs.push({ identity, event }),
      sendAttachment: async (body, signal) => {
        signal.throwIfAborted();
        uploads.push({ identity, body });
      },
      close: async () => { closed.push(identity); },
    }),
    statistics: () => ({ topics: 0, tasks: 0, pendingReplies: 0, failedReplies: 0 }),
    error: () => undefined,
  };
  return { frontend, outputs, uploads, bindings, closed };
}

async function privateDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-private-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Node imports, listens and closes the server with opaque owner and route identities", async t => {
  const directory = await privateDirectory(t);
  const path = join(directory, "ipc", "bridge.sock");
  const h = minimalFrontend();
  const server = new BridgeServer(h.frontend, () => {});
  t.after(() => server.close());
  await server.listen(path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const makeClient = () => {
    const client = new BridgeClient({
      socketPath: path,
      onAttached: () => {}, onPrompt: () => {}, onAgentRequest: async () => true, onDisconnect: () => {},
    });
    t.after(() => client.disconnect());
    return client;
  };
  const owner = "owner:alice", route = "route:thread-A";
  const client = makeClient();
  const identity = { userId: owner, routeId: route, frontend: h.frontend.identity };
  assert.deepEqual(await client.attach("saved-session", owner, route, directory), { type: "attached", ...identity });
  assert.deepEqual(h.bindings, [{ request: {
    type: "attach", sessionId: "saved-session", userId: owner, routeId: route, cwd: directory,
  }, identity }]);
  assert.deepEqual(server.inspect().sessions, [{ userId: owner, routeId: route, sessionId: "saved-session" }]);
  assert.ok(server.attachment(route));
  assert.equal(server.attachment(owner), undefined);
  await assert.rejects(makeClient().attach("other-session", owner, route), /already has an attached session/);
  await assert.rejects(makeClient().attach("saved-session", owner, "route:thread-B"), /already has an attached route/);
  assert.equal(h.bindings.length, 1);
  const event = { type: "text-end", text: "reply" };
  client.output(event);
  await until(() => h.outputs.length === 1);
  assert.deepEqual(h.outputs, [{ identity, event }]);
  const body = { path: join(directory, "report.txt"), fileName: "report.txt" };
  await client.sendAttachment(body);
  assert.deepEqual(h.uploads, [{ identity, body }]);
  await client.disconnect();
  assert.deepEqual(h.closed, [identity]);
  assert.equal(server.attachment(route), undefined);
  const replacement = makeClient();
  await replacement.attach("replacement-session", owner, route);
  await replacement.disconnect();
  await server.close();
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("preparePrivatePath creates and canonicalizes parents, not the destination", async t => {
  const directory = await privateDirectory(t);
  const parent = join(directory, "private", "nested");
  const path = join(parent, "destination");
  assert.equal(preparePrivatePath(path), join(await realpath(parent), "destination"));
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  const alias = join(directory, "alias");
  await symlink(parent, alias);
  assert.equal(preparePrivatePath(join(alias, "destination")), path);
  // A caller must separately reject a linked, public or non-file destination.
  await symlink("missing-target", path);
  assert.equal(preparePrivatePath(path), path);
  await rm(path);
  await writeFile(path, "public", { mode: 0o666 });
  await chmod(path, 0o666);
  assert.equal(preparePrivatePath(path), path);
  assert.equal((await stat(path)).mode & 0o777, 0o666);
  await rm(path);
  await mkdir(path);
  assert.equal(preparePrivatePath(path), path);
});

test("preparePrivatePath rejects writable parents and unprotected ancestors but accepts sticky ancestors", async t => {
  const directory = await privateDirectory(t);
  const parent = join(directory, "parent");
  await mkdir(parent);
  for (const mode of [0o720, 0o702, 0o1777]) {
    await chmod(parent, mode);
    assert.throws(() => preparePrivatePath(join(parent, "file")), /destination directory must be owned/);
  }
  const child = join(parent, "child");
  await chmod(parent, 0o700);
  await mkdir(child, { mode: 0o700 });
  await chmod(parent, 0o777);
  assert.throws(() => preparePrivatePath(join(child, "file")), /ancestor allows substitution/);
  await chmod(parent, 0o1777);
  assert.equal(preparePrivatePath(join(child, "file")), join(child, "file"));
});

test("preparePrivatePath requires immediate parent ownership", async t => {
  if (!process.getuid) return t.skip("UID ownership is unavailable");
  const directory = await privateDirectory(t);
  const uid = (await stat(directory)).uid;
  t.mock.method(process, "getuid", () => uid + 1);
  assert.throws(() => preparePrivatePath(join(directory, "file")), /owned by this user/);
});

test("loadConfig resolves paths without preparing private directories", async t => {
  const directory = await privateDirectory(t);
  const database = join(directory, "not-created", "bridge.sqlite");
  assert.equal(loadConfig({ AGENT_BRIDGE_DATABASE: database }).database, database);
  await assert.rejects(lstat(join(directory, "not-created")), { code: "ENOENT" });
});

test("server still refuses non-sockets, socket links and live sockets", async t => {
  const directory = await privateDirectory(t);
  const server = new BridgeServer(minimalFrontend().frontend, () => {});
  t.after(() => server.close());
  const path = join(directory, "bridge.sock");
  await writeFile(path, "must not replace");
  await assert.rejects(server.listen(path), /non-owned IPC socket/);
  await rm(path);
  const live = new BridgeServer(minimalFrontend().frontend, () => {});
  t.after(() => live.close());
  await live.listen(path);
  const alias = join(directory, "socket-link");
  await symlink(path, alias);
  await assert.rejects(server.listen(alias), /non-owned IPC socket/);
  await assert.rejects(server.listen(path), /already owns this socket/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
const attached={type:"attached",userId:"owner:alice",frontend:{id:"fake:transport",label:"Fake frontend"}};
const prompt={id:"turn-1",content:[{type:"text",text:"[telegram] 你好"},{type:"image-file",path:"/tmp/photo.jpg",mimeType:"image/jpeg"}]};
const line=frame=>`${JSON.stringify(frame)}\n`;
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail("fake socket timed out");}
async function fixture(t,handler,{acknowledgeDetach=true,...options}={}){
 const dir=await mkdtemp(join(tmpdir(),"bridge-ipc-"));const socketPath=join(dir,"test.sock");const sockets=new Set();
 const server=createServer(socket=>{
  sockets.add(socket);socket.on("error",()=>{});socket.on("close",()=>sockets.delete(socket));let buffer="";
  socket.on("data",chunk=>{buffer+=chunk.toString();for(;;){const i=buffer.indexOf("\n");if(i<0)break;const frame=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(frame.type==="detach"&&acknowledgeDetach)socket.end(line({type:"detached"}));else handler(frame,socket);}});
 });
 server.listen(socketPath);await once(server,"listening");
 const frames=[],prompts=[],errors=[],requests=[];
 const client=new BridgeClient({socketPath,onAttached:frame=>frames.push(frame),onPrompt:value=>prompts.push(value),onAgentRequest:async request=>{requests.push(request);return true;},onDisconnect:error=>errors.push(error),...options});
 t.after(async()=>{await client.disconnect();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 return{client,frames,prompts,errors,requests,sockets,dir};
}
test("split/coalesced UTF-8 prompts and correlated replies cross portable IPC",async t=>{
 const seen=[];
 const h=await fixture(t,(frame,socket)=>{seen.push(frame);if(frame.type==="attach"){
  const bytes=Buffer.from(line(attached)+line({type:"prompt",prompt}));const split=bytes.indexOf(Buffer.from("你"))+1;
  socket.write(bytes.subarray(0,split));setImmediate(()=>socket.write(bytes.subarray(split)));
 }else if(frame.type==="request")socket.write(line({type:"result",id:frame.id,result:true}));});
 assert.deepEqual(await h.client.attach("session","42"),attached);await until(()=>h.prompts.length===1);
 assert.deepEqual(h.prompts[0],prompt);assert.equal(await h.client.request("sendAttachment",{path:"/tmp/file.txt",fileName:"file.txt"}),true);
 assert.deepEqual(seen[0],{type:"attach",sessionId:"session",userId:"42"});assert.equal(h.errors.length,0);
});
test("concurrent calls correlate and uncertain delivery is not silently resent",async t=>{
 const calls=[];const h=await fixture(t,(frame,socket)=>{if(frame.type==="attach")socket.write(line(attached));else if(frame.type==="request"){
  calls.push(frame);if(calls.length===2)socket.write(line({type:"error",id:calls[1].id,message:"unknown delivery",unknownOutcome:true})+line({type:"result",id:calls[0].id,result:true}));
 }});
 await h.client.attach("session");const first=h.client.request("sendAttachment",{});const second=h.client.request("sendAttachment",{});
 await assert.rejects(second,BridgeDeliveryUnknown);assert.equal(await first,true);assert.equal(calls.length,2);assert.equal(h.client.isAttached,true);
});
test("reverse agent commands and normalized output do not expose Telegram methods",async t=>{
 const seen=[];const h=await fixture(t,(frame,socket)=>{seen.push(frame);if(frame.type==="attach")socket.write(line(attached)+line({type:"agent-request",id:"reverse-1",operation:"abort",body:{}}));});
 await h.client.attach("session");await until(()=>seen.some(f=>f.type==="agent-result"));assert.deepEqual(h.requests[0],{type:"agent-request",id:"reverse-1",operation:"abort",body:{}});
 h.client.output({type:"text-update",text:"hello"});await until(()=>seen.some(f=>f.type==="output"));assert.deepEqual(seen.find(f=>f.type==="output"),{type:"output",event:{type:"text-update",text:"hello"}});
});
for(const [name,data] of [
 ["invalid JSON","{\n"],["invalid prompt",line({type:"prompt",prompt:{...prompt,id:42}})],
 ["raw Telegram update",line({type:"update",update:{update_id:1}})],
 ["unsolicited reply",line({type:"result",id:"unknown",result:true})],
 ["oversize unfinished frame",Buffer.alloc(MAX_FRAME_BYTES+1,97)],
 ["invalid UTF-8",Buffer.from([0xff,10])],
])test(`client rejects ${name}`,async t=>{
 const h=await fixture(t,(frame,socket)=>{if(frame.type==="attach")socket.write(Buffer.concat([Buffer.from(line(attached)),Buffer.from(data)]));});
 await h.client.attach("session").catch(()=>{});await until(()=>h.errors.length>0);assert.equal(h.client.isAttached,false);
});
test("abort cancels the exact daemon request and ignores only its retired reply",async t=>{
 let request;let cancelled;let socket;
 const h=await fixture(t,(frame,peer)=>{socket=peer;if(frame.type==="attach")peer.write(line(attached));else if(frame.type==="request")request=frame;else if(frame.type==="cancel"){cancelled=frame;peer.write(line({type:"result",id:frame.id,result:true}));}});
 await h.client.attach("session");const controller=new AbortController();const pending=h.client.request("transcribeAudio",{path:"/tmp/voice.wav"},controller.signal);await until(()=>request);controller.abort();
 await assert.rejects(pending,{name:"AbortError"});await until(()=>cancelled);assert.equal(cancelled.id,request.id);assert.equal(h.client.isAttached,true);
 socket.write(line({type:"result",id:"not-retired",result:true}));await until(()=>h.errors.length>0);assert.equal(h.client.isAttached,false);
});
test("detach waits for acknowledgment and rejects pending calls",async t=>{
 let peer;const h=await fixture(t,(frame,socket)=>{peer=socket;if(frame.type==="attach")socket.write(line(attached));},{acknowledgeDetach:false});
 await h.client.attach("session");const pending=h.client.request("transcribeAudio",{});const rejection=assert.rejects(pending,/detached/);
 let done=false;const disconnect=h.client.disconnect().then(()=>done=true);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(done,false);
 peer.end(line({type:"detached"}));await disconnect;await rejection;assert.equal(done,true);assert.equal(h.client.isAttached,false);
 await assert.rejects(h.client.attach("another"),/cannot be reused/);
});
test("large transcripts are read locally instead of exceeding frame limits",async t=>{
 let transcriptPath;
 const h=await fixture(t,(frame,socket)=>{if(frame.type==="attach")socket.write(line(attached));else if(frame.type==="request")socket.write(line({type:"result",id:frame.id,result:{transcriptPath}}));});
 transcriptPath=join(h.dir,"transcript.txt");const text="x".repeat(1200000);await writeFile(transcriptPath,text);
 await h.client.attach("session");assert.equal(await h.client.transcribeAudio("/tmp/voice.wav"),text);
});
test("attach and request timeouts close sockets instead of leaking pending work",async t=>{
 const h=await fixture(t,()=>{}, {attachTimeoutMs:10});await assert.rejects(h.client.attach("session"),/timed out/);
 const second=await fixture(t,(frame,socket)=>{if(frame.type==="attach")socket.write(line(attached));},{requestTimeoutMs:10});
 await second.client.attach("session");await assert.rejects(second.client.request("sendAttachment",{}),/timed out/);assert.equal(second.client.isAttached,false);
});
