import { mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isAbortError, type TelegramCallOptions, TelegramClient, waitBeforeRetry } from "./client.ts";
import { handleTelegramCommand, TELEGRAM_BOT_COMMANDS } from "./commands.ts";
import { readTelegramConfig, writeTelegramConfig } from "./config.ts";
import { MAX_MESSAGE_LENGTH, SYSTEM_PROMPT_SUFFIX, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS, TEMP_DIR } from "./constants.ts";
import {
  extractAssistantText,
  getMessageText,
  isAssistantMessage,
  isTelegramPrompt,
  isTelegramUserMessage,
} from "./messages.ts";
import { TelegramPickers } from "./pickers.ts";
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

export class TelegramBridge {
  private config: TelegramConfig = {};
  private pollingController?: AbortController;
  private pollingPromise?: Promise<void>;
  private queuedTurns: PendingTelegramTurn[] = [];
  private deferredTurns: Array<{ turn: PendingTelegramTurn; ctx: ExtensionContext }> = [];
  private activeTurn?: ActiveTelegramTurn;
  private typingInterval?: ReturnType<typeof setInterval>;
  private currentAbort?: () => void;
  private latestAgentMessages: AgentMessage[] = [];
  private setupInProgress = false;
  private compacting = false;
  private readonly mediaGroups = new Map<string, TelegramMediaGroupState>();
  private readonly client: TelegramClient;
  private readonly pickers: TelegramPickers;
  private readonly preview: TelegramPreview;

  constructor(private readonly pi: ExtensionAPI) {
    this.client = new TelegramClient(() => this.config);
    this.pickers = new TelegramPickers(pi, this.client);
    this.preview = new TelegramPreview(this.client);
  }

  register(): void {
    this.registerAttachmentTool();
    this.registerPiCommands();
    this.registerEventHandlers();
  }

  private callTelegram<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramCallOptions,
  ): Promise<TResponse> {
    return this.client.call<TResponse>(method, body, options);
  }

  private updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "telegram");
    if (error) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
      return;
    }
    if (!this.config.botToken) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
      return;
    }
    if (!this.pollingPromise) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
      return;
    }
    if (!this.config.allowedUserId) {
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
      return;
    }
    const incomingCount = this.queuedTurns.length + this.deferredTurns.length;
    if (this.activeTurn) {
      const incoming = incomingCount ? theme.fg("muted", ` · ${incomingCount} incoming`) : "";
      ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "replying")}${incoming}`);
      return;
    }
    if (incomingCount) {
      ctx.ui.setStatus(
        "telegram",
        `${label} ${theme.fg("success", "connected")} ${theme.fg("muted", `· ${incomingCount} incoming`)}`,
      );
      return;
    }
    ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
  }

  private startTypingLoop(chatId?: number): void {
    const targetChatId = chatId ?? this.activeTurn?.chatId;
    if (this.typingInterval || targetChatId === undefined) return;
    void this.sendTyping(targetChatId);
    this.typingInterval = setInterval(() => void this.sendTyping(targetChatId), 4000);
  }

  private async sendTyping(chatId: number): Promise<void> {
    try {
      await this.callTelegram("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // Typing indicators are best-effort.
    }
  }

  private stopTypingLoop(): void {
    if (!this.typingInterval) return;
    clearInterval(this.typingInterval);
    this.typingInterval = undefined;
  }

  private reportError(ctx: ExtensionContext, operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateStatus(ctx, `${operation}: ${message}`);
  }

  private runTask(ctx: ExtensionContext, operation: string, task: Promise<unknown>): void {
    void task.catch((error: unknown) => this.reportError(ctx, operation, error));
  }

  private sendText(chatId: number, messageId: number, text: string): Promise<number | undefined> {
    return this.client.sendText(chatId, messageId, text);
  }

  private async sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
    for (const attachment of turn.queuedAttachments) {
      try {
        await this.client.sendAttachment(turn.chatId, attachment);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendText(
          turn.chatId,
          turn.replyToMessageId,
          `Failed to send attachment ${attachment.fileName}: ${message}`,
        );
      }
    }
  }

  private async promptForConfig(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || this.setupInProgress) return;
    this.setupInProgress = true;
    try {
      const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
      if (!token) return;

      const nextConfig: TelegramConfig = { ...this.config, botToken: token.trim() };
      const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
      const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
      if (!data.ok || !data.result) {
        ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
        return;
      }

      nextConfig.botId = data.result.id;
      nextConfig.botUsername = data.result.username;
      this.config = nextConfig;
      await writeTelegramConfig(this.config);
      ctx.ui.notify(`Telegram bot connected: @${this.config.botUsername ?? "unknown"}`, "info");
      ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
      await this.startPolling(ctx);
    } finally {
      this.setupInProgress = false;
      this.updateStatus(ctx);
    }
  }

  private async stopPolling(): Promise<void> {
    this.stopTypingLoop();
    this.pollingController?.abort();
    this.pollingController = undefined;
    await this.pollingPromise?.catch(() => undefined);
    this.pollingPromise = undefined;
  }

  private async dispatchMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
    const firstMessage = messages[0];
    if (!firstMessage) return;
    const rawText =
      messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
    const handled = await handleTelegramCommand({
      message: firstMessage,
      text: rawText,
      ctx,
      abortCurrent: this.currentAbort,
      isPaired: this.config.allowedUserId !== undefined,
      pair: async (userId) => {
        this.config.allowedUserId = userId;
        await writeTelegramConfig(this.config);
        this.updateStatus(ctx);
      },
      sendText: (chatId, messageId, text) => this.sendText(chatId, messageId, text),
      updateStatus: () => this.updateStatus(ctx),
      runTask: (operation, task) => this.runTask(ctx, operation, task),
      startNewSession: () => this.startNewSession(),
      showModelPicker: () => this.pickers.showModelPicker(firstMessage.chat.id, ctx),
      showThinkingPicker: () => this.pickers.showThinkingPicker(firstMessage.chat.id, ctx),
    });
    if (handled) return;

    const turn = await createTelegramTurn(this.pi, this.client, messages);
    if (this.compacting) {
      this.deferredTurns.push({ turn, ctx });
      this.updateStatus(ctx);
      return;
    }
    await this.deliverTurn(turn, ctx);
  }

  private startNewSession(): void {
    this.pi.sendUserMessage("/telegram-new", { expandPromptTemplates: true });
  }

  private async deliverTurn(turn: PendingTelegramTurn, ctx: ExtensionContext): Promise<void> {
    this.queuedTurns.push(turn);
    this.updateStatus(ctx);
    try {
      this.pi.sendUserMessage(turn.content, { deliverAs: "steer" });
    } catch (error) {
      const queuedIndex = this.queuedTurns.indexOf(turn);
      if (queuedIndex >= 0) this.queuedTurns.splice(queuedIndex, 1);
      this.updateStatus(ctx);
      const message = error instanceof Error ? error.message : String(error);
      await this.sendText(turn.chatId, turn.replyToMessageId, `Could not deliver this message to pi: ${message}`);
    }
  }

  private async flushDeferredTurns(): Promise<void> {
    const deferred = this.deferredTurns.splice(0);
    for (const { turn, ctx } of deferred) await this.deliverTurn(turn, ctx);
  }

  private async handleAuthorizedMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
    if (!message.media_group_id) {
      await this.dispatchMessages([message], ctx);
      return;
    }

    const key = `${message.chat.id}:${message.media_group_id}`;
    const existing = this.mediaGroups.get(key) ?? { messages: [] };
    existing.messages.push(message);
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    existing.flushTimer = setTimeout(() => {
      const state = this.mediaGroups.get(key);
      this.mediaGroups.delete(key);
      if (state) this.runTask(ctx, "message delivery failed", this.dispatchMessages(state.messages, ctx));
    }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
    this.mediaGroups.set(key, existing);
  }

  private async handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
    const callback = update.callback_query;
    if (callback) {
      if (callback.from.is_bot || callback.from.id !== this.config.allowedUserId) {
        await this.client.answerCallbackQuery(callback.id, "This bot is not authorized for your account.");
        return;
      }
      await this.pickers.handleCallback(callback, ctx);
      return;
    }

    const message = update.message || update.edited_message;
    if (message?.chat.type !== "private" || !message.from || message.from.is_bot) return;

    if (this.config.allowedUserId === undefined) {
      this.config.allowedUserId = message.from.id;
      await writeTelegramConfig(this.config);
      this.updateStatus(ctx);
      await this.sendText(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
    }

    if (message.from.id !== this.config.allowedUserId) {
      await this.sendText(message.chat.id, message.message_id, "This bot is not authorized for your account.");
      return;
    }

    if (this.config.lastChatId !== message.chat.id) {
      this.config.lastChatId = message.chat.id;
      await writeTelegramConfig(this.config);
    }
    await this.handleAuthorizedMessage(message, ctx);
  }

  private async pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    if (!this.config.botToken) return;
    try {
      await this.callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
    } catch {
      // The bridge can still poll if webhook cleanup was unnecessary or transiently failed.
    }

    if (this.config.lastUpdateId === undefined) {
      try {
        const updates = await this.callTelegram<TelegramUpdate[]>(
          "getUpdates",
          { offset: -1, limit: 1, timeout: 0 },
          { signal },
        );
        const last = updates.at(-1);
        if (last) {
          this.config.lastUpdateId = last.update_id;
          await writeTelegramConfig(this.config);
        }
      } catch {
        // Continue into the reconnecting poll loop.
      }
    }

    while (!signal.aborted) {
      try {
        const updates = await this.callTelegram<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.config.lastUpdateId !== undefined ? this.config.lastUpdateId + 1 : undefined,
            limit: 10,
            timeout: 30,
            allowed_updates: ["message", "edited_message", "callback_query"],
          },
          { signal, retries: 0 },
        );
        for (const update of updates) {
          await this.handleUpdate(update, ctx);
          this.config.lastUpdateId = update.update_id;
          await writeTelegramConfig(this.config);
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        this.updateStatus(ctx, "reconnecting");
        try {
          await waitBeforeRetry(1000, signal);
        } catch {
          return;
        }
        this.updateStatus(ctx);
      }
    }
  }

  private async startPolling(ctx: ExtensionContext): Promise<void> {
    if (!this.config.botToken || this.pollingPromise) return;
    const controller = new AbortController();
    this.pollingController = controller;
    try {
      await this.client.registerCommands(TELEGRAM_BOT_COMMANDS, controller.signal);
    } catch (error) {
      controller.abort();
      this.pollingController = undefined;
      throw new Error(
        `Failed to register Telegram commands: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.pollingPromise = this.pollLoop(ctx, controller.signal).finally(() => {
      this.pollingPromise = undefined;
      this.pollingController = undefined;
      this.updateStatus(ctx);
    });
    this.updateStatus(ctx);
  }

  private registerAttachmentTool(): void {
    this.pi.registerTool({
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
      execute: async (_toolCallId, params, signal) => {
        if (!this.pollingPromise) throw new Error("Telegram bridge is not connected. Run /telegram-connect first.");
        const chatId = this.activeTurn?.chatId ?? this.config.lastChatId ?? this.config.allowedUserId;
        if (chatId === undefined) throw new Error("Telegram bridge is not paired. Send /start to the bot first.");

        const attachments: QueuedAttachment[] = [];
        for (const inputPath of params.paths) {
          const stats = await stat(inputPath);
          if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
          attachments.push({ path: inputPath, fileName: basename(inputPath) });
        }

        if (this.activeTurn) {
          this.activeTurn.queuedAttachments.push(...attachments);
          return {
            content: [
              { type: "text" as const, text: `Queued ${attachments.length} Telegram attachment(s) for this reply.` },
            ],
            details: { paths: params.paths, delivery: "after-reply" },
          };
        }

        for (const attachment of attachments) await this.client.sendAttachment(chatId, attachment, signal);
        return {
          content: [{ type: "text" as const, text: `Sent ${attachments.length} Telegram attachment(s).` }],
          details: { paths: params.paths, delivery: "immediate" },
        };
      },
    });
  }

  private registerPiCommands(): void {
    this.pi.registerCommand("telegram-setup", {
      description: "Configure Telegram bot token",
      handler: async (_args, ctx) => this.promptForConfig(ctx),
    });
    this.pi.registerCommand("telegram-new", {
      description: "Start a new pi thread and reconnect Telegram",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        const parentSession = ctx.sessionManager.getSessionFile();
        const result = await ctx.newSession({
          ...(parentSession ? { parentSession } : {}),
          withSession: async (replacementCtx) => {
            await replacementCtx.sendUserMessage("/telegram-connect notify", { expandPromptTemplates: true });
          },
        });
        if (result.cancelled) ctx.ui.notify("New Telegram thread was cancelled.", "warning");
      },
    });
    this.pi.registerCommand("telegram-status", {
      description: "Show Telegram bridge status",
      handler: async (_args, ctx) => {
        const status = [
          `bot: ${this.config.botUsername ? `@${this.config.botUsername}` : "not configured"}`,
          `allowed user: ${this.config.allowedUserId ?? "not paired"}`,
          `polling: ${this.pollingPromise ? "running" : "stopped"}`,
          `replying to Telegram: ${this.activeTurn ? "yes" : "no"}`,
          `incoming messages waiting for pi: ${this.queuedTurns.length + this.deferredTurns.length}`,
        ];
        ctx.ui.notify(status.join(" | "), "info");
      },
    });
    this.pi.registerCommand("telegram-connect", {
      description: "Start the Telegram bridge in this pi session",
      handler: async (args, ctx) => {
        this.config = await readTelegramConfig();
        if (!this.config.botToken) return this.promptForConfig(ctx);
        await this.startPolling(ctx);
        if (args.trim() === "notify" && this.config.lastChatId !== undefined) {
          await this.sendText(this.config.lastChatId, 0, "New pi thread ready. Telegram is connected.");
        }
      },
    });
    this.pi.registerCommand("telegram-disconnect", {
      description: "Stop the Telegram bridge in this pi session",
      handler: async (_args, ctx) => {
        await this.stopPolling();
        this.updateStatus(ctx);
      },
    });
  }

  private registerEventHandlers(): void {
    this.pi.on("session_start", async (_event, ctx) => this.onSessionStart(ctx));
    this.pi.on("session_before_compact", async () => {
      this.compacting = true;
    });
    this.pi.on("session_compact", async () => {
      this.compacting = false;
      await this.flushDeferredTurns();
    });
    this.pi.on("session_compact_failed", async () => {
      this.compacting = false;
      await this.flushDeferredTurns();
    });
    this.pi.on("session_shutdown", async () => this.onSessionShutdown());
    this.pi.on("before_agent_start", async (event) => ({
      systemPrompt:
        event.systemPrompt +
        (isTelegramPrompt(event.prompt)
          ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
          : SYSTEM_PROMPT_SUFFIX),
    }));
    this.pi.on("agent_start", async (_event, ctx) => {
      if (this.compacting) {
        this.compacting = false;
        await this.flushDeferredTurns();
      }
      this.currentAbort = () => ctx.abort();
      this.updateStatus(ctx);
    });
    this.pi.on("message_start", async (event, ctx) => this.onMessageStart(event.message, ctx));
    this.pi.on("message_update", async (event, ctx) => this.onMessageUpdate(event.message, ctx));
    this.pi.on("agent_end", async (event) => {
      this.latestAgentMessages = event.messages;
    });
    this.pi.on("agent_settled", async (_event, ctx) => this.onAgentSettled(ctx));
  }

  private async onSessionStart(ctx: ExtensionContext): Promise<void> {
    this.compacting = false;
    this.config = await readTelegramConfig();
    await mkdir(TEMP_DIR, { recursive: true });
    this.updateStatus(ctx);
  }

  private async onSessionShutdown(): Promise<void> {
    this.compacting = false;
    this.queuedTurns = [];
    this.deferredTurns = [];
    this.pickers.clear();
    for (const state of this.mediaGroups.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
    this.mediaGroups.clear();
    if (this.activeTurn) await this.preview.clear(this.activeTurn.chatId);
    this.activeTurn = undefined;
    this.currentAbort = undefined;
    await this.stopPolling();
  }

  private async onMessageStart(message: AgentMessage, ctx: ExtensionContext): Promise<void> {
    if (isTelegramUserMessage(message)) {
      const nextTurn = this.queuedTurns.shift();
      if (!nextTurn) return;
      if (this.activeTurn) {
        this.activeTurn.replyToMessageId = nextTurn.replyToMessageId;
        this.activeTurn.queuedAttachments.push(...nextTurn.queuedAttachments);
      } else {
        this.activeTurn = { ...nextTurn };
        this.preview.start();
      }
      this.startTypingLoop(nextTurn.chatId);
      this.updateStatus(ctx);
      return;
    }

    if (!this.activeTurn || !isAssistantMessage(message)) return;
    if (this.preview.hasContent()) {
      try {
        await this.preview.finalize(this.activeTurn.chatId);
      } catch (error) {
        this.reportError(ctx, "preview failed", error);
      }
    }
    this.preview.start();
  }

  private onMessageUpdate(message: AgentMessage, ctx: ExtensionContext): void {
    if (!this.activeTurn || !isAssistantMessage(message)) return;
    this.preview.update(getMessageText(message));
    this.preview.schedule(this.activeTurn.chatId, (error) => this.reportError(ctx, "preview failed", error));
  }

  private async onAgentSettled(ctx: ExtensionContext): Promise<void> {
    const turn = this.activeTurn;
    this.currentAbort = undefined;
    this.stopTypingLoop();
    this.activeTurn = undefined;
    this.updateStatus(ctx);
    if (!turn) return;

    try {
      const assistant = extractAssistantText(this.latestAgentMessages);
      if (assistant.stopReason === "aborted") {
        await this.preview.clear(turn.chatId);
        return;
      }
      if (assistant.stopReason === "error") {
        await this.preview.clear(turn.chatId);
        await this.sendText(
          turn.chatId,
          turn.replyToMessageId,
          assistant.errorMessage || "Telegram bridge: pi failed while processing the request.",
        );
        return;
      }

      const finalText = assistant.text;
      if (finalText) this.preview.update(finalText);
      if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
        await this.preview.finalize(turn.chatId);
      } else {
        await this.preview.clear(turn.chatId);
        if (finalText) await this.sendText(turn.chatId, turn.replyToMessageId, finalText);
        else if (turn.queuedAttachments.length) {
          await this.sendText(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
        }
      }
      await this.sendQueuedAttachments(turn);
    } catch (error) {
      this.reportError(ctx, "reply failed", error);
    }
  }
}
