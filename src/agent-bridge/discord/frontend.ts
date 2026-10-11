import * as v from "valibot";
import { BotCommandService, executeSessionControl } from "../../bot/command-service.ts";
import { BotRuntime } from "../../bot/runtime.ts";
import { ThreadOperationError, ThreadOperations } from "../../bot/thread-operations.ts";
import { MessageIdSchema, type Task, TaskIdSchema } from "../domain.ts";
import { userEnvelope } from "../envelope.ts";
import type { AgentPort, AttachmentIdentity, AttachmentRequest, BridgeFrontend, SessionBackend } from "../frontend.ts";
import type { Operation } from "../protocol.ts";
import type { BridgeServer } from "../server.ts";
import type { Store } from "../store.ts";
import { DiscordAdapter } from "./adapter.ts";
import { DiscordAPIError, DiscordDeliveryUnknown, type DiscordREST } from "./api.ts";
import { DiscordTargetError, type NormalizedDiscord } from "./normalize.ts";
import { DiscordSession } from "./session.ts";
import { chunkDiscordText, DiscordTransport, discordMessageBody } from "./transport.ts";

export interface DiscordFrontendOptions {
  store: Store;
  backend: SessionBackend;
  api: DiscordREST;
  bot: { id: string; username: string };
  ownerIds: string[];
  report?(error: unknown): void;
}

/** BridgeFrontend façade: all saved-thread and command lifecycle belongs to the shared service. */
export class DiscordFrontend implements BridgeFrontend {
  readonly identity: AttachmentIdentity["frontend"];
  readonly mode: "setup" | "routing";
  readonly runtime: BotRuntime;
  readonly transport: DiscordTransport;
  readonly adapter: DiscordAdapter;
  private readonly commands: BotCommandService;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: DiscordFrontendOptions) {
    this.identity = { id: `discord:${options.bot.id}`, label: `@${options.bot.username}` };
    this.mode = options.ownerIds.length ? "routing" : "setup";
    this.transport = this.makeTransport();
    this.runtime = new BotRuntime({
      store: options.store,
      backend: options.backend,
      ownerIds: options.ownerIds,
      identity: this.identity,
      platform: "discord",
      transport: this.transport,
      session: (frontend): frontend is DiscordSession => frontend instanceof DiscordSession,
    });
    this.commands = new BotCommandService(this.runtime);
    this.adapter = new DiscordAdapter(
      options.bot.id,
      options.ownerIds,
      {
        accept: (input, _permissions, signal) => this.accept(input, signal),
        knownTarget: (container, route) => {
          const mapped =
            route.kind === "reply"
              ? options.store.taskForMessage({ container, messageId: route.parentId })
              : route.kind === "thread"
                ? options.store.taskForRoot({ container, rootId: route.threadId })
                : null;
          return !!mapped && mapped.projectId === options.store.binding(container);
        },
        // Provisioning/persisting native-thread aliases is deliberately not implemented here.
        nativeThreadRoot: () => undefined,
      },
      (id, signal) => options.api.channel(id, signal),
    );
  }
  connect(server: BridgeServer): void {
    this.runtime.connect(server);
  }
  authorize(request: AttachmentRequest) {
    return this.runtime.authorize(request);
  }
  bind(request: AttachmentRequest, identity: AttachmentIdentity): void {
    this.runtime.bind(request, identity);
  }
  disconnected(identity: AttachmentIdentity, quiesced: boolean): void {
    this.runtime.disconnected(identity, quiesced);
  }
  statistics() {
    return this.options.store.statistics(this.identity.id);
  }
  error(error: unknown) {
    if (error instanceof DiscordDeliveryUnknown) return { message: error.message, unknownOutcome: true };
    if (error instanceof ThreadOperationError) return { message: error.message, unknownOutcome: error.unknownOutcome };
    if (error instanceof DiscordAPIError || error instanceof DiscordTargetError) return { message: error.message };
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
  open(identity: AttachmentIdentity, agent: AgentPort): DiscordSession {
    const task = this.options.store.task(v.parse(TaskIdSchema, identity.routeId));
    const saved = task ? this.options.store.taskAttachment(task.id) : null;
    if (task?.container.platform !== "discord" || !saved) throw new Error("Missing Discord saved-thread association.");
    const current = () => {
      const latest = this.options.store.taskAttachment(task.id);
      return (
        !this.runtime.closed() &&
        agent.current() &&
        this.options.store.binding(task.container) === task.projectId &&
        latest?.sessionId === saved.sessionId &&
        latest.ownerId === saved.ownerId
      );
    };
    const session = new DiscordSession(agent, task, this.makeTransport(current), current, (error) =>
      this.options.report?.(error),
    );
    this.runtime.track(
      this.runtime.publishTerminalAnchor(identity, this.lifetime.signal).catch((error) => this.options.report?.(error)),
    );
    return session;
  }
  private makeTransport(current?: () => boolean): DiscordTransport {
    const store = this.options.store;
    return new DiscordTransport(this.options.api, {
      current: (task) =>
        !this.runtime.closed() && (current?.() ?? true) && store.binding(task.container) === task.projectId,
      resolve: (task, explicit) => {
        const latest = store.task(task.id);
        if (!latest || latest.projectId !== task.projectId) throw new DiscordTargetError("Unknown Discord thread.");
        if (explicit !== undefined) {
          const mapped = store.taskForMessage({
            container: task.container,
            messageId: v.parse(MessageIdSchema, explicit),
          });
          if (!mapped || mapped.projectId !== task.projectId)
            throw new DiscordTargetError("Unknown explicit Discord reply target.");
        }
        const anchor = explicit ?? (/^[1-9]\d*$/.test(latest.rootId) ? latest.rootId : undefined);
        return { channelId: task.container.channelId, ...(anchor ? { messageId: anchor } : {}) };
      },
      sent: (task, _channelId, id) => {
        if (!this.runtime.closed() && (current?.() ?? true) && store.binding(task.container) === task.projectId)
          store.mapMessage({ container: task.container, messageId: v.parse(MessageIdSchema, id), taskId: task.id });
      },
      knownUser: (task, userId) => !!store.userName(task.container, userId),
    });
  }
  /** Host passes Gateway dispatches here; no platform polling or socket lifecycle is hidden inside. */
  receive(name: string, data: unknown, signal: AbortSignal = this.lifetime.signal) {
    return this.adapter.dispatch(name, data, AbortSignal.any([signal, this.lifetime.signal]));
  }
  private async accept(input: NormalizedDiscord, signal: AbortSignal): Promise<void> {
    const { store } = this.options;
    store.rememberUser(input.message.container, input.message.authorId, input.name);
    const dispatch = this.commands.dispatch(input.message, input.command);
    if (dispatch.reply !== null) {
      await this.controlReply(input, dispatch.reply, signal);
      return;
    }
    const result = dispatch.result;
    if (result?.kind !== "routed") return;
    if (dispatch.control && input.command) {
      const text = await executeSessionControl(
        this.runtime,
        result.task,
        input.command.name,
        input.command.argument,
        input.message.authorId,
      );
      signal.throwIfAborted();
      await this.controlReply(input, text, signal, result.task);
      return;
    }
    if (dispatch.empty) {
      await this.runtime.ensureSession(result.task);
      await this.controlReply(
        input,
        "Started a separate saved conversation. Reply here to continue it.",
        signal,
        result.task,
      );
      return;
    }
    const envelope = userEnvelope({
      platform: "discord",
      userId: input.message.authorId,
      name: input.name,
      messageId: input.message.id,
      ...(input.message.route.kind === "reply" ? { replyToId: input.message.route.parentId } : {}),
    });
    await this.runtime.enqueueInput(result.task, (session) => {
      signal.throwIfAborted();
      session.receivePrepared([{ type: "text", text: `${envelope}\n${input.message.text}` }]);
    });
  }
  private async controlReply(input: NormalizedDiscord, text: string, signal: AbortSignal, task?: Task): Promise<void> {
    const { store } = this.options;
    const project = store.binding(input.message.container);
    const mapped =
      task ??
      (input.message.route.kind === "reply"
        ? store.taskForMessage({ container: input.message.container, messageId: input.message.route.parentId })
        : store.defaultTask(input.message.container));
    // A /bind or /help response may precede any shared thread, so use only the received wire anchor.
    for (const chunk of chunkDiscordText(text)) {
      signal.throwIfAborted();
      if (project !== store.binding(input.message.container))
        throw new DiscordTargetError("Discord project binding changed during the command reply.");
      const message = await this.options.api.createMessage(
        input.wire.channelId,
        discordMessageBody(chunk, { channelId: input.wire.channelId, messageId: input.wire.messageId }),
        signal,
      );
      if (mapped && mapped.projectId === store.binding(input.message.container))
        store.mapMessage({
          container: input.message.container,
          messageId: v.parse(MessageIdSchema, message.id),
          taskId: mapped.id,
        });
    }
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    await this.runtime.close();
  }
}
