import { expect, test } from "bun:test";
import { TelegramConnection } from "../../src/agent-bridge/telegram/connection.ts";

test("only one local daemon can own a bot, and shutdown releases ownership", async () => {
 const token = `${2_000_000_000 + process.pid}:fake`;
 const first = await TelegramConnection.acquire(token);
 try { await expect(TelegramConnection.acquire(token)).rejects.toThrow("already connected"); }
 finally { await first.release(); }
 const replacement = await TelegramConnection.acquire(token);
 await replacement.release();
});
