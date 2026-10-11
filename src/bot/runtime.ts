import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as v from "valibot";
import { type Container, MessageIdSchema, type Task, type TaskId, TaskIdSchema } from "../agent-bridge/domain.ts";
import type {
  AttachmentIdentity,
  AttachmentRequest,
  SessionBackend,
  SessionFrontend,
} from "../agent-bridge/frontend.ts";
import { LocalPathSchema, type PreparedPrompt } from "../agent-bridge/protocol.ts";
import type { BridgeServer } from "../agent-bridge/server.ts";
import type { Store } from "../agent-bridge/store.ts";

import { projectSpaceKey } from "./commands.ts";

export interface ThreadSession extends SessionFrontend {
  readonly isLive: boolean;
  readonly isRunning: boolean;
  receivePrepared(content: PreparedPrompt["content"]): void;
}
export interface ThreadTransport {
  publishAnchor(task: Task, signal: AbortSignal): Promise<string>;
  reply(
    task: Task,
    messageId: string,
    text: string,
    mentions: string[],
    signal: AbortSignal,
    sent: (id: string) => void,
  ): Promise<string[]>;
}
export interface RuntimeOptions {
  store: Store;
  backend: SessionBackend;
  ownerIds: string[];
  identity: AttachmentIdentity["frontend"];
  platform: Container["platform"];
  transport: ThreadTransport;
  session(frontend: unknown): frontend is ThreadSession;
}
const WRITER_ERROR =
  "The terminal writer has not confirmed shutdown. Reopen that saved session and exit cleanly before continuing.";

/** One saved-thread lifecycle for terminals and all bot transports. IPC attachment is only a writer lease. */
export class BotRuntime {
  server?: BridgeServer;
  readonly starts = new Map<TaskId, { token: string; cancelled: boolean; pending?: Promise<ThreadSession> }>();
  readonly closingThreads = new Map<TaskId, Promise<void>>();
  readonly jobs = new Set<Promise<unknown>>();
  private readonly generations = new Map<TaskId, number>();
  private readonly inputQueues = new Map<TaskId, { generation: number; tail: Promise<void> }>();
  private ended = false;
  constructor(readonly options: RuntimeOptions) {}
  get store() {
    return this.options.store;
  }
  get backend() {
    return this.options.backend;
  }
  get transport() {
    return this.options.transport;
  }
  session = (frontend: unknown): frontend is ThreadSession => this.options.session(frontend);
  closed = (): boolean => this.ended;
  connect(server: BridgeServer): void {
    this.server = server;
  }

  /** No implicit owner DM route. A terminal registers its saved identity in a bound space. */
  authorize(request: AttachmentRequest): AttachmentIdentity & { routeId: string } {
    const { ownerIds, identity, platform } = this.options;
    const ownerId = request.userId ?? (ownerIds.length === 1 ? ownerIds[0] : undefined);
    if (!ownerId || !ownerIds.includes(ownerId)) throw new Error("Choose a configured bot owner.");
    if (!request.sessionFile || !request.cwd)
      throw new Error("Project threads require a saved session file and working directory.");
    const sessionFile = request.sessionFile;
    const association = this.store.attachmentForSession(request.sessionId) ?? this.store.attachmentForFile(sessionFile);
    let task = request.routeId
      ? this.store.task(v.parse(TaskIdSchema, request.routeId))
      : association
        ? this.store.task(association.taskId)
        : null;
    if (request.routeId && !task) throw new Error("Unknown project thread.");
    if (!task) {
      if (request.attachmentToken) throw new Error("Unknown managed startup.");
      const cwd = realpathSync(request.cwd);
      const spaces = this.store
        .snapshot()
        .bindings.filter(
          (binding) =>
            binding.platform === platform &&
            (!request.space || projectSpaceKey(binding) === request.space) &&
            this.store.project(binding.projectId)?.directory === cwd &&
            (platform !== "telegram" || Number(binding.spaceId) <= 0 || binding.spaceId === ownerId),
        );
      if (spaces.length !== 1)
        throw new Error(
          spaces.length
            ? "Several project spaces match. Use /bot <space key> to choose one."
            : "No bound project space matches this working directory.",
        );
      const binding = spaces[0];
      if (!binding) throw new Error("No bound project space matches this working directory.");
      const registered: Task = {
        id: v.parse(TaskIdSchema, `task_${randomUUID()}`),
        projectId: binding.projectId,
        container: { platform: binding.platform, spaceId: binding.spaceId, channelId: binding.channelId },
        rootId: v.parse(MessageIdSchema, `terminal_${randomUUID()}`),
        title: request.name || "Terminal",
        createdAt: new Date().toISOString(),
      };
      // Persistence and writer claim are synchronous under the server's registration lock.
      this.store.atomic(() => {
        this.store.createTask(registered);
        this.store.configureThread(registered.id, cwd);
        this.store.attachTask({ taskId: registered.id, sessionId: request.sessionId, sessionFile, ownerId });
      });
      task = registered;
    }
    if (task.container.platform !== platform) throw new Error("Thread belongs to another bot transport.");
    if (request.space && projectSpaceKey(task.container) !== request.space)
      throw new Error("This saved session already belongs to another project space.");
    if (platform === "telegram" && Number(task.container.spaceId) > 0 && ownerId !== task.container.spaceId)
      throw new Error("This private space belongs to another owner.");
    if (this.store.binding(task.container) !== task.projectId)
      throw new Error("This thread's project is no longer bound.");
    if (realpathSync(request.cwd) !== realpathSync(this.store.threadSettings(task).cwd))
      throw new Error("Pi cwd must match the thread's saved working directory.");
    const saved = this.store.taskAttachment(task.id);
    if (
      saved &&
      (saved.ownerId !== ownerId || saved.sessionId !== request.sessionId || saved.sessionFile !== request.sessionFile)
    )
      throw new Error("Thread belongs to a different saved session or owner.");
    if (request.attachmentToken !== undefined) {
      const start = this.starts.get(task.id);
      if (!start || start.cancelled || start.token !== request.attachmentToken)
        throw new Error("This managed session startup was cancelled.");
      if (this.store.visibleWriter(task.id)) throw new Error(WRITER_ERROR);
    }
    return { userId: ownerId, routeId: task.id, frontend: identity };
  }
  bind(request: AttachmentRequest, identity: AttachmentIdentity): void {
    if (request.attachmentToken !== undefined) this.authorize(request);
    const taskId = v.parse(TaskIdSchema, identity.routeId);
    this.store.attachTask({
      taskId,
      sessionId: request.sessionId,
      sessionFile: v.parse(LocalPathSchema, request.sessionFile),
      ownerId: identity.userId,
    });
    if (request.attachmentToken === undefined) this.store.markVisibleWriter(taskId, request.sessionId);
  }
  disconnected(identity: AttachmentIdentity, quiesced: boolean): void {
    if (quiesced && identity.routeId) this.store.clearVisibleWriter(v.parse(TaskIdSchema, identity.routeId));
  }
  /** Terminal anchors are published once, not retried on uncertain sends. */
  async publishTerminalAnchor(identity: AttachmentIdentity, signal: AbortSignal): Promise<void> {
    const task = this.store.task(v.parse(TaskIdSchema, identity.routeId));
    if (!task?.rootId.startsWith("terminal_") || !this.store.claimAnchor(task.id)) return;
    const id = await this.transport.publishAnchor(task, signal);
    if (!signal.aborted && this.store.binding(task.container) === task.projectId)
      this.store.setTaskRoot(task, v.parse(MessageIdSchema, id));
  }
  ownerForTask(task: Task): string | undefined {
    const saved = this.store.taskAttachment(task.id);
    const author = this.store.taskAuthor(task.id);
    return saved?.ownerId ?? (author && this.options.ownerIds.includes(author) ? author : this.options.ownerIds[0]);
  }
  threadGeneration(taskId: TaskId): number {
    return this.generations.get(taskId) ?? 0;
  }
  hasPendingInputs(taskId: TaskId): boolean {
    return this.inputQueues.has(taskId);
  }
  cancelPendingInputs(taskId: TaskId): void {
    this.generations.set(taskId, (this.generations.get(taskId) ?? 0) + 1);
    this.inputQueues.delete(taskId);
  }
  enqueueInput = (task: Task, deliver: (frontend: ThreadSession) => void): Promise<void> => {
    const generation = this.generations.get(task.id) ?? 0;
    const previous = this.inputQueues.get(task.id);
    const check = () => {
      if (generation !== (this.generations.get(task.id) ?? 0))
        throw new Error("This conversation startup was cancelled.");
      if (this.ended || this.store.binding(task.container) !== task.projectId)
        throw new Error("The conversation is no longer bound.");
    };
    const queue = { generation, tail: Promise.resolve() };
    queue.tail = (previous?.generation === generation ? previous.tail.catch(() => {}) : Promise.resolve()).then(
      async () => {
        check();
        const frontend = await this.ensureSession(task);
        check();
        if (!frontend.isLive) throw new Error("The conversation disconnected before delivery.");
        deliver(frontend);
      },
    );
    this.inputQueues.set(task.id, queue);
    this.track(queue.tail);
    void queue.tail
      .finally(() => {
        if (this.inputQueues.get(task.id) === queue) this.inputQueues.delete(task.id);
      })
      .catch(() => {});
    return queue.tail;
  };
  async ensureSession(task: Task): Promise<ThreadSession> {
    const generation = this.generations.get(task.id) ?? 0;
    await this.closingThreads.get(task.id);
    if (generation !== (this.generations.get(task.id) ?? 0))
      throw new Error("This conversation startup was cancelled.");
    if (this.ended || this.store.binding(task.container) !== task.projectId)
      throw new Error("The conversation is no longer bound.");
    const live = this.server?.attachment(task.id)?.frontend;
    if (this.session(live) && live.isLive) return live;
    if (this.store.visibleWriter(task.id)) throw new Error(WRITER_ERROR);
    const existing = this.starts.get(task.id);
    if (existing?.pending) return existing.pending;
    const start: { token: string; cancelled: boolean; pending?: Promise<ThreadSession> } = {
      token: randomUUID(),
      cancelled: false,
    };
    this.starts.set(task.id, start);
    start.pending = (async () => {
      const association = this.store.taskAttachment(task.id);
      const ownerId = this.ownerForTask(task);
      if (!ownerId || !this.options.ownerIds.includes(ownerId))
        throw new Error("No configured bot owner is available for this saved thread.");
      const settings = this.store.threadSettings(task);
      const saved = await this.backend.open({
        routeId: task.id,
        cwd: settings.cwd,
        ownerId,
        name: task.title || "Conversation",
        sessionId: association?.sessionId,
        sessionFile: association?.sessionFile,
        attachmentToken: start.token,
        explicit: true,
        isDefault: settings.isDefault,
        parentThreadId: settings.parentThreadId,
      });
      if (
        this.ended ||
        start.cancelled ||
        this.starts.get(task.id) !== start ||
        this.store.binding(task.container) !== task.projectId
      )
        throw new Error("This conversation startup was cancelled.");
      this.store.attachTask({ taskId: task.id, ownerId, ...saved });
      const frontend = this.server?.attachment(task.id)?.frontend;
      if (!this.session(frontend) || !frontend.isLive)
        throw new Error("The session disconnected before input was delivered.");
      return frontend;
    })();
    const pending = start.pending;
    this.track(pending);
    void pending
      .finally(() => {
        if (this.starts.get(task.id) === start) start.pending = undefined;
      })
      .catch(() => {});
    return pending;
  }
  cancelSession = (taskId: TaskId): Promise<void> => {
    this.cancelPendingInputs(taskId);
    const start = this.starts.get(taskId);
    if (start) start.cancelled = true;
    this.starts.delete(taskId);
    const existing = this.closingThreads.get(taskId);
    if (existing) return existing;
    const peer = this.server?.attachment(taskId);
    const unconfirmed = !peer && this.store.visibleWriter(taskId);
    const closing = Promise.resolve()
      .then(async () => {
        if (unconfirmed) throw new Error(WRITER_ERROR);
        if (peer && this.server?.attachment(taskId) === peer) await this.server.inspectAgent(taskId, "abort");
        if (this.server?.attachment(taskId) === peer) this.server?.detachRoute(taskId, true);
        await this.backend.closeRoute(taskId);
      })
      .finally(() => {
        if (this.closingThreads.get(taskId) === closing) this.closingThreads.delete(taskId);
      });
    this.closingThreads.set(taskId, closing);
    this.track(closing);
    return closing;
  };
  track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }
  async close(): Promise<void> {
    this.ended = true;
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
}
