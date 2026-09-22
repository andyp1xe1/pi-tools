import { mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isAbortError, type TelegramCallOptions, TelegramClient, waitBeforeRetry } from "./client.ts";
import { handleTelegramCommand } from "./commands.ts";
import { readTelegramConfig as readConfig, writeTelegramConfig as writeConfig } from "./config.ts";
import { MAX_MESSAGE_LENGTH, SYSTEM_PROMPT_SUFFIX, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS, TEMP_DIR } from "./constants.ts";
import {
  extractAssistantText,
  getMessageText,
  isAssistantMessage,
  isTelegramPrompt,
  isTelegramUserMessage,
} from "./messages.ts";
import { TelegramPreview } from "./preview.ts";
import { createTelegramTurn } from "./turn.ts";
import type {
  ActiveTelegramTurn,
  PendingTelegramTurn,
  QueuedAttachment,
  TelegramApiResponse,
  TelegramConfig,
  TelegramMediaGroupState,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.ts";

export default function (pi: ExtensionAPI) {
  let config: TelegramConfig = {};
  let pollingController: AbortController | undefined;
  let pollingPromise: Promise<void> | undefined;
  let queuedTelegramTurns: PendingTelegramTurn[] = [];
  let activeTelegramTurn: ActiveTelegramTurn | undefined;
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  let currentAbort: (() => void) | undefined;
  let latestAgentMessages: AgentMessage[] = [];
  let setupInProgress = false;
  const mediaGroups = new Map<string, TelegramMediaGroupState>();
  const client = new TelegramClient(() => config);
  const preview = new TelegramPreview(client);

  function callTelegram<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramCallOptions,
  ): Promise<TResponse> {
    return client.call<TResponse>(method, body, options);
  }

  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "telegram");
    if (error) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
      return;
    }
    if (!config.botToken) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
      return;
    }
    if (!pollingPromise) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
      return;
    }
    if (!config.allowedUserId) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
      return;
    }
    if (activeTelegramTurn) {
      const incoming =
        queuedTelegramTurns.length > 0 ? theme.fg("muted", ` · ${queuedTelegramTurns.length} incoming`) : "";
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "replying")}${incoming}`);
      return;
    }
    if (queuedTelegramTurns.length > 0) {
      ctx.ui.setStatus(
        "telegram",
        `${label} ${theme.fg("success", "connected")} ${theme.fg("muted", `· ${queuedTelegramTurns.length} incoming`)}`,
      );
      return;
    }
    ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
  }

  function startTypingLoop(chatId?: number): void {
    const targetChatId = chatId ?? activeTelegramTurn?.chatId;
    if (typingInterval || targetChatId === undefined) return;

    const sendTyping = async (): Promise<void> => {
      try {
        await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
      } catch {
        // Typing indicators are best-effort. Polling and replies retry independently.
      }
    };

    void sendTyping();
    typingInterval = setInterval(() => {
      void sendTyping();
    }, 4000);
  }

  function stopTypingLoop(): void {
    if (!typingInterval) return;
    clearInterval(typingInterval);
    typingInterval = undefined;
  }

  function reportTelegramError(ctx: ExtensionContext, operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    updateStatus(ctx, `${operation}: ${message}`);
  }

  function runTelegramTask(ctx: ExtensionContext, operation: string, task: Promise<unknown>): void {
    void task.catch((error: unknown) => {
      reportTelegramError(ctx, operation, error);
    });
  }

  function sendTextReply(chatId: number, replyToMessageId: number, text: string): Promise<number | undefined> {
    return client.sendText(chatId, replyToMessageId, text);
  }

  function sendAttachment(chatId: number, attachment: QueuedAttachment, signal?: AbortSignal): Promise<void> {
    return client.sendAttachment(chatId, attachment, signal);
  }

  async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
    for (const attachment of turn.queuedAttachments) {
      try {
        await sendAttachment(turn.chatId, attachment);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          `Failed to send attachment ${attachment.fileName}: ${message}`,
        );
      }
    }
  }

  async function promptForConfig(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || setupInProgress) return;
    setupInProgress = true;
    try {
      const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
      if (!token) return;

      const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
      const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
      const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
      if (!data.ok || !data.result) {
        ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
        return;
      }

      nextConfig.botId = data.result.id;
      nextConfig.botUsername = data.result.username;
      config = nextConfig;
      await writeConfig(config);
      ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
      ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
      await startPolling(ctx);
      updateStatus(ctx);
    } finally {
      setupInProgress = false;
    }
  }

  async function stopPolling(): Promise<void> {
    stopTypingLoop();
    pollingController?.abort();
    pollingController = undefined;
    await pollingPromise?.catch(() => undefined);
    pollingPromise = undefined;
  }

  async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
    const firstMessage = messages[0];
    if (!firstMessage) return;
    const rawText =
      messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
    const handled = await handleTelegramCommand({
      message: firstMessage,
      text: rawText,
      ctx,
      abortCurrent: currentAbort,
      isPaired: config.allowedUserId !== undefined,
      pair: async (userId) => {
        config.allowedUserId = userId;
        await writeConfig(config);
        updateStatus(ctx);
      },
      sendText: sendTextReply,
      updateStatus: () => updateStatus(ctx),
      runTask: (operation, task) => runTelegramTask(ctx, operation, task),
    });
    if (handled) return;

    const turn = await createTelegramTurn(pi, client, messages);
    queuedTelegramTurns.push(turn);
    updateStatus(ctx);
    try {
      pi.sendUserMessage(turn.content, { deliverAs: "steer" });
    } catch (error) {
      const queuedIndex = queuedTelegramTurns.indexOf(turn);
      if (queuedIndex >= 0) queuedTelegramTurns.splice(queuedIndex, 1);
      updateStatus(ctx);
      const message = error instanceof Error ? error.message : String(error);
      await sendTextReply(turn.chatId, turn.replyToMessageId, `Could not deliver this message to pi: ${message}`);
    }
  }

  async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
    if (message.media_group_id) {
      const key = `${message.chat.id}:${message.media_group_id}`;
      const existing = mediaGroups.get(key) ?? { messages: [] };
      existing.messages.push(message);
      if (existing.flushTimer) clearTimeout(existing.flushTimer);
      existing.flushTimer = setTimeout(() => {
        const state = mediaGroups.get(key);
        mediaGroups.delete(key);
        if (!state) return;
        runTelegramTask(ctx, "message delivery failed", dispatchAuthorizedTelegramMessages(state.messages, ctx));
      }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
      mediaGroups.set(key, existing);
      return;
    }

    await dispatchAuthorizedTelegramMessages([message], ctx);
  }

  async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
    const message = update.message || update.edited_message;
    if (message?.chat.type !== "private" || !message.from || message.from.is_bot) return;

    if (config.allowedUserId === undefined) {
      config.allowedUserId = message.from.id;
      await writeConfig(config);
      updateStatus(ctx);
      await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
    }

    if (message.from.id !== config.allowedUserId) {
      await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
      return;
    }

    if (config.lastChatId !== message.chat.id) {
      config.lastChatId = message.chat.id;
      await writeConfig(config);
    }
    await handleAuthorizedTelegramMessage(message, ctx);
  }

  async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    if (!config.botToken) return;

    try {
      await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
    } catch {
      // ignore
    }

    if (config.lastUpdateId === undefined) {
      try {
        const updates = await callTelegram<TelegramUpdate[]>(
          "getUpdates",
          { offset: -1, limit: 1, timeout: 0 },
          { signal },
        );
        const last = updates.at(-1);
        if (last) {
          config.lastUpdateId = last.update_id;
          await writeConfig(config);
        }
      } catch {
        // ignore
      }
    }

    while (!signal.aborted) {
      try {
        const updates = await callTelegram<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
            limit: 10,
            timeout: 30,
            allowed_updates: ["message", "edited_message"],
          },
          { signal, retries: 0 },
        );
        for (const update of updates) {
          await handleUpdate(update, ctx);
          config.lastUpdateId = update.update_id;
          await writeConfig(config);
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        updateStatus(ctx, "reconnecting");
        try {
          await waitBeforeRetry(1000, signal);
        } catch {
          return;
        }
        updateStatus(ctx);
      }
    }
  }

  async function startPolling(ctx: ExtensionContext): Promise<void> {
    if (!config.botToken || pollingPromise) return;
    pollingController = new AbortController();
    pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
      pollingPromise = undefined;
      pollingController = undefined;
      updateStatus(ctx);
    });
    updateStatus(ctx);
  }

  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description:
      "Send one or more local files to the paired Telegram chat. During a Telegram reply, files are sent after the final text. During any other turn, files are sent immediately.",
    promptSnippet: "Send local files to the paired Telegram chat.",
    promptGuidelines: [
      "Use telegram_attach to send requested files to Telegram even when the current prompt came from the terminal.",
      "When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach instead of only mentioning the local path.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1 }),
    }),
    async execute(_toolCallId, params, signal) {
      if (!pollingPromise) {
        throw new Error("Telegram bridge is not connected. Run /telegram-connect first.");
      }
      const chatId = activeTelegramTurn?.chatId ?? config.lastChatId ?? config.allowedUserId;
      if (chatId === undefined) {
        throw new Error("Telegram bridge is not paired. Send /start to the bot first.");
      }

      const attachments: QueuedAttachment[] = [];
      for (const inputPath of params.paths) {
        const stats = await stat(inputPath);
        if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
        attachments.push({ path: inputPath, fileName: basename(inputPath) });
      }

      if (activeTelegramTurn) {
        activeTelegramTurn.queuedAttachments.push(...attachments);
        return {
          content: [{ type: "text", text: `Queued ${attachments.length} Telegram attachment(s) for this reply.` }],
          details: { paths: params.paths, delivery: "after-reply" },
        };
      }

      for (const attachment of attachments) {
        await sendAttachment(chatId, attachment, signal);
      }
      return {
        content: [{ type: "text", text: `Sent ${attachments.length} Telegram attachment(s).` }],
        details: { paths: params.paths, delivery: "immediate" },
      };
    },
  });

  pi.registerCommand("telegram-setup", {
    description: "Configure Telegram bot token",
    handler: async (_args, ctx) => {
      await promptForConfig(ctx);
    },
  });

  pi.registerCommand("telegram-status", {
    description: "Show Telegram bridge status",
    handler: async (_args, ctx) => {
      const status = [
        `bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
        `allowed user: ${config.allowedUserId ?? "not paired"}`,
        `polling: ${pollingPromise ? "running" : "stopped"}`,
        `replying to Telegram: ${activeTelegramTurn ? "yes" : "no"}`,
        `incoming messages waiting for pi: ${queuedTelegramTurns.length}`,
      ];
      ctx.ui.notify(status.join(" | "), "info");
    },
  });

  pi.registerCommand("telegram-connect", {
    description: "Start the Telegram bridge in this pi session",
    handler: async (_args, ctx) => {
      config = await readConfig();
      if (!config.botToken) {
        await promptForConfig(ctx);
        return;
      }
      await startPolling(ctx);
      updateStatus(ctx);
    },
  });

  pi.registerCommand("telegram-disconnect", {
    description: "Stop the Telegram bridge in this pi session",
    handler: async (_args, ctx) => {
      await stopPolling();
      updateStatus(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    config = await readConfig();
    await mkdir(TEMP_DIR, { recursive: true });
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    queuedTelegramTurns = [];
    for (const state of mediaGroups.values()) {
      if (state.flushTimer) clearTimeout(state.flushTimer);
    }
    mediaGroups.clear();
    if (activeTelegramTurn) await preview.clear(activeTelegramTurn.chatId);
    activeTelegramTurn = undefined;
    currentAbort = undefined;
    await stopPolling();
  });

  pi.on("before_agent_start", async (event) => {
    const suffix = isTelegramPrompt(event.prompt)
      ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
      : SYSTEM_PROMPT_SUFFIX;
    return {
      systemPrompt: event.systemPrompt + suffix,
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentAbort = () => ctx.abort();
    updateStatus(ctx);
  });

  pi.on("message_start", async (event, ctx) => {
    if (isTelegramUserMessage(event.message)) {
      const nextTurn = queuedTelegramTurns.shift();
      if (!nextTurn) return;
      if (activeTelegramTurn) {
        activeTelegramTurn.replyToMessageId = nextTurn.replyToMessageId;
        activeTelegramTurn.queuedAttachments.push(...nextTurn.queuedAttachments);
      } else {
        activeTelegramTurn = { ...nextTurn };
        preview.start();
      }
      startTypingLoop(nextTurn.chatId);
      updateStatus(ctx);
      return;
    }

    if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
    if (preview.hasContent()) {
      try {
        await preview.finalize(activeTelegramTurn.chatId);
      } catch (error) {
        reportTelegramError(ctx, "preview failed", error);
      }
    }
    preview.start();
  });

  pi.on("message_update", async (event, ctx) => {
    if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
    preview.update(getMessageText(event.message));
    preview.schedule(activeTelegramTurn.chatId, (error) => reportTelegramError(ctx, "preview failed", error));
  });

  pi.on("agent_end", async (event) => {
    latestAgentMessages = event.messages;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const turn = activeTelegramTurn;
    currentAbort = undefined;
    stopTypingLoop();
    activeTelegramTurn = undefined;
    updateStatus(ctx);
    if (!turn) return;

    try {
      const assistant = extractAssistantText(latestAgentMessages);
      if (assistant.stopReason === "aborted") {
        await preview.clear(turn.chatId);
        return;
      }
      if (assistant.stopReason === "error") {
        await preview.clear(turn.chatId);
        await sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          assistant.errorMessage || "Telegram bridge: pi failed while processing the request.",
        );
        return;
      }

      const finalText = assistant.text;
      if (finalText) preview.update(finalText);

      if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
        await preview.finalize(turn.chatId);
      } else {
        await preview.clear(turn.chatId);
        if (finalText) {
          await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
        } else if (turn.queuedAttachments.length > 0) {
          await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
        }
      }

      await sendQueuedAttachments(turn);
    } catch (error) {
      reportTelegramError(ctx, "reply failed", error);
    }
  });
}
