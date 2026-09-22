import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./messages.ts";
import type { TelegramMessage } from "./types.ts";

export const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Pair with this pi session" },
  { command: "help", description: "Show available commands" },
  { command: "new", description: "Start a new pi thread" },
  { command: "model", description: "Choose the active model" },
  { command: "thinking", description: "Choose the thinking level" },
  { command: "status", description: "Show model, usage, cost, and context" },
  { command: "compact", description: "Compact the current pi session" },
  { command: "stop", description: "Abort the current pi turn" },
] as const;

interface TelegramCommandOptions {
  message: TelegramMessage;
  text: string;
  ctx: ExtensionContext;
  abortCurrent?: () => void;
  isPaired: boolean;
  pair(userId: number): Promise<void>;
  sendText(chatId: number, messageId: number, text: string): Promise<unknown>;
  updateStatus(): void;
  runTask(operation: string, task: Promise<unknown>): void;
  startNewSession(): void;
  showModelPicker(): Promise<void>;
  showThinkingPicker(): Promise<void>;
}

export async function handleTelegramCommand(options: TelegramCommandOptions): Promise<boolean> {
  const { message, ctx } = options;
  const firstToken = options.text.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  const command = firstToken.replace(/@[a-z0-9_]+$/, "");

  if (command === "stop" || command === "/stop") {
    if (options.abortCurrent) {
      options.abortCurrent();
      options.updateStatus();
      await options.sendText(message.chat.id, message.message_id, "Aborted current turn.");
    } else {
      await options.sendText(message.chat.id, message.message_id, "No active turn.");
    }
    return true;
  }

  if (command === "/new") {
    if (!ctx.isIdle()) {
      await options.sendText(
        message.chat.id,
        message.message_id,
        'Cannot start a new thread while pi is busy. Send "/stop" first.',
      );
      return true;
    }
    await options.sendText(
      message.chat.id,
      message.message_id,
      "Starting a new pi thread. Telegram will reconnect automatically.",
    );
    options.startNewSession();
    return true;
  }

  if (command === "/model") {
    await options.showModelPicker();
    return true;
  }

  if (command === "/thinking") {
    await options.showThinkingPicker();
    return true;
  }

  if (command === "/compact") {
    if (!ctx.isIdle()) {
      await options.sendText(
        message.chat.id,
        message.message_id,
        'Cannot compact while pi is busy. Send "stop" first.',
      );
      return true;
    }
    ctx.compact({
      onComplete: () => {
        options.runTask(
          "compact reply failed",
          options.sendText(message.chat.id, message.message_id, "Compaction completed."),
        );
      },
      onError: (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        options.runTask(
          "compact reply failed",
          options.sendText(message.chat.id, message.message_id, `Compaction failed: ${detail}`),
        );
      },
    });
    await options.sendText(message.chat.id, message.message_id, "Compaction started.");
    return true;
  }

  if (command === "/status") {
    await options.sendText(message.chat.id, message.message_id, buildStatus(ctx));
    return true;
  }

  if (command === "/help" || command === "/start") {
    await options.sendText(
      message.chat.id,
      message.message_id,
      "Send me a message and I will forward it to pi. Commands: /new, /model, /thinking, /status, /compact, /stop.",
    );
    if (!options.isPaired && message.from) await options.pair(message.from.id);
    return true;
  }

  return false;
}

function buildStatus(ctx: ExtensionContext): string {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    totalInput += entry.message.usage.input;
    totalOutput += entry.message.usage.output;
    totalCacheRead += entry.message.usage.cacheRead;
    totalCacheWrite += entry.message.usage.cacheWrite;
    totalCost += entry.message.usage.cost.total;
  }

  const lines: string[] = [];
  if (ctx.model) lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);

  const tokenParts: string[] = [];
  if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
  if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
  if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
  if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
  if (tokenParts.length) lines.push(`Usage: ${tokenParts.join(" ")}`);

  const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
  if (totalCost || usingSubscription) lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

  const usage = ctx.getContextUsage();
  if (usage) {
    const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
    lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
  } else {
    lines.push("Context: unknown");
  }
  return lines.length ? lines.join("\n") : "No usage data yet.";
}
