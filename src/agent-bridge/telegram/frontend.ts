import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as v from "valibot";
import type { Config } from "../config.ts";
import { type Command, Control, parseCommand } from "../control.ts";
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
import { Router } from "../router.ts";
import type { BridgeServer } from "../server.ts";
import type { Store } from "../store.ts";
import type { TelegramAPI } from "./api.ts";
import type { TelegramClient } from "./client.ts";
import { isControlMessage, messageCommand } from "./commands.ts";
import { TelegramAttachmentError, TelegramDeliveryUnknown, TelegramError } from "./errors.ts";
import { collectTelegramFileInfos } from "./media.ts";
import { type BotIdentity, type TelegramMessage, TelegramMessageSchema, type TelegramUpdate } from "./schemas.ts";
import { TelegramSession } from "./session.ts";

export interface NormalizedTelegram {
  message: IncomingMessage;
  command: Command | null;
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
    container: {
      platform: "telegram",
      spaceId: String(raw.chat.id),
      channelId,
    },
    authorId: String(raw.from.id),
    text: prompt.trim(),
    route: startsTask
      ? { kind: "start", rootId: String(raw.message_id), ...(parentId ? { parentId } : {}) }
      : parentId
        ? { kind: "reply", parentId }
        : { kind: "ignore" },
  });
  let command: Command | null = null;
  const token = text.trim().split(/\s+/, 1)[0] ?? "";
  if (token.startsWith("/")) {
    const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?$/i.exec(token);
    if (match?.[1]) {
      if (match[2] && match[2].toLowerCase() !== bot.username.toLowerCase()) return null;
      command = parseCommand(match[1].toLowerCase(), text.trim().slice(token.length).trim());
    }
  }
  return { message, command };
}

export class TelegramFrontend implements BridgeFrontend {
  private server?: BridgeServer;
  private closed = false;
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly starts = new Map<TaskId, { token: string; cancelled: boolean }>();
  private readonly albums = new Map<string, { taskId: TaskId; authorId: string; expiresAt: number }>();
  readonly identity: { id: string; label: string };
  readonly mode: "setup" | "routing";
  readonly router: Router;
  readonly control: Control;
  readonly transportId: string;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly api: TelegramAPI,
    readonly bot: BotIdentity,
    readonly client: TelegramClient,
    private readonly backend: SessionBackend,
  ) {
    this.identity = { id: `telegram:${bot.id}`, label: `@${bot.username}` };
    this.mode = config.ownerTelegramUserIds.length ? "routing" : "setup";
    this.router = new Router(store);
    this.control = new Control(store);
    this.transportId = `telegram:${bot.id}`;
  }

  connect(server: BridgeServer): void {
    this.server = server;
  }
  statistics() {
    return this.store.statistics(this.transportId);
  }
  error(error: unknown): { message: string; unknownOutcome?: boolean } | undefined {
    if (error instanceof TelegramDeliveryUnknown) return { message: error.message, unknownOutcome: true };
    if (error instanceof TelegramError || error instanceof TelegramAttachmentError) return { message: error.message };
    return undefined;
  }
  authorize(request: AttachmentRequest): AttachmentIdentity & { routeId: string } {
    const ownerId =
      request.userId ??
      (this.config.ownerTelegramUserIds.length === 1 ? this.config.ownerTelegramUserIds[0] : undefined);
    if (!ownerId || !this.config.ownerTelegramUserIds.includes(ownerId))
      throw new Error("Choose a configured owner with /bot-connect [task_<id>] <owner ID>.");
    const routeId = request.routeId ?? `dm:${ownerId}`;
    if (routeId !== `dm:${ownerId}`) {
      if (!routeId.startsWith("task_")) throw new Error("Unknown attachment route.");
      const taskId = v.parse(TaskIdSchema, routeId);
      if (request.attachmentToken !== undefined) {
        const start = this.starts.get(taskId);
        if (!start || start.cancelled || start.token !== request.attachmentToken)
          throw new Error("This managed session startup was cancelled.");
      }
      const task = this.store.task(taskId);
      if (task?.container.platform !== "telegram") throw new Error("Unknown Telegram task.");
      if (Number(task.container.spaceId) > 0 && ownerId !== task.container.spaceId)
        throw new Error("This private conversation belongs to another owner.");
      const project = this.store.project(task.projectId);
      if (this.store.binding(task.container) !== task.projectId || !project)
        throw new Error("This thread's project is no longer bound.");
      if (!request.cwd || realpathSync(request.cwd) !== realpathSync(project.directory))
        throw new Error("Pi cwd must match the thread's bound project directory.");
      const attached = this.store.taskAttachment(taskId);
      if (attached && (attached.ownerId !== ownerId || attached.sessionId !== request.sessionId))
        throw new Error("Thread is bound to another Pi session or owner. Its attachment owner must /release it first.");
    } else if (this.store.attachmentForSession(request.sessionId)) {
      throw new Error(
        "This Pi session is assigned to a group thread. Release that association before attaching its DM.",
      );
    }
    return { userId: ownerId, routeId, frontend: this.identity };
  }
  bind(request: AttachmentRequest, identity: AttachmentIdentity): void {
    if (request.attachmentToken !== undefined) this.authorize(request);
    if (identity.routeId?.startsWith("task_"))
      this.store.attachTask({
        taskId: v.parse(TaskIdSchema, identity.routeId),
        sessionId: request.sessionId,
        ownerId: identity.userId,
      });
  }
  open(identity: AttachmentIdentity, agent: AgentPort): TelegramSession {
    const report = (error: unknown) =>
      log({
        level: "error",
        event: "telegram.session_error",
        details: { message: error instanceof Error ? error.message : "Session operation failed" },
      });
    if (!identity.routeId?.startsWith("task_"))
      return new TelegramSession(Number(identity.userId), agent, this.client, report, undefined, this.bot.username);
    const taskId = v.parse(TaskIdSchema, identity.routeId);
    const task = this.store.task(taskId);
    const association = this.store.taskAttachment(taskId);
    const project = task ? this.store.project(task.projectId) : null;
    if (!task || !association || !project) throw new Error("Missing task association");
    const directory = realpathSync(project.directory);
    const current = () => {
      const binding = this.store.taskAttachment(taskId);
      try {
        return (
          this.store.binding(task.container) === task.projectId &&
          binding?.sessionId === association.sessionId &&
          binding.ownerId === association.ownerId &&
          realpathSync(project.directory) === directory
        );
      } catch {
        return false;
      }
    };
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
    );
  }
  private releaseTask(taskId: TaskId, ownerId: string): string {
    const association = this.store.taskAttachment(taskId);
    if (!this.config.ownerTelegramUserIds.includes(ownerId) || (association && association.ownerId !== ownerId))
      return "Only the attachment owner can release this thread.";
    this.cancelSession(taskId);
    this.store.detachTask(taskId);
    return `Released ${taskId}. Attach deliberately with /bot-connect ${taskId} [owner ID]. Earlier inputs will not be replayed.`;
  }
  private cancelSession(taskId: TaskId): void {
    const start = this.starts.get(taskId);
    if (start) start.cancelled = true;
    this.starts.delete(taskId);
    this.server?.detachRoute(taskId);
    void this.backend.closeRoute(taskId).catch(() => {});
  }
  private async deliverPrivate(update: TelegramUpdate): Promise<boolean> {
    const message = update.message ?? update.edited_message;
    const callback = update.callback_query;
    const chat = callback?.message?.chat ?? message?.chat;
    const from = callback?.from ?? message?.from;
    if (chat?.type !== "private" || !from || from.is_bot || chat.id !== from.id) return false;
    const addressed = /^\/[a-z0-9_]+@([a-z0-9_]+)(?:\s|$)/i.exec((message?.text ?? message?.caption ?? "").trim());
    if (addressed?.[1] && addressed[1].toLowerCase() !== this.bot.username.toLowerCase()) return true;
    const command = message ? messageCommand(message) : "";
    if (this.config.ownerTelegramUserIds.includes(String(from.id)) && ["/bind", "/unbind", "/where"].includes(command))
      return false;
    const peer = this.server?.attachment(`dm:${from.id}`);
    const frontend = peer?.frontend;
    const container = { platform: "telegram" as const, spaceId: String(from.id), channelId: "general" };
    if (!(frontend instanceof TelegramSession) && this.config.ownerTelegramUserIds.includes(String(from.id))) {
      if (this.store.binding(container) || ["/bind", "/unbind", "/where", "/help", "/start", "/new"].includes(command))
        return false;
    }
    if (frontend instanceof TelegramSession) frontend.receive(update);
    else if (callback)
      await this.client.answerCallbackQuery(callback.id, "No agent session attached. Run /bot-connect in Pi.");
    else if (update.message && this.config.ownerTelegramUserIds.includes(String(from.id))) {
      const status = this.server?.inspect();
      const text =
        /^\/status(?:@\w+)?(?:\s|$)/i.test(message?.text?.trim() ?? "") && status
          ? `Bot: ${this.identity.label}\nDaemon: ${status.mode}, up ${status.uptimeSeconds}s\nTopics: ${status.statistics.topics}; tasks: ${status.statistics.tasks}\nPending replies: ${status.statistics.pendingReplies}; failed: ${status.statistics.failedReplies}\nNo agent session attached. Use /bind <directory> to start saved Pi conversations.`
          : "No project is bound. Use /bind <directory> to start saved Pi conversations here.";
      await this.client.sendText(chat.id, message?.message_id ?? 0, text);
    } else if (update.message && !this.config.ownerTelegramUserIds.length)
      await this.client.sendText(
        chat.id,
        message?.message_id ?? 0,
        `Your user ID: ${from.id}. Configure AGENT_BRIDGE_OWNER_IDS, then restart the daemon.`,
      );
    return true;
  }
  private startSession(task: Task, update: TelegramUpdate, empty = false): void {
    const start = this.starts.get(task.id) ?? { token: randomUUID(), cancelled: false };
    this.starts.set(task.id, start);
    const job = (async () => {
      const project = this.store.project(task.projectId);
      if (!project) throw new Error("The conversation's project is unavailable.");
      const association = this.store.taskAttachment(task.id);
      const authorId = this.store.taskAuthor(task.id);
      const ownerId =
        association?.ownerId ??
        (authorId && this.config.ownerTelegramUserIds.includes(authorId)
          ? authorId
          : this.config.ownerTelegramUserIds[0]);
      if (!ownerId) throw new Error("No bot owner is configured.");
      const saved = await this.backend.open({
        routeId: task.id,
        cwd: project.directory,
        ownerId,
        name: task.title || "Telegram conversation",
        sessionId: association?.sessionId,
        sessionFile: association?.sessionFile,
        attachmentToken: start.token,
      });
      if (
        this.closed ||
        start.cancelled ||
        this.starts.get(task.id) !== start ||
        this.store.binding(task.container) !== task.projectId
      )
        return;
      this.store.attachTask({ taskId: task.id, ownerId, ...saved });
      const frontend = this.server?.attachment(task.id)?.frontend;
      if (!(frontend instanceof TelegramSession) || !frontend.isLive)
        throw new Error("The session disconnected before input was delivered.");
      if (empty)
        this.store.enqueue({
          transportId: this.transportId,
          container: task.container,
          replyToId: v.parse(MessageIdSchema, String(update.message?.message_id)),
          taskId: task.id,
          text: "New conversation ready. Reply with your request.",
        });
      else frontend.receive(update);
    })().catch((error) => {
      if (
        this.closed ||
        start.cancelled ||
        this.starts.get(task.id) !== start ||
        this.store.binding(task.container) !== task.projectId
      )
        return;
      this.store.enqueue({
        transportId: this.transportId,
        container: task.container,
        replyToId: v.parse(MessageIdSchema, String(update.message?.message_id)),
        taskId: task.id,
        text: `Could not start this conversation: ${error instanceof Error ? error.message.slice(-1000) : "session startup failed"}. Use /new to start a separate conversation.`,
      });
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
  }
  async close(): Promise<void> {
    this.closed = true;
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
  async accept(update: TelegramUpdate): Promise<RouteResult | null> {
    if (this.closed) return null;
    if (
      this.store.processed({
        transportId: this.transportId,
        updateId: update.update_id,
      })
    )
      return null;
    if (await this.deliverPrivate(update)) {
      this.store.advance({ transportId: this.transportId, nextOffset: update.update_id + 1 });
      return null;
    }
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
      else await this.client.answerCallbackQuery(callback.id, "This menu is detached or expired.");
      this.store.advance({ transportId: this.transportId, nextOffset: update.update_id + 1 });
      return null;
    }
    // Edited group updates never silently resubmit a previously executed input.
    const raw = update.message;
    const normalized = raw
      ? normalizeTelegram(
          raw,
          this.bot,
          raw.chat.type === "private" &&
            raw.chat.id === raw.from?.id &&
            this.config.ownerTelegramUserIds.includes(String(raw.from.id)),
        )
      : null;
    if (normalized && raw?.chat.type === "private" && normalized.message.route.kind === "ignore") {
      const projectId = this.store.binding(normalized.message.container);
      const latest = this.store.tasksFor(normalized.message.container).find((task) => task.projectId === projectId);
      normalized.message.route = latest
        ? { kind: "thread", threadId: latest.rootId }
        : { kind: "start", rootId: normalized.message.id };
    }
    let deliver: { frontend: TelegramSession; update: TelegramUpdate } | undefined;
    let start: { task: Task; update: TelegramUpdate; empty: boolean } | undefined;
    const accepted = this.store.atomic(() => {
      let result: RouteResult | null = null;
      if (normalized) {
        const { message, command } = normalized;
        let reply: string | null = null;
        let taskId: TaskId | null = null;
        const fresh = command?.kind === "new";
        if (fresh) {
          message.route = { kind: "start", rootId: message.id };
          message.text = command.request;
        }
        if (command?.kind === "release") {
          const parentId =
            message.route.kind === "reply" || message.route.kind === "start" ? message.route.parentId : undefined;
          const task = parentId
            ? this.store.taskForMessage({ container: message.container, messageId: parentId })
            : null;
          reply = task ? this.releaseTask(task.id, message.authorId) : "Reply to a tracked thread to release it.";
          taskId = task?.id ?? null;
        } else if (command && command.kind !== "new") {
          const owner = this.config.ownerTelegramUserIds.includes(message.authorId);
          const before = this.store.binding(message.container);
          reply = this.control.execute({ container: message.container, owner, command });
          const rebound = command.kind === "bind" && before !== this.store.binding(message.container);
          if (owner && (command.kind === "unbind" || rebound)) {
            for (const task of this.store.tasksFor(message.container)) this.cancelSession(task.id);
          }
          if (
            owner &&
            raw?.chat.type === "private" &&
            (command.kind === "unbind" || (command.kind === "bind" && reply.startsWith("Bound to ")))
          )
            this.server?.detachRoute(`dm:${message.authorId}`);
          if (command.kind === "where") reply += `\nYour user ID: ${message.authorId}`;
        } else if (this.config.ownerTelegramUserIds.length) {
          const parent = update.message?.reply_to_message;
          if (
            (message.route.kind === "reply" || message.route.kind === "start") &&
            message.route.parentId &&
            parent?.from?.id === this.bot.id &&
            parent.text
          ) {
            this.store.recoverBotReply({
              transportId: this.transportId,
              container: message.container,
              messageId: message.route.parentId,
              text: parent.text,
            });
          }
          // Commands are scoped deliberately before ordinary prompt routing.
          const control = raw && isControlMessage(raw) && !fresh;
          if (control) {
            const parentId =
              message.route.kind === "reply" || message.route.kind === "start" ? message.route.parentId : undefined;
            const parentTask = parentId
              ? this.store.taskForMessage({ container: message.container, messageId: parentId })
              : message.route.kind === "thread"
                ? this.store.taskForRoot({ container: message.container, rootId: message.route.threadId })
                : null;
            if (!parentTask) {
              if (messageCommand(raw) === "/status") {
                const projectId = this.store.binding(message.container);
                const project = projectId ? this.store.project(projectId) : null;
                const active = (this.server?.inspect().sessions ?? []).filter((peer) => {
                  const task = peer.routeId?.startsWith("task_")
                    ? this.store.task(v.parse(TaskIdSchema, peer.routeId))
                    : null;
                  return task && containerKey(task.container) === containerKey(message.container);
                });
                reply = `Project: ${project?.directory ?? "unbound"}\nBackend: native Pi SDK\nActive sessions: ${active.length}`;
              } else {
                const active = this.store
                  .tasksFor(message.container)
                  .filter(
                    (task) =>
                      task.projectId === this.store.binding(message.container) && this.server?.attachment(task.id),
                  );
                if (active.length === 1 && active[0]) message.route = { kind: "thread", threadId: active[0].rootId };
                else
                  reply = this.store.binding(message.container)
                    ? `Reply to the conversation you want to control with ${messageCommand(raw)}.`
                    : "No project is bound. Use /bind <directory> first.";
              }
            }
          }
          if (reply !== null) {
            this.store.enqueue({
              transportId: this.transportId,
              container: message.container,
              replyToId: message.id,
              taskId: null,
              text: reply,
            });
            this.store.advance({ transportId: this.transportId, nextOffset: update.update_id + 1 });
            return null;
          }
          const albumKey = raw?.media_group_id ? `${containerKey(message.container)}:${raw.media_group_id}` : undefined;
          const now = Date.now();
          for (const [key, album] of this.albums) if (album.expiresAt <= now) this.albums.delete(key);
          const album = albumKey ? this.albums.get(albumKey) : undefined;
          const parentId =
            message.route.kind === "reply" || message.route.kind === "start" ? message.route.parentId : undefined;
          const mappedParent = parentId
            ? this.store.taskForMessage({ container: message.container, messageId: parentId })
            : null;
          const albumTask = album && album.authorId === message.authorId ? this.store.task(album.taskId) : null;
          if (!mappedParent && albumTask && containerKey(albumTask.container) === containerKey(message.container))
            message.route = { kind: "thread", threadId: albumTask.rootId };
          result =
            album && (album.authorId !== message.authorId || (mappedParent && mappedParent.id !== album.taskId))
              ? { kind: "ignored", reason: "chatter" }
              : this.router.route(message);
          if (result.kind === "routed") {
            if (albumKey && (!album || album.authorId === message.authorId)) {
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
            taskId = result.task.id;
            const frontend = this.server?.attachment(result.task.id)?.frontend;
            if (frontend instanceof TelegramSession && frontend.isLive && raw) {
              deliver = {
                frontend,
                update: {
                  ...update,
                  message: { ...raw, ...(raw.text === undefined ? { caption: message.text } : { text: message.text }) },
                },
              };
            } else if (raw) {
              start = {
                task: result.task,
                empty: fresh && !message.text && !collectTelegramFileInfos([raw]).length,
                update: {
                  ...update,
                  message: { ...raw, ...(raw.text === undefined ? { caption: message.text } : { text: message.text }) },
                },
              };
            }
          } else if (result.kind === "ignored" && message.route.kind !== "ignore") {
            reply =
              result.reason === "unbound"
                ? "No project is bound. Use /bind <directory> first."
                : "This reply is not linked to an active project conversation. Reply to its original request or use /new.";
          } else if (raw && /^\/[a-z0-9_]+(?:@[a-z0-9_]+)?(?:\s|$)/i.test(raw.text ?? "")) {
            reply = "Unknown command. Use /help to see available commands.";
          }
        }
        if (reply !== null)
          this.store.enqueue({
            transportId: this.transportId,
            container: message.container,
            replyToId: message.id,
            taskId,
            text: reply,
          });
      }
      this.store.advance({
        transportId: this.transportId,
        nextOffset: update.update_id + 1,
      });
      return result;
    });
    if (deliver) deliver.frontend.receive(deliver.update);
    if (start) this.startSession(start.task, start.update, start.empty);
    return accepted;
  }

  async flushOne(signal?: AbortSignal): Promise<boolean> {
    const reply = this.store.nextReply(this.transportId);
    if (!reply) return false;
    try {
      const sent = await this.api.call({
        method: "sendMessage",
        schema: TelegramMessageSchema,
        signal,
        body: {
          chat_id: reply.container.spaceId,
          ...(reply.container.channelId === "general" ? {} : { message_thread_id: Number(reply.container.channelId) }),
          text: reply.text,
          reply_parameters: {
            message_id: Number(reply.replyToId),
            allow_sending_without_reply: false,
          },
        },
      });
      this.store.sent({
        reply,
        messageId: v.parse(MessageIdSchema, String(sent.message_id)),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const permanent =
        error instanceof TelegramDeliveryUnknown || (error instanceof TelegramError && [400, 403].includes(error.code));
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
    }
    return true;
  }
}
