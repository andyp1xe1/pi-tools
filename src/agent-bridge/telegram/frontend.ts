import { realpathSync } from "node:fs";
import * as v from "valibot";
import { BotCommandService } from "../../bot/command-service.ts";
import { type Command, parseCommand } from "../../bot/commands.ts";
import { BotRuntime } from "../../bot/runtime.ts";
import { ThreadOperationError, ThreadOperations } from "../../bot/thread-operations.ts";
import type { Config } from "../config.ts";
import {
  containerKey,
  type IncomingMessage,
  IncomingMessageSchema,
  MessageIdSchema,
  type RouteResult,
  type Task,
  type TaskId,
  TaskIdSchema,
} from "../domain.ts";
import type { AgentPort, AttachmentIdentity, AttachmentRequest, BridgeFrontend, SessionBackend } from "../frontend.ts";
import { log } from "../log.ts";
import { type Notification, NotificationSchema, type Operation } from "../protocol.ts";
import type { BridgeServer } from "../server.ts";
import type { Store } from "../store.ts";
import type { TelegramAPI } from "./api.ts";
import type { TelegramClient } from "./client.ts";
import { TelegramAttachmentError, TelegramDeliveryUnknown, TelegramError } from "./errors.ts";
import { collectTelegramFileInfos } from "./media.ts";
import { type BotIdentity, type TelegramMessage, TelegramMessageSchema, type TelegramUpdate } from "./schemas.ts";
import { TelegramSession } from "./session.ts";
import { TelegramThreadTransport } from "./thread-transport.ts";

export interface NormalizedTelegram {
  message: IncomingMessage;
  command: Command | null;
}
function commandToken(text: string): { name: string; argument: string } | null {
  const match = /^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match?.[1]
    ? { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" }
    : text.trim().toLowerCase() === "stop"
      ? { name: "stop", argument: "" }
      : null;
}
export function normalizeTelegram(
  raw: TelegramMessage,
  bot: BotIdentity,
  privateChat = false,
): NormalizedTelegram | null {
  if (
    (raw.chat.type !== "supergroup" && raw.chat.type !== "group" && !(privateChat && raw.chat.type === "private")) ||
    !raw.from ||
    raw.from.is_bot ||
    raw.sender_chat ||
    raw.forum_topic_created
  )
    return null;
  const text = raw.text ?? raw.caption ?? "";
  if (
    !text.trim() &&
    !raw.photo?.length &&
    !raw.document &&
    !raw.video &&
    !raw.audio &&
    !raw.voice &&
    !raw.animation &&
    !raw.sticker
  )
    return null;
  const addressed = /^\/[a-z0-9_]+@([a-z0-9_]+)(?:\s|$)/i.exec(text.trim());
  if (addressed?.[1] && addressed[1].toLowerCase() !== bot.username.toLowerCase()) return null;
  const entities = raw.text === undefined ? (raw.caption_entities ?? []) : (raw.entities ?? []);
  const channelId =
    raw.is_topic_message && raw.message_thread_id && raw.message_thread_id !== 1
      ? String(raw.message_thread_id)
      : "general";
  let startsTask = false;
  const ranges: Array<[number, number]> = [];
  for (const entity of entities) {
    const token = text.slice(entity.offset, entity.offset + entity.length);
    if (
      (entity.type === "mention" && token.toLowerCase() === `@${bot.username.toLowerCase()}`) ||
      (entity.type === "text_mention" && entity.user?.id === bot.id)
    ) {
      startsTask = true;
      ranges.push([entity.offset, entity.offset + entity.length]);
    }
  }
  let prompt = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) prompt = prompt.slice(0, start) + prompt.slice(end);
  const parent = raw.reply_to_message;
  const parentId =
    parent &&
    parent.chat.id === raw.chat.id &&
    (!parent.message_thread_id ||
      String(parent.message_thread_id) === channelId ||
      (channelId === "general" && parent.message_thread_id === 1)) &&
    !parent.forum_topic_created &&
    !(channelId !== "general" && String(parent.message_id) === channelId)
      ? String(parent.message_id)
      : null;
  const message = v.parse(IncomingMessageSchema, {
    id: String(raw.message_id),
    container: { platform: "telegram", spaceId: String(raw.chat.id), channelId },
    authorId: String(raw.from.id),
    text: prompt.trim(),
    route: startsTask
      ? { kind: "start", rootId: String(raw.message_id), ...(parentId ? { parentId } : {}) }
      : parentId
        ? { kind: "reply", parentId }
        : { kind: "ignore" },
  });
  const token = commandToken(text);
  return { message, command: token ? parseCommand(token.name, token.argument) : null };
}

/** Telegram wire/media/UI adapter; the bot service owns saved threads and command admission. */
export class TelegramFrontend implements BridgeFrontend {
  private server?: BridgeServer;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly albums = new Map<string, { taskId: TaskId; authorId: string; expiresAt: number }>();
  readonly identity: { id: string; label: string };
  readonly mode: "setup" | "routing";
  readonly transportId: string;
  readonly runtime: BotRuntime;
  readonly commands: BotCommandService;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly api: TelegramAPI,
    readonly bot: BotIdentity,
    readonly client: TelegramClient,
    backend: SessionBackend,
  ) {
    this.identity = { id: `telegram:${bot.id}`, label: `@${bot.username}` };
    this.mode = config.ownerTelegramUserIds.length ? "routing" : "setup";
    this.transportId = `telegram:${bot.id}`;
    this.runtime = new BotRuntime({
      store,
      backend,
      ownerIds: config.ownerTelegramUserIds,
      identity: this.identity,
      platform: "telegram",
      transport: new TelegramThreadTransport(client, store),
      session: (frontend): frontend is TelegramSession => frontend instanceof TelegramSession,
    });
    this.commands = new BotCommandService(this.runtime);
  }
  connect(server: BridgeServer): void {
    this.server = server;
    this.runtime.connect(server);
  }
  statistics() {
    return this.store.statistics(this.transportId);
  }
  error(error: unknown): { message: string; unknownOutcome?: boolean } | undefined {
    if (error instanceof ThreadOperationError) return { message: error.message, unknownOutcome: error.unknownOutcome };
    if (error instanceof TelegramDeliveryUnknown) return { message: error.message, unknownOutcome: true };
    if (error instanceof TelegramError || error instanceof TelegramAttachmentError) return { message: error.message };
    return undefined;
  }
  threadOperation(
    identity: AttachmentIdentity,
    operation: Operation,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return new ThreadOperations(this.runtime).threadOperation(identity, operation, body, signal);
  }
  async notify(notification: Notification): Promise<void> {
    const { userId, text } = v.parse(NotificationSchema, notification);
    if (this.closed) throw new Error("Telegram frontend is closed.");
    if (!this.config.ownerTelegramUserIds.includes(userId))
      throw new Error("Notifications may only be sent to a configured owner.");
    await this.runtime.track(
      this.api.call({
        method: "sendMessage",
        schema: TelegramMessageSchema,
        signal: this.lifetime.signal,
        body: { chat_id: userId, text },
      }),
    );
    log({ level: "info", event: "bridge.notification_sent", details: { userId } });
  }
  authorize(request: AttachmentRequest): AttachmentIdentity & { routeId: string } {
    return this.runtime.authorize(request);
  }
  bind(request: AttachmentRequest, identity: AttachmentIdentity): void {
    this.runtime.bind(request, identity);
  }
  disconnected(identity: AttachmentIdentity, quiesced: boolean): void {
    this.runtime.disconnected(identity, quiesced);
  }
  open(identity: AttachmentIdentity, agent: AgentPort): TelegramSession {
    const report = (error: unknown) =>
      log({
        level: "error",
        event: "telegram.session_error",
        details: { message: error instanceof Error ? error.message : "Session operation failed" },
      });
    const taskId = v.parse(TaskIdSchema, identity.routeId);
    const task = this.store.task(taskId);
    const association = this.store.taskAttachment(taskId);
    const project = task ? this.store.project(task.projectId) : null;
    if (!task || !association || !project) throw new Error("Missing saved thread association");
    const directory = realpathSync(project.directory);
    const current = () => {
      const saved = this.store.taskAttachment(taskId);
      try {
        return (
          this.store.binding(task.container) === task.projectId &&
          saved?.sessionId === association.sessionId &&
          saved.ownerId === association.ownerId &&
          realpathSync(project.directory) === directory
        );
      } catch {
        return false;
      }
    };
    this.runtime.track(
      Promise.resolve()
        .then(() => {
          if (!agent.current() || !current()) return;
          return this.runtime.publishTerminalAnchor(identity, this.lifetime.signal);
        })
        .catch(report),
    );
    return new TelegramSession(
      Number(identity.userId),
      agent,
      this.client,
      report,
      {
        chatId: Number(task.container.spaceId),
        ...(task.container.channelId === "general" ? {} : { threadId: Number(task.container.channelId) }),
        current,
        sent: (id) => {
          if (current())
            this.store.mapMessage({
              container: task.container,
              messageId: v.parse(MessageIdSchema, String(id)),
              taskId,
            });
        },
      },
      this.bot.username,
      { id: taskId, explicit: true },
    );
  }
  private enqueueReply(message: IncomingMessage, text: string, taskId: TaskId | null = null): void {
    this.store.enqueue({
      transportId: this.transportId,
      container: message.container,
      replyToId: message.id,
      taskId,
      text,
    });
  }
  private startSession(task: Task, update: TelegramUpdate, empty = false): void {
    const job = this.runtime
      .enqueueInput(task, (session) => {
        if (empty)
          this.store.enqueue({
            transportId: this.transportId,
            container: task.container,
            replyToId: v.parse(MessageIdSchema, String(update.message?.message_id)),
            taskId: task.id,
            text: "New thread ready. Reply with your request.",
          });
        else (session as TelegramSession).receive(update);
      })
      .catch((error) => {
        if (
          this.closed ||
          this.runtime.closingThreads.has(task.id) ||
          this.store.binding(task.container) !== task.projectId ||
          (error instanceof Error && error.message === "This conversation startup was cancelled.")
        )
          return;
        this.store.enqueue({
          transportId: this.transportId,
          container: task.container,
          replyToId: v.parse(MessageIdSchema, String(update.message?.message_id)),
          taskId: task.id,
          text: `Could not start this thread: ${error instanceof Error ? error.message.slice(-1000) : "session startup failed"}.`,
        });
      });
    this.runtime.track(job);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await this.runtime.close();
  }
  async accept(update: TelegramUpdate): Promise<RouteResult | null> {
    if (this.closed || this.store.processed({ transportId: this.transportId, updateId: update.update_id })) return null;
    const callback = update.callback_query;
    if (callback?.message) {
      const message = callback.message;
      const channelId =
        message.is_topic_message && message.message_thread_id && message.message_thread_id !== 1
          ? String(message.message_thread_id)
          : "general";
      const task = this.store.taskForMessage({
        container: { platform: "telegram", spaceId: String(message.chat.id), channelId },
        messageId: v.parse(MessageIdSchema, String(message.message_id)),
      });
      const frontend = task ? this.server?.attachment(task.id)?.frontend : undefined;
      if (frontend instanceof TelegramSession && frontend.isLive) frontend.receive(update);
      else await this.client.answerCallbackQuery(callback.id, "This menu is stopped or expired.");
      this.store.advance({ transportId: this.transportId, nextOffset: update.update_id + 1 });
      return null;
    }
    // Edits are acknowledged, never resubmitted as new agent input.
    const raw = update.message;
    const normalized = raw
      ? normalizeTelegram(
          raw,
          this.bot,
          raw.chat.type === "private" &&
            raw.chat.id === raw.from?.id &&
            (!this.config.ownerTelegramUserIds.length ||
              this.config.ownerTelegramUserIds.includes(String(raw.from.id))),
        )
      : null;
    let delivery: { task: Task; update: TelegramUpdate; empty: boolean; control: boolean } | undefined;
    const accepted = this.store.atomic(() => {
      let result: RouteResult | null = null;
      if (normalized && raw) {
        const { message } = normalized;
        const token = commandToken(raw.text ?? raw.caption ?? "");
        this.store.rememberUser(
          message.container,
          message.authorId,
          raw.from?.username ? `@${raw.from.username}` : raw.from?.first_name || message.authorId,
        );
        const parentId =
          message.route.kind === "reply" || message.route.kind === "start" ? message.route.parentId : undefined;
        const parent = raw.reply_to_message;
        if (parentId && parent?.from?.id === this.bot.id && parent.text)
          this.store.recoverBotReply({
            transportId: this.transportId,
            container: message.container,
            messageId: parentId,
            text: parent.text,
          });
        const albumKey = raw.media_group_id ? `${containerKey(message.container)}:${raw.media_group_id}` : undefined;
        const now = Date.now();
        for (const [key, album] of this.albums) if (album.expiresAt <= now) this.albums.delete(key);
        const album = albumKey ? this.albums.get(albumKey) : undefined;
        const mappedParent = parentId
          ? this.store.taskForMessage({ container: message.container, messageId: parentId })
          : null;
        const albumTask = album && album.authorId === message.authorId ? this.store.task(album.taskId) : null;
        if (album && (album.authorId !== message.authorId || (mappedParent && mappedParent.id !== album.taskId)))
          result = { kind: "ignored", reason: "chatter" };
        else {
          if (!parentId && albumTask) message.route = { kind: "thread", threadId: albumTask.rootId };
          else if (!parentId && message.route.kind === "start") message.route = { kind: "default" };
          if (!this.config.ownerTelegramUserIds.length && !token)
            this.enqueueReply(
              message,
              `Your user ID: ${message.authorId}. Configure AGENT_BRIDGE_OWNER_IDS, then restart the daemon.`,
            );
          else {
            const dispatch = this.commands.dispatch(message, token);
            result = dispatch.result;
            if (dispatch.reply !== null) this.enqueueReply(message, dispatch.reply);
            if (result?.kind === "routed") {
              if (albumKey) {
                this.albums.set(albumKey, {
                  taskId: result.task.id,
                  authorId: message.authorId,
                  expiresAt: now + 10_000,
                });
                if (this.albums.size > 128) {
                  const oldest = this.albums.keys().next().value;
                  if (oldest !== undefined) this.albums.delete(oldest);
                }
              }
              delivery = {
                task: result.task,
                control: dispatch.control,
                empty: dispatch.empty && !collectTelegramFileInfos([raw]).length,
                update: {
                  ...update,
                  message: { ...raw, ...(raw.text === undefined ? { caption: message.text } : { text: message.text }) },
                },
              };
            }
          }
        }
      }
      this.store.advance({ transportId: this.transportId, nextOffset: update.update_id + 1 });
      return result;
    });
    if (delivery) {
      const live = this.server?.attachment(delivery.task.id)?.frontend;
      if (
        delivery.control &&
        live instanceof TelegramSession &&
        live.isLive &&
        !this.runtime.closingThreads.has(delivery.task.id)
      )
        live.receive(delivery.update);
      else this.startSession(delivery.task, delivery.update, delivery.empty);
    }
    return accepted;
  }
  async flushOne(signal?: AbortSignal): Promise<boolean> {
    const reply = this.store.nextReply(this.transportId);
    if (!reply) return false;
    this.store.beginSend(reply);
    let sent: TelegramMessage;
    try {
      sent = await this.api.call({
        method: "sendMessage",
        schema: TelegramMessageSchema,
        signal,
        body: {
          chat_id: reply.container.spaceId,
          ...(reply.container.channelId === "general" ? {} : { message_thread_id: Number(reply.container.channelId) }),
          text: reply.text,
          reply_parameters: { message_id: Number(reply.replyToId), allow_sending_without_reply: false },
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const permanent = !(error instanceof TelegramError) || [400, 403].includes(error.code);
      const retryMs =
        error instanceof TelegramError && error.retryAfter
          ? error.retryAfter * 1000
          : Math.min(60_000, 1000 * 2 ** Math.min(reply.attempts, 6));
      this.store.failed({
        reply,
        error: error instanceof Error ? error.message : "Send failed",
        retryAt: permanent ? null : Date.now() + retryMs,
      });
      if (error instanceof TelegramError && [401, 409].includes(error.code)) throw error;
      return true;
    }
    this.store.sent({ reply, messageId: v.parse(MessageIdSchema, String(sent.message_id)) });
    return true;
  }
}
