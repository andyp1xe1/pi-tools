import type { AgentPort } from "../frontend.ts";
import type { TelegramClient } from "./client.ts";
import type { TelegramMessage } from "./schemas.ts";

export const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Show bot help" },
  { command: "help", description: "Show available commands" },
  { command: "new", description: "Start a separate saved conversation" },
  { command: "model", description: "Choose the active model" },
  { command: "thinking", description: "Choose the thinking level" },
  { command: "status", description: "Show model, usage, cost, and context" },
  { command: "compact", description: "Compact the current session" },
  { command: "stop", description: "Abort the current turn" },
] as const;
export function messageCommand(message: TelegramMessage): string {
  return (
    (message.text || message.caption || "")
      .trim()
      .toLowerCase()
      .split(/\s+/, 1)[0]
      ?.replace(/@[a-z0-9_]+$/, "") ?? ""
  );
}
export function isControlMessage(message: TelegramMessage): boolean {
  const command = messageCommand(message);
  return command === "stop" || TELEGRAM_BOT_COMMANDS.some((entry) => command === `/${entry.command}`);
}
export async function handleTelegramCommand(options: {
  message: TelegramMessage;
  agent: AgentPort;
  client: TelegramClient;
  showModelPicker(): Promise<void>;
  showThinkingPicker(): Promise<void>;
  run(task: Promise<unknown>): void;
  cancelPending?(): boolean;
}): Promise<void> {
  const { message, agent, client } = options;
  const send = (text: string) =>
    agent.current() ? client.sendText(message.chat.id, message.message_id, text) : Promise.resolve(undefined);
  switch (messageCommand(message)) {
    case "stop":
    case "/stop": {
      const cancelled = options.cancelPending?.() ?? false;
      await send((await agent.abort()) || cancelled ? "Aborted current turn." : "No active turn.");
      return;
    }
    case "/new": {
      if (!(await agent.snapshot()).idle) {
        await send('Cannot start a new thread while the agent is busy. Send "/stop" first.');
        return;
      }
      await send("Starting a new thread. The new session will reattach automatically.");
      if (!(await agent.newSession())) await send("The agent became busy. No new thread was started.");
      return;
    }
    case "/compact": {
      if (!(await agent.snapshot()).idle) {
        await send('Cannot compact while the agent is busy. Send "/stop" first.');
        return;
      }
      await send("Compaction started.");
      options.run(
        agent
          .compact()
          .then((completed) =>
            send(completed ? "Compaction completed." : "The agent became busy. Compaction was not started."),
          )
          .catch((error) => send(`Compaction failed: ${error instanceof Error ? error.message : "unknown error"}`)),
      );
      return;
    }
    case "/model":
      await options.showModelPicker();
      return;
    case "/thinking":
      await options.showThinkingPicker();
      return;
    case "/status":
      await send((await agent.snapshot()).status);
      return;
    default:
      await send(
        "Send me a message and I will forward it to the attached agent. Commands: /new, /model, /thinking, /status, /compact, /stop.",
      );
  }
}
