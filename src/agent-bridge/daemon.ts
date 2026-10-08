import { createConnection } from "node:net";
import * as v from "valibot";
import { loadConfig, loadEnvironment } from "./config.ts";
import type { SessionBackend } from "./frontend.ts";
import { errorMessage, log } from "./log.ts";
import { bridgeSocketPath, MAX_FRAME_BYTES, ServerFrameSchema } from "./protocol.ts";
import { BridgeServer } from "./server.ts";
import { Store } from "./store.ts";
import { TelegramHttpClient } from "./telegram/api.ts";
import { isPollingConflict, TelegramClient as SharedTelegramClient } from "./telegram/client.ts";
import { TELEGRAM_BOT_COMMANDS } from "./telegram/commands.ts";
import { TelegramConnection } from "./telegram/connection.ts";
import { TelegramError } from "./telegram/errors.ts";
import { TelegramFrontend } from "./telegram/frontend.ts";
import { BotSchema, TelegramUpdateSchema, WebhookSchema } from "./telegram/schemas.ts";

const USAGE = `agent-bridge
agent-bridge start     Run the Telegram daemon in the foreground.
agent-bridge status    Show the bot and attached Pi sessions.
agent-bridge stop      Stop the daemon.
agent-bridge inspect   Print projects, bindings, tasks, and recorded inputs.
agent-bridge help      Show this help.

TELEGRAM_BOT_TOKEN supplies the bot token. Only this daemon may poll it.
AGENT_BRIDGE_OWNER_IDS lists the owners' Telegram IDs, separated by commas.
AGENT_BRIDGE_DATABASE overrides the local SQLite path.

Loads $XDG_CONFIG_HOME/agent-bridge/env (default ~/.config/agent-bridge/env).
Bind a chat/topic with /bind ~/dev/project to start saved native Pi sessions.
Optionally attach a visible Pi session with /bot-connect task_<id> [owner ID],
or /bot-connect [owner ID] for its DM. No worktrees are created automatically.`;

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(stop, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

async function controlDaemon(type: "status" | "stop"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(bridgeSocketPath());
    socket.setEncoding("utf8");
    let buffer = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("Daemon control timed out.")));
    socket.once("error", () => reject(new Error("Cannot contact agent-bridge. Start the daemon first.")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ type })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy();
        reject(new Error("Invalid daemon response."));
        return;
      }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        const frame = v.parse(ServerFrameSchema, JSON.parse(buffer.slice(0, index)));
        process.stdout.write(`${JSON.stringify(frame, null, 2)}\n`);
        socket.end();
        resolve();
      } catch {
        socket.destroy();
        reject(new Error("Invalid daemon response."));
      }
    });
    socket.once("close", () => reject(new Error("Daemon disconnected.")));
  });
}

export async function run(options: { backend?: SessionBackend } = {}): Promise<void> {
  const mode = process.argv[2] ?? "start";
  if (["help", "--help", "-h"].includes(mode)) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!["start", "inspect", "status", "stop"].includes(mode)) throw new Error(`Unknown command: ${mode}`);
  loadEnvironment();
  if (mode === "status" || mode === "stop") {
    await controlDaemon(mode);
    return;
  }
  const config = loadConfig();
  if (mode === "inspect") {
    const store = new Store(config.database);
    try {
      process.stdout.write(`${JSON.stringify(store.snapshot(), null, 2)}\n`);
    } finally {
      store.close();
    }
    return;
  }
  const backend = options.backend;
  if (!backend) throw new Error("A native session backend is required to start agent-bridge.");
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in the bridge environment file.");
  const api = new TelegramHttpClient(token);
  const bot = await api.call({ method: "getMe", body: {}, schema: BotSchema });
  const webhook = await api.call({
    method: "getWebhookInfo",
    body: {},
    schema: WebhookSchema,
  });
  if (webhook.url)
    throw new Error("This bot has a webhook. Refusing to delete it; remove it explicitly before polling.");
  const lock = await TelegramConnection.acquire(token);
  let store: Store | undefined;
  const stop = new AbortController();
  const shutdown = () => stop.abort(new Error("Shutdown requested"));
  const dmClient = new SharedTelegramClient(() => ({ botToken: token }));
  let server: BridgeServer | undefined;
  let frontend: TelegramFrontend | undefined;
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    store = new Store(config.database);
    const activeFrontend = new TelegramFrontend(config, store, api, bot, dmClient, backend);
    frontend = activeFrontend;
    server = new BridgeServer(activeFrontend, shutdown);
    activeFrontend.connect(server);
    await server.listen(bridgeSocketPath());
    const commands = [
      ...TELEGRAM_BOT_COMMANDS,
      { command: "bind", description: "Bind this chat/topic to a project (owners only)" },
      { command: "unbind", description: "Disable this chat/topic (owners only)" },
      { command: "where", description: "Show this chat/topic's project" },
    ];
    await dmClient.registerCommands(commands, stop.signal);
    await dmClient.registerCommands(commands, stop.signal, "all_group_chats");
    log({
      level: "info",
      event: "bridge.started",
      details: {
        bot: bot.username,
        mode: config.ownerTelegramUserIds.length ? "routing" : "setup",
      },
    });
    if (!config.ownerTelegramUserIds.length)
      log({
        level: "warn",
        event: "bridge.owner_missing",
        details: {
          action:
            "Use /where in a forum topic to get your ID. Set AGENT_BRIDGE_OWNER_IDS and restart. Task routing is disabled until then.",
        },
      });
    if (!bot.can_read_all_group_messages)
      log({
        level: "warn",
        event: "telegram.privacy_enabled",
        details: {
          action: "Make the bot a group admin, or disable privacy through BotFather and re-add it.",
        },
      });
    const delivery = (async () => {
      while (!stop.signal.aborted) {
        try {
          await activeFrontend.flushOne(stop.signal);
        } catch (error) {
          if (stop.signal.aborted) break;
          log({
            level: "error",
            event: "telegram.delivery_error",
            details: { message: errorMessage(error) },
          });
          if (isPollingConflict(error) || (error instanceof TelegramError && error.code === 401)) {
            shutdown();
            throw error;
          }
        }
        await sleep(3100, stop.signal);
      }
    })();
    void delivery.catch(() => {});
    try {
      while (!stop.signal.aborted) {
        try {
          const offset = store.offset(activeFrontend.transportId);
          const updates = await api.call({
            method: "getUpdates",
            schema: v.array(TelegramUpdateSchema),
            signal: stop.signal,
            body: {
              ...(offset === undefined ? {} : { offset }),
              timeout: 25,
              allowed_updates: ["message", "edited_message", "callback_query"],
            },
          });
          for (const update of updates) {
            if (stop.signal.aborted) break;
            const result = await activeFrontend.accept(update);
            if (result?.kind === "routed")
              log({
                level: "info",
                event: "task.input",
                details: {
                  taskId: result.task.id,
                  projectId: result.task.projectId,
                  sequence: result.input.sequence,
                  created: result.created,
                },
              });
          }
        } catch (error) {
          if (stop.signal.aborted) break;
          if (isPollingConflict(error) || (error instanceof TelegramError && error.code === 401)) throw error;
          log({
            level: "error",
            event: "telegram.poll_error",
            details: { message: errorMessage(error) },
          });
          await sleep(error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 3000, stop.signal);
        }
      }
    } finally {
      shutdown();
      await delivery;
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    const closed = await Promise.allSettled([frontend?.close(), backend.close()]);
    try {
      await server?.close();
    } finally {
      store?.close();
      await lock.release();
    }
    const failures = closed.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) {
      log({ level: "error", event: "bridge.shutdown_failed", details: { count: failures.length } });
      process.exitCode = 1;
    }
  }
}
