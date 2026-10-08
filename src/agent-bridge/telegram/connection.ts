import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An OS-owned lock: a second local session cannot poll the same bot. */
export class TelegramConnection {
  private constructor(private readonly server: Server) {}

  static async acquire(botToken: string): Promise<TelegramConnection> {
    // Bot identity survives token rotation. Never put a secret in the socket name.
    const botId = botToken.split(":", 1)[0];
    const name = `pi-telegram-${createHash("sha256").update(botId).digest("hex").slice(0, 32)}`;
    // Linux abstract sockets and Windows pipes disappear even on process crashes.
    // On other systems Node removes the filesystem socket on a clean close.
    const path =
      process.platform === "linux"
        ? `\0${name}`
        : process.platform === "win32"
          ? `\\\\.\\pipe\\${name}`
          : join(tmpdir(), `${name}.sock`);
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "EADDRINUSE"
            ? new Error(
                "Telegram is already connected to another local poller. Stop its daemon or session before starting this one." +
                  (process.platform !== "linux" && process.platform !== "win32"
                    ? ` If that session crashed, remove the stale socket ${path}.`
                    : ""),
              )
            : error,
        );
      });
      server.listen(path, resolve);
    });
    return new TelegramConnection(server);
  }

  async release(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
