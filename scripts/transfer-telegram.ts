import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as v from "valibot";
import { homedir } from "node:os";
import { join } from "node:path";
import { environmentPath, loadConfig, preparePrivatePath } from "../src/agent-bridge/config.ts";
import { TelegramConnection } from "../src/agent-bridge/telegram/connection.ts";
import { PositiveInteger } from "../src/agent-bridge/telegram/schemas.ts";
import { Store } from "../src/agent-bridge/store.ts";

const SourceSchema = v.object({ botToken:v.pipe(v.string(),v.regex(/^[1-9]\d*:[a-zA-Z0-9_-]+$/)), allowedUserId:v.optional(PositiveInteger), lastUpdateId:v.optional(v.pipe(v.number(),v.integer(),v.minValue(0))) });
export async function transferTelegram(options: { sourcePath:string; environmentPath:string; database:string }): Promise<void> {
 if(existsSync(options.environmentPath)) throw new Error("The bridge environment file already exists. Refusing to overwrite credentials.");
 const fd=openSync(options.sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW);
 let content: unknown; let modified:number;
 try {
  const stat=fstatSync(fd);
  if(!stat.isFile() || stat.nlink!==1 || (process.getuid && stat.uid!==process.getuid())) throw new Error("The source configuration must be a regular file owned by this user.");
  modified=stat.mtimeMs;
  try { content=JSON.parse(readFileSync(fd,"utf8")); } catch { throw new Error("Invalid source Telegram configuration. Contents redacted."); }
 } finally { closeSync(fd); }
 const parsed=v.safeParse(SourceSchema,content);
 if(!parsed.success) throw new Error("Invalid source Telegram configuration. Contents redacted.");
 const source=parsed.output;
 const lock=await TelegramConnection.acquire(source.botToken);
 try {
  const path=preparePrivatePath(options.environmentPath);
  const store=new Store(options.database);
  try {
   const botId=source.botToken.split(":")[0];
   if(source.lastUpdateId!==undefined && Date.now()-modified<6*24*60*60*1000 && store.offset(`telegram:${botId}`)===undefined) {
    store.advance({transportId:`telegram:${botId}`,nextOffset:source.lastUpdateId+1,now:Math.floor(modified)});
   }
   writeFileSync(path,`TELEGRAM_BOT_TOKEN=${source.botToken}\nAGENT_BRIDGE_OWNER_IDS=${source.allowedUserId ?? ""}\n`,{flag:"wx",mode:0o600});
   unlinkSync(options.sourcePath);
  } finally { store.close(); }
 } finally { await lock.release(); }
}

if (import.meta.main) {
 try {
  await transferTelegram({ sourcePath: process.argv[2] ?? join(homedir(), ".pi", "agent", "telegram.json"), environmentPath: environmentPath(), database: loadConfig().database });
  process.stdout.write("Bot credentials, owner, and fresh cursor transferred. Source credential file removed. Start agent-bridge, then /bot-connect in Pi.\n");
 } catch(error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Transfer failed. Contents redacted."}\n`);
  process.exitCode=1;
 }
}
