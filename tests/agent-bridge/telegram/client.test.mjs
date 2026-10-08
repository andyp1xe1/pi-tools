import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,open,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { test } from "node:test";
import { TelegramClient,MAX_UPLOAD_BYTES } from "../../../src/agent-bridge/telegram/client.ts";
import { TelegramDeliveryUnknown } from "../../../src/agent-bridge/telegram/errors.ts";
import { TelegramPreview } from "../../../src/agent-bridge/telegram/preview.ts";

test("accepted sends with lost responses are never retried",async()=>{
 let calls=0;
 const client=new TelegramClient(()=>({botToken:"99:fake"}),async()=>{calls++;throw new Error("response lost");});
 await assert.rejects(client.call("sendMessage",{chat_id:7,text:"one message"}),TelegramDeliveryUnknown);
 assert.equal(calls,1);
});
test("explicit rate-limit rejection is retried but creation server failure is not",async()=>{
 let calls=0;
 const client=new TelegramClient(()=>({botToken:"99:fake"}),async()=>{
  calls++; return new Response(JSON.stringify(calls===1?{ok:false,error_code:429}:{ok:true,result:{message_id:1}}),{status:calls===1?429:200});
 });
 assert.equal((await client.call("sendMessage",{chat_id:7,text:"retry after rejection"})).message_id,1);
 assert.equal(calls,2);
 let rejected=0;
 const serverError=new TelegramClient(()=>({botToken:"99:fake"}),async()=>{rejected++;return new Response(JSON.stringify({ok:false,error_code:500}),{status:500});});
 await assert.rejects(serverError.call("sendMessage",{chat_id:7,text:"unknown outcome"}),TelegramDeliveryUnknown);
 assert.equal(rejected,1);
});
test("unknown preview creation blocks later streaming and finalization from duplicating it",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 let calls=0;let errors=0;
 const preview=new TelegramPreview({async call(){calls++;throw new TelegramDeliveryUnknown();}});
 preview.start();preview.update("first");preview.schedule(7,()=>errors++);
 t.mock.timers.tick(750);await preview.waitForIdle();await new Promise(resolve=>setImmediate(resolve));
 preview.update("final");preview.schedule(7,()=>errors++);await preview.finalize(7);
 assert.equal(calls,1);assert.equal(errors,1);
});
test("explicit text reply anchors survive the shared client",async()=>{
 const calls=[];
 const client=new TelegramClient(()=>({botToken:"99:fake"}),async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({ok:true,result:{message_id:1}}));});
 await client.sendText(7,40,"anchored");
 assert.deepEqual(calls[0].body.reply_parameters,{message_id:40,allow_sending_without_reply:false});
});
async function uploadFixture(t) {
 const dir=await mkdtemp(join(tmpdir(),"bridge-upload-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 let calls=0;
 const client=new TelegramClient(()=>({botToken:"99:fake"}),async()=>{calls++;return new Response(JSON.stringify({ok:true,result:{message_id:1}}));});
 return {dir,client,calls:()=>calls};
}
test("nonregular uploads reject before a FIFO writer exists",async t=>{
 if(process.platform!=="linux")return t.skip("FIFO regression requires Linux");
 const h=await uploadFixture(t);const path=join(h.dir,"pipe");assert.equal(spawnSync("mkfifo",[path]).status,0);
 await assert.rejects(h.client.sendAttachment(7,{path,fileName:"pipe"}),/regular local files/);
 assert.equal(h.calls(),0);
});
test("upload size is bounded before reading file contents",async t=>{
 const h=await uploadFixture(t);const path=join(h.dir,"large.bin");const file=await open(path,"w");await file.truncate(MAX_UPLOAD_BYTES+1);await file.close();
 await assert.rejects(h.client.sendAttachment(7,{path,fileName:"large.bin"}),/50 MiB/);assert.equal(h.calls(),0);
});
test("cancellation stops a bounded filesystem upload read before HTTP",async t=>{
 const h=await uploadFixture(t);const path=join(h.dir,"cancel.bin");await writeFile(path,Buffer.alloc(16*1024*1024));
 const controller=new AbortController();const pending=h.client.sendAttachment(7,{path,fileName:"cancel.bin"},controller.signal);
 setTimeout(()=>controller.abort(),1);await assert.rejects(pending,{name:"AbortError"});assert.equal(h.calls(),0);
});
