import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import * as v from "valibot";
import { containerKey, MessageIdSchema, type Task, type TaskId, TaskIdSchema, UserIdSchema } from "../domain.ts";
import { threadEnvelope } from "../envelope.ts";
import type { AttachmentIdentity, SessionBackend } from "../frontend.ts";
import { log } from "../log.ts";
import { type Operation, OperationBodies } from "../protocol.ts";
import type { BridgeServer } from "../server.ts";
import type { Store } from "../store.ts";
import type { TelegramClient } from "./client.ts";
import { chunkParagraphs } from "./messages.ts";
import { TelegramSession } from "./session.ts";

export class ThreadOperationError extends Error {}
export interface ThreadHost {
  store: Store;
  backend: SessionBackend;
  server?: BridgeServer;
  client: TelegramClient;
  starts: Map<TaskId, { pending?: Promise<TelegramSession> }>;
  closingThreads: Map<TaskId, Promise<void>>;
  jobs: Set<Promise<unknown>>;
  closed(): boolean;
  enqueueInput(task: Task, deliver: (frontend: TelegramSession) => void): Promise<void>;
  cancelSession(taskId: TaskId): Promise<void>;
}
/** Platform-scoped explicit conversation operations; no classifier or completion forwarding. */
export class TelegramThreadOperations {
  constructor(private readonly host: ThreadHost) {}
  private get store() {
    return this.host.store;
  }
  private get backend() {
    return this.host.backend;
  }
  private get server() {
    return this.host.server;
  }
  private get client() {
    return this.host.client;
  }
  private get starts() {
    return this.host.starts;
  }
  private get closingThreads() {
    return this.host.closingThreads;
  }
  private get jobs() {
    return this.host.jobs;
  }
  private get closed() {
    return this.host.closed();
  }
  private enqueueInput(task: Task, deliver: (frontend: TelegramSession) => void) {
    return this.host.enqueueInput(task, deliver);
  }
  private cancelSession(taskId: TaskId) {
    return this.host.cancelSession(taskId);
  }
  /** Tools address only conversations in the caller's currently bound project space. */
  async threadOperation(
    identity: AttachmentIdentity,
    operation: Operation,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      const source = identity.routeId?.startsWith("task_")
        ? this.store.task(v.parse(TaskIdSchema, identity.routeId))
        : null;
      if (!source || this.store.binding(source.container) !== source.projectId)
        throw new Error("Conversation tools require a bound task session.");
      const peer = this.server?.attachment(source.id);
      if (!peer || peer.identity.userId !== identity.userId) throw new Error("Conversation attachment changed.");
      const check = () => {
        signal.throwIfAborted();
        if (
          this.closed ||
          this.server?.attachment(source.id) !== peer ||
          this.store.binding(source.container) !== source.projectId
        )
          throw new Error("Conversation attachment changed.");
      };
      const destination = (id: string): Task => {
        const task = this.store.task(v.parse(TaskIdSchema, id));
        if (
          !task ||
          task.projectId !== source.projectId ||
          containerKey(task.container) !== containerKey(source.container)
        )
          throw new Error("Unknown thread in this project space.");
        return task;
      };
      const summary = (task: Task) => {
        const frontend = this.server?.attachment(task.id)?.frontend;
        const status = this.closingThreads.has(task.id)
          ? "stopped"
          : this.starts.get(task.id)?.pending
            ? "starting"
            : frontend instanceof TelegramSession && frontend.isLive
              ? frontend.isRunning
                ? "running"
                : "idle"
              : this.store.visibleWriter(task.id)
                ? "unconfirmed"
                : "stopped";
        return {
          id: task.id,
          title: task.title,
          ...this.store.threadSettings(task),
          status,
          ...(task.id === source.id ? { isCurrent: true } : {}),
        };
      };
      check();
      switch (operation) {
        case "listThreads": {
          const body = v.parse(OperationBodies.listThreads, input);
          const page = this.store.threadPage(
            source.container,
            source.projectId,
            body.limit ?? 50,
            body.before ? v.parse(TaskIdSchema, body.before) : undefined,
          );
          const result: ReturnType<typeof summary>[] = [];
          let bytes = 0;
          for (const task of page) {
            const item = summary(task);
            const size = Buffer.byteLength(JSON.stringify(item)) + 32;
            if (result.length && bytes + size > 32000) break;
            result.push(item);
            bytes += size;
          }
          return result;
        }
        case "peekThread": {
          const body = v.parse(OperationBodies.peekThread, input);
          const task = destination(body.threadId);
          const association = this.store.taskAttachment(task.id);
          let history: v.InferOutput<typeof import("../protocol.ts").PeekMessagesSchema> = { messages: [] };
          if (this.server?.attachment(task.id))
            history = await this.server.inspectAgent(task.id, "peek", { limit: body.limit, before: body.before });
          else if (this.backend.peek && association)
            history = await this.backend.peek(
              {
                routeId: task.id,
                cwd: this.store.threadSettings(task).cwd,
                ownerId: association.ownerId,
                name: task.title,
                sessionId: association.sessionId,
                sessionFile: association.sessionFile,
              },
              body.limit,
              body.before,
            );
          else if (association) throw new Error("The backend cannot inspect saved history.");
          check();
          return { ...summary(task), ...history };
        }
        case "createThread": {
          const body = v.parse(OperationBodies.createThread, input);
          const cwd = realpathSync(body.cwd);
          if (!statSync(cwd).isDirectory()) throw new Error("Thread cwd must be an existing directory.");
          const task: Task = {
            id: v.parse(TaskIdSchema, `task_${randomUUID()}`),
            projectId: source.projectId,
            container: source.container,
            rootId: v.parse(MessageIdSchema, `thread_${randomUUID()}`),
            title: body.title,
            createdAt: new Date().toISOString(),
          };
          this.store.atomic(() => {
            this.store.createTask(task);
            this.store.configureThread(task.id, cwd, source.id);
          });
          // Publish a small, durable reply anchor. Uncertain sends are never retried automatically.
          try {
            const sent = await this.client.call(
              "sendMessage",
              {
                chat_id: source.container.spaceId,
                ...(source.container.channelId === "general"
                  ? {}
                  : { message_thread_id: Number(source.container.channelId) }),
                text: body.title,
              },
              { signal },
            );
            check();
            this.store.setTaskRoot(task, v.parse(MessageIdSchema, String(sent.message_id)));
          } catch (error) {
            throw new Error(
              `Created ${task.id}, but its reply anchor could not be confirmed: ${error instanceof Error ? error.message : "send failed"}. Inspect it rather than creating a duplicate.`,
            );
          }
          check();
          this.queuePeerInput(source, task, body.text);
          return { threadId: task.id, accepted: true };
        }
        case "messageThread": {
          const body = v.parse(OperationBodies.messageThread, input);
          const task = destination(body.threadId);
          if (!this.server?.attachment(task.id) && this.store.visibleWriter(task.id))
            throw new Error(
              "The visible session writer has not confirmed handoff. Reattach it and disconnect cleanly, or /release to start a different saved session.",
            );
          if (task.id === source.id)
            throw new Error("Continue your own session directly rather than messaging yourself.");
          const messageId = this.queuePeerInput(source, task, body.text);
          return { messageId, accepted: true };
        }
        case "stopThread": {
          const body = v.parse(OperationBodies.stopThread, input);
          const task = destination(body.threadId);
          if (task.id === source.id) throw new Error("A thread cannot stop itself through its own tool call.");
          await this.cancelSession(task.id);
          check();
          return true;
        }
        case "replyMessage": {
          const body = v.parse(OperationBodies.replyMessage, input);
          if (!/^[1-9][0-9]*$/.test(body.messageId))
            throw new Error("Reply to a Telegram message ID from an input envelope or thread history.");
          const target = this.store.taskForMessage({
            container: source.container,
            messageId: v.parse(MessageIdSchema, body.messageId),
          });
          if (!target || target.projectId !== source.projectId)
            throw new Error("Reply target is not in this bound project space.");
          const mentions = [...new Set(body.mentions ?? [])];
          if (mentions.length > 20) throw new Error("At most 20 mentions may be sent.");
          const names = mentions.map((id) => {
            const name = this.store.userName(source.container, id);
            if (!/^[1-9][0-9]*$/.test(id) || !name)
              throw new Error("Mentions must identify users previously seen in this project space.");
            return name;
          });
          const prefix = names.length ? `${names.join(" ")}\n\n` : "";
          const label = target.id !== source.id ? `${source.title}\n\n` : "";
          const chunks = chunkParagraphs(`${prefix}${label}${body.text}`);
          const ids: string[] = [];
          for (const [index, text] of chunks.entries()) {
            check();
            let offset = 0;
            const entities =
              index === 0
                ? names.map((name, position) => {
                    const entity = {
                      type: "text_mention",
                      offset,
                      length: name.length,
                      user: { id: Number(mentions[position]), is_bot: false, first_name: name },
                    };
                    offset += name.length + 1;
                    return entity;
                  })
                : [];
            const sent = await this.client.call(
              "sendMessage",
              {
                chat_id: source.container.spaceId,
                ...(source.container.channelId === "general"
                  ? {}
                  : { message_thread_id: Number(source.container.channelId) }),
                text,
                ...(entities.length ? { entities } : {}),
                reply_parameters: { message_id: Number(body.messageId), allow_sending_without_reply: false },
              },
              { signal },
            );
            check();
            const id = v.parse(MessageIdSchema, String(sent.message_id));
            this.store.mapMessage({ container: source.container, messageId: id, taskId: source.id });
            ids.push(id);
          }
          return { messageIds: ids };
        }
        default:
          throw new Error("Unsupported conversation operation.");
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ThreadOperationError(
        error instanceof Error ? error.message.slice(-1500) : "Conversation operation failed.",
      );
    }
  }
  private queuePeerInput(source: Task, destination: Task, text: string): string {
    const messageId = `peer_${randomUUID()}`;
    const content = [{ type: "text" as const, text: `${threadEnvelope(source.id)}\n${text}` }];
    // Accepted into a process-local FIFO; recorded inputs are never replayed after a crash.
    this.store.recordInput({
      task: destination,
      messageId: v.parse(MessageIdSchema, messageId),
      authorId: v.parse(UserIdSchema, source.id),
      text,
    });
    const sourcePeer = this.server?.attachment(source.id);
    const job = this.enqueueInput(destination, (frontend) => frontend.receivePrepared(content)).catch((error) => {
      if (
        this.closed ||
        this.store.binding(source.container) !== source.projectId ||
        this.server?.attachment(source.id) !== sourcePeer
      )
        return;
      const requester = sourcePeer?.frontend;
      if (requester instanceof TelegramSession && requester.isLive) {
        const failure = [
          {
            type: "text" as const,
            text: `[bridge thread=${destination.id} message=${messageId} delivery=failed]\n${error instanceof Error ? error.message.slice(-1000) : "Input delivery failed"}`,
          },
        ];
        const notification = this.enqueueInput(source, (frontend) => {
          if (this.server?.attachment(source.id) === sourcePeer) frontend.receivePrepared(failure);
        });
        void notification.catch(() => {});
      }
      log({ level: "error", event: "thread.delivery_failed", details: { threadId: destination.id, messageId } });
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return messageId;
  }
}
