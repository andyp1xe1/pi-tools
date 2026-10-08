import { randomUUID } from "node:crypto";
import type { AgentPort } from "../frontend.ts";
import type { AgentOutput } from "../protocol.ts";
import { TelegramClient, type TelegramConversation, type TelegramTransport } from "./client.ts";
import { handleTelegramCommand, isControlMessage, messageCommand } from "./commands.ts";
import { TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS } from "./constants.ts";
import { TelegramPickers } from "./pickers.ts";
import { TelegramPreview } from "./preview.ts";
import type { TelegramMessage, TelegramUpdate } from "./schemas.ts";
import { createTelegramTurn, type PendingTelegramTurn } from "./turn.ts";

type ActiveTelegramTurn = Pick<PendingTelegramTurn, "chatId" | "replyToMessageId">;

interface Slot {
  messages: TelegramMessage[];
  turn?: PendingTelegramTurn;
  cancelled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** One Telegram conversation frontend. No Pi SDK or agent-specific state. */
export class TelegramSession {
  private closed = false;
  private readonly controller = new AbortController();
  private preparation = new AbortController();
  private readonly menus = new Set<number>();
  private readonly client: TelegramClient;
  private readonly chatId: number;
  private readonly pickers: TelegramPickers;
  private readonly preview: TelegramPreview;
  private readonly slots: Slot[] = [];
  private readonly albums = new Map<string, Slot>();
  private readonly routes = new Map<string, ActiveTelegramTurn>();
  private readonly jobs = new Set<Promise<unknown>>();
  private active?: ActiveTelegramTurn;
  private typing?: ReturnType<typeof setInterval>;
  private assistantError?: string;
  constructor(
    private readonly userId: number,
    private readonly agent: AgentPort,
    transport: TelegramTransport,
    private readonly report: (error: unknown) => void = () => {},
    private readonly scope?: Omit<TelegramConversation, "signal" | "menu">,
    private readonly botUsername?: string,
  ) {
    this.chatId = scope?.chatId ?? userId;
    this.client = new TelegramClient(transport, {
      ...scope,
      chatId: this.chatId,
      current: () => this.current(),
      signal: this.controller.signal,
      menu: (id) => {
        this.menus.add(id);
        if (this.menus.size > 256) {
          const oldest = this.menus.values().next().value;
          if (oldest !== undefined) this.menus.delete(oldest);
        }
      },
    });
    this.pickers = new TelegramPickers(agent, this.client);
    this.preview = new TelegramPreview(this.client);
  }
  get isLive(): boolean {
    return this.current();
  }
  private current(): boolean {
    return !this.closed && this.agent.current() && (this.scope?.current() ?? true);
  }
  private run(task: Promise<unknown>): void {
    this.jobs.add(task);
    void task
      .catch((error) => {
        if (this.current()) this.report(error);
      })
      .finally(() => this.jobs.delete(task));
  }
  receive(update: TelegramUpdate): void {
    if (!this.current()) return;
    const callback = update.callback_query;
    if (callback) {
      if (
        callback.from.is_bot ||
        !callback.message ||
        callback.message.chat.id !== this.chatId ||
        (this.scope
          ? (callback.message.is_topic_message ? (callback.message.message_thread_id ?? 1) : 1) !==
            (this.scope.threadId ?? 1)
          : callback.message.chat.type !== "private")
      )
        return;
      if (callback.from.id !== this.userId) {
        this.run(this.client.answerCallbackQuery(callback.id, "Only the attachment owner can control this session."));
        return;
      }
      if (!this.menus.has(callback.message.message_id))
        this.run(this.client.answerCallbackQuery(callback.id, "This menu expired. Run the command again."));
      else this.run(this.pickers.handleCallback(callback));
      return;
    }
    const message = update.message ?? update.edited_message;
    if (
      !message ||
      message.chat.id !== this.chatId ||
      !message.from ||
      message.from.is_bot ||
      message.sender_chat ||
      (this.scope
        ? (message.is_topic_message ? (message.message_thread_id ?? 1) : 1) !== (this.scope.threadId ?? 1)
        : message.chat.type !== "private" || message.from.id !== this.userId)
    )
      return;
    const addressed = /^\/[a-z0-9_]+@([a-z0-9_]+)(?:\s|$)/i.exec((message.text ?? message.caption ?? "").trim());
    if (this.botUsername && addressed?.[1] && addressed[1].toLowerCase() !== this.botUsername.toLowerCase()) return;
    if (isControlMessage(message)) {
      if (message.from.id !== this.userId) {
        this.run(
          this.client.sendText(this.chatId, message.message_id, "Only the attachment owner can control this session."),
        );
        return;
      }
      if (this.scope && messageCommand(message) === "/new") {
        this.run(
          this.client.sendText(
            this.chatId,
            message.message_id,
            "This thread is bound to its existing Pi session. Start a separate thread for a new session.",
          ),
        );
        return;
      }
      this.run(
        handleTelegramCommand({
          message,
          agent: this.agent,
          client: this.client,
          showModelPicker: () => this.pickers.showModelPicker(this.chatId, message.message_id),
          showThinkingPicker: () => this.pickers.showThinkingPicker(this.chatId, message.message_id),
          run: (task) => this.run(task),
          cancelPending: () => this.cancelPending(),
        }),
      );
      return;
    }
    if (this.slots.length + this.routes.size >= 64) {
      this.run(this.client.sendText(this.chatId, message.message_id, "Too many pending messages. Try again later."));
      return;
    }
    if (message.media_group_id) {
      const key = message.media_group_id;
      let slot = this.albums.get(key);
      if (!slot) {
        slot = { messages: [] };
        this.slots.push(slot);
        this.albums.set(key, slot);
      }
      if (slot.messages.length >= 10) return;
      slot.messages.push(message);
      if (slot.timer) clearTimeout(slot.timer);
      const captured = slot;
      slot.timer = setTimeout(() => {
        this.albums.delete(key);
        this.prepare(captured);
      }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
    } else {
      const slot = { messages: [message] };
      this.slots.push(slot);
      this.prepare(slot);
    }
  }
  private cancelPending(): boolean {
    const pending = this.slots.length > 0;
    this.preparation.abort();
    this.preparation = new AbortController();
    for (const slot of this.slots) {
      slot.cancelled = true;
      if (slot.timer) clearTimeout(slot.timer);
    }
    this.slots.length = 0;
    this.albums.clear();
    return pending;
  }
  private prepare(slot: Slot): void {
    const signal = AbortSignal.any([this.controller.signal, this.preparation.signal]);
    this.run(
      createTelegramTurn(this.client, slot.messages, signal)
        .then((turn) => {
          if (this.current() && !signal.aborted && !slot.cancelled) slot.turn = turn;
        })
        .catch((error) => {
          if (signal.aborted || slot.cancelled) return;
          slot.cancelled = true;
          if (this.current()) {
            this.report(error);
            this.run(
              this.client.sendText(
                this.chatId,
                slot.messages[0]?.message_id ?? 0,
                "Could not prepare this message for the agent.",
              ),
            );
          }
        })
        .finally(() => this.drain()),
    );
  }
  private drain(): void {
    if (!this.current()) return;
    while (this.slots.length) {
      const slot = this.slots[0];
      if (!slot) return;
      if (slot.cancelled) {
        this.slots.shift();
        continue;
      }
      if (!slot.turn) return;
      this.slots.shift();
      const id = randomUUID();
      this.routes.set(id, { chatId: slot.turn.chatId, replyToMessageId: slot.turn.replyToMessageId });
      this.agent.prompt({ id, content: slot.turn.content });
    }
  }
  output(event: AgentOutput): void {
    if (!this.current()) return;
    if (event.type === "delivery-error") {
      const route = this.routes.get(event.turnId);
      this.routes.delete(event.turnId);
      if (route)
        this.run(
          this.client.sendText(
            route.chatId,
            route.replyToMessageId,
            `Could not deliver this message to the agent: ${event.error}`,
          ),
        );
      return;
    }
    if (event.type === "turn-start") {
      const route = this.routes.get(event.turnId);
      if (!route) throw new Error("Unknown bot turn");
      this.routes.delete(event.turnId);
      this.active = route;
      this.assistantError = undefined;
      this.startTyping();
      return;
    }
    if (event.type === "settled") {
      const route = this.active;
      const error = event.error ?? this.assistantError;
      this.active = undefined;
      this.assistantError = undefined;
      this.stopTyping();
      this.run(
        this.preview.waitForIdle().then(() => {
          if (route && error && this.current())
            return this.client.sendText(route.chatId, route.replyToMessageId, error);
        }),
      );
      return;
    }
    if (!this.active) return;
    switch (event.type) {
      case "text-start":
        this.assistantError = undefined;
        this.preview.start(this.active.replyToMessageId);
        break;
      case "text-update":
        this.preview.update(event.text);
        this.preview.schedule(this.active.chatId, (error) => this.report(error));
        break;
      case "text-end":
        this.assistantError = event.error;
        this.preview.update(event.text);
        this.run(this.preview.finalize(this.active.chatId));
        break;
    }
  }
  private startTyping(): void {
    if (this.typing) return;
    const send = () => {
      void this.client.call("sendChatAction", { chat_id: this.chatId, action: "typing" }).catch(() => {});
    };
    send();
    this.typing = setInterval(send, 4000);
  }
  private stopTyping(): void {
    if (this.typing) clearInterval(this.typing);
    this.typing = undefined;
  }
  async sendAttachment(body: { path: string; fileName: string }, signal: AbortSignal): Promise<void> {
    // Capture before any asynchronous I/O; later input must not retarget this upload.
    await this.client.sendAttachment(this.chatId, body, signal, { replyToMessageId: this.active?.replyToMessageId });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    this.stopTyping();
    for (const slot of this.slots) if (slot.timer) clearTimeout(slot.timer);
    this.slots.length = 0;
    this.albums.clear();
    this.routes.clear();
    this.menus.clear();
    this.pickers.clear();
    await this.preview.stop();
    await Promise.allSettled(this.jobs);
  }
}
