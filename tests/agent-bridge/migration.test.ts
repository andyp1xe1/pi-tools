import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferTelegram } from "../../scripts/transfer-telegram.ts";
import { loadEnvironment } from "../../src/agent-bridge/config.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { TelegramConnection } from "../../src/agent-bridge/telegram/connection.ts";

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),"bot-migration-"));
 return {dir,sourcePath:join(dir,"legacy.json"),environmentPath:join(dir,"config","env"),database:join(dir,"data","db.sqlite")};
}
test("explicit migration transfers existing token, owner and cursor, then removes legacy credentials",async()=>{
 const h=fixture();const token=`${2_100_000_000+process.pid}:fake`;
 try {
  writeFileSync(h.sourcePath,JSON.stringify({botToken:token,allowedUserId:7,lastUpdateId:100}),{mode:0o600});
  await transferTelegram(h);
  expect(existsSync(h.sourcePath)).toBe(false);
  expect(statSync(h.environmentPath).mode&0o777).toBe(0o600);
  const env:NodeJS.ProcessEnv={AGENT_BRIDGE_ENV_FILE:h.environmentPath};loadEnvironment(env);
  expect(env.TELEGRAM_BOT_TOKEN).toBe(token);expect(env.AGENT_BRIDGE_OWNER_IDS).toBe("7");
  const store=new Store(h.database);try {expect(store.offset(`telegram:${token.split(":")[0]}`)).toBe(101);}finally{store.close();}
  await expect(transferTelegram(h)).rejects.toThrow("already exists");
 }finally{rmSync(h.dir,{recursive:true});}
});
test("migration refuses while old poller owns bot and never consumes or rewrites its credentials",async()=>{
 const h=fixture();const token=`${2_200_000_000+process.pid}:fake`;
 const lock=await TelegramConnection.acquire(token);
 try {
  const source=JSON.stringify({botToken:token,allowedUserId:7});writeFileSync(h.sourcePath,source,{mode:0o600});
  await expect(transferTelegram(h)).rejects.toThrow("already connected");
  expect(readFileSync(h.sourcePath,"utf8")).toBe(source);expect(existsSync(h.environmentPath)).toBe(false);
 }finally{await lock.release();rmSync(h.dir,{recursive:true});}
});
test("XDG file loading preserves explicit environment values and refuses public credentials",()=>{
 const h=fixture();try {
  writeFileSync(h.sourcePath,"TELEGRAM_BOT_TOKEN=fake\nAGENT_BRIDGE_OWNER_IDS=7\n",{mode:0o600});
  const env:NodeJS.ProcessEnv={AGENT_BRIDGE_ENV_FILE:h.sourcePath,TELEGRAM_BOT_TOKEN:"override"};loadEnvironment(env);
  expect(env.TELEGRAM_BOT_TOKEN).toBe("override");expect(env.AGENT_BRIDGE_OWNER_IDS).toBe("7");
  chmodSync(h.sourcePath,0o644);expect(()=>loadEnvironment(env)).toThrow("private");
 }finally{rmSync(h.dir,{recursive:true});}
});
