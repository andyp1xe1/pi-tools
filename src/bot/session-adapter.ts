import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as v from "valibot";
import { BridgeClient, registerBridgeTranscription } from "../agent-bridge/client.ts";
import {
  AgentOperationBodies,
  type AgentOutput,
  type AgentRequest,
  type PreparedPrompt,
  type ServerFrame,
  ThinkingLevelSchema,
} from "../agent-bridge/protocol.ts";
import { registerAudioTranscriptionTool } from "../audio-transcription/index.ts";
import { BotInbox, type BotSubmission } from "./inbox.ts";
import { BOT_MESSAGE_TYPE, getBotTurnId, getMessageText, type PendingBotTurn, preparePrompt } from "./messages.ts";
import { agentSnapshot, availableModels } from "./status.ts";
import { registerBotTools, type ToolConnection } from "./tools.ts";

const SYSTEM_PROMPT_SUFFIX = `

Bot bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- Bot messages may include local attachment paths. Read those files as needed.
- Use telegram_attach to send requested local files through the attached bridge, including requests from the terminal.
- If a bot message asks for a file or generated artifact, call telegram_attach instead of only mentioning its local path.`;

const PROCESS_INTENT = Symbol.for("pi-tools.agent-bridge.attachment-intent");
const ProcessIntentSchema = v.pipe(
  v.object({
    version: v.literal(1),
    ownerId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(128))),
    routeId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(128))),
    sessionId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(128))),
    runtimeId: v.optional(v.pipe(v.string(), v.nonEmpty())),
    closing: v.optional(v.custom<Promise<unknown>>((value) => value instanceof Promise)),
  }),
  v.check((intent) => (intent.ownerId === undefined && intent.closing === undefined) || intent.runtimeId !== undefined),
);
type ProcessIntent = v.InferOutput<typeof ProcessIntentSchema>;
function readProcessIntent(): ProcessIntent {
  const value: unknown = Reflect.get(globalThis, PROCESS_INTENT);
  const parsed = v.safeParse(ProcessIntentSchema, value);
  if (parsed.success) return parsed.output;
  const empty: ProcessIntent = { version: 1 };
  Reflect.set(globalThis, PROCESS_INTENT, empty);
  return empty;
}
function writeProcessIntent(intent: ProcessIntent): void {
  Reflect.set(globalThis, PROCESS_INTENT, v.parse(ProcessIntentSchema, intent));
}

type Attached = Extract<ServerFrame, { type: "attached" }>;
type ClientFactory = (options: ConstructorParameters<typeof BridgeClient>[0]) => BridgeClient;

export class BotSessionAdapter {
  private runtimeId = randomUUID();
  private runtimeClaimed = false;
  private shuttingDown = false;
  private generation = 0;
  private connection?: BridgeClient;
  private identity?: Attached;
  private connectingPromise?: Promise<void>;
  private disconnectingPromise?: Promise<void>;
  private lastConnectionError?: string;
  private needsIdleBeforeAttach = false;
  private waitForIdleAfterReload = false;
  private activeTurnId?: string;
  private lastAssistantError?: string;
  private agentRunning = false;
  private compacting = false;
  private releaseTranscription?: () => void;
  private readonly queuedActions = new Set<ReturnType<typeof setTimeout>>();
  private readonly preparations = new Set<AbortController>();
  private readonly mutations = new Set<Promise<unknown>>();
  private readonly inbox: BotInbox;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly createClient: ClientFactory = (options) => new BridgeClient(options),
    private readonly prepare: typeof preparePrompt = preparePrompt,
  ) {
    this.inbox = new BotInbox({
      ready: (ctx) => {
        if (ctx.isIdle()) this.waitForIdleAfterReload = false;
        return (
          this.isCurrentRuntime() &&
          !this.waitForIdleAfterReload &&
          !this.compacting &&
          (this.agentRunning || ctx.isIdle())
        );
      },
      submit: (turn, ctx, submission) => this.submitTurn(turn, ctx, submission),
      changed: (ctx) => this.updateStatus(ctx),
      failed: (turn, ctx, error) =>
        this.output({ type: "delivery-error", turnId: turn.id, error: this.errorMessage(error) }, ctx),
    });
    this.inbox.pause();
  }

  private async submitTurn(turn: PendingBotTurn, ctx: ExtensionContext, submission: BotSubmission): Promise<void> {
    const generation = this.generation;
    const connection = this.connection;
    const current = (): boolean =>
      submission.isCurrent() &&
      generation === this.generation &&
      this.isCurrentRuntime() &&
      connection === this.connection &&
      connection?.isAttached === true;
    if (!current()) return;
    const model = ctx.model;
    if (!model) throw new Error("No model selected. Select a model before sending bot input.");
    const hasAuth =
      ctx.modelRegistry.hasConfiguredAuth(model) ||
      (await ctx.modelRegistry.getProviderAuth(model.provider)) !== undefined;
    if (!current()) return;
    if (!hasAuth) throw new Error(`No API key found for ${model.provider}. Use /login or configure an API key.`);
    submission.emit(() =>
      this.pi.sendMessage(
        { customType: BOT_MESSAGE_TYPE, content: turn.content, display: true, details: { turnId: turn.id } },
        { triggerTurn: true, deliverAs: "steer" },
      ),
    );
  }

  register(): void {
    registerBotTools(this.pi, () => this.captureConnection());
    this.registerCommands();
    this.registerEvents();
  }

  private claimRuntime(): ProcessIntent {
    const intent = readProcessIntent();
    this.runtimeClaimed = true;
    writeProcessIntent({ ...intent, runtimeId: this.runtimeId });
    return intent;
  }
  private isCurrentRuntime(): boolean {
    return !this.shuttingDown && (!this.runtimeClaimed || readProcessIntent().runtimeId === this.runtimeId);
  }
  private setOwnerIntent(ownerId?: string, routeId?: string, sessionId?: string): void {
    const intent = readProcessIntent();
    if (intent.runtimeId === this.runtimeId) writeProcessIntent({ ...intent, ownerId, routeId, sessionId });
  }
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  private updateStatus(ctx: ExtensionContext, error?: string): void {
    if (!this.isCurrentRuntime()) return;
    const state = error
      ? `error: ${error}`
      : this.connection?.isAttached
        ? this.activeTurnId
          ? "replying"
          : "attached"
        : this.connectingPromise
          ? "attaching"
          : "detached";
    ctx.ui.setStatus("bot", `bot ${state}${this.inbox.count ? ` · ${this.inbox.count} incoming` : ""}`);
  }
  private output(event: AgentOutput, ctx: ExtensionContext): void {
    if (!this.isCurrentRuntime() || !this.connection?.isAttached) return;
    try {
      this.connection.output(event);
    } catch (error) {
      this.updateStatus(ctx, this.errorMessage(error));
    }
  }
  private captureConnection(): ToolConnection {
    const connection = this.connection;
    const generation = this.generation;
    if (!this.isCurrentRuntime() || !connection?.isAttached)
      throw new Error("Agent bridge is not attached. Run /bot-connect first.");
    const check = (): void => {
      if (generation !== this.generation || !this.isCurrentRuntime() || !connection.isAttached)
        throw new Error("Agent bridge attachment changed");
    };
    return {
      check,
      sendAttachment: async (body, signal) => {
        check();
        await connection.sendAttachment(body, signal);
        check();
      },
      transcribeAudio: async (path, model, language, signal) => {
        check();
        const result = await connection.transcribeAudio(path, model, language, signal);
        check();
        return result;
      },
    };
  }
  private trackMutation<T>(start: () => Promise<T>): Promise<T> {
    const pending = start();
    this.mutations.add(pending);
    void pending.then(
      () => this.mutations.delete(pending),
      () => this.mutations.delete(pending),
    );
    return pending;
  }
  private async waitForMutations(): Promise<void> {
    while (this.mutations.size) await Promise.allSettled([...this.mutations]);
  }
  private invalidateAttachment(): void {
    this.needsIdleBeforeAttach ||= !!this.activeTurnId || this.inbox.count > 0;
    this.generation += 1;
    this.releaseTranscription?.();
    this.releaseTranscription = undefined;
    for (const action of this.queuedActions) clearTimeout(action);
    this.queuedActions.clear();
    for (const preparation of this.preparations) preparation.abort();
    this.preparations.clear();
    this.inbox.stop();
    this.activeTurnId = undefined;
    this.lastAssistantError = undefined;
    this.identity = undefined;
  }
  private async disconnect(): Promise<void> {
    if (this.disconnectingPromise) return this.disconnectingPromise;
    const connection = this.connection;
    this.connection = undefined;
    this.invalidateAttachment();
    this.disconnectingPromise = (async () => {
      await Promise.all([connection?.disconnect(), this.waitForMutations()]);
      await this.connectingPromise?.catch(() => undefined);
    })();
    try {
      await this.disconnectingPromise;
    } finally {
      this.disconnectingPromise = undefined;
    }
  }

  private async attach(ctx: ExtensionContext, userId?: string, routeId?: string): Promise<void> {
    if (routeId?.startsWith("task_") && !ctx.sessionManager.getSessionFile()) {
      ctx.ui.notify("Group conversations require a saved Pi session. Restart Pi without --no-session.", "warning");
      return;
    }
    const runtimeId = this.runtimeId;
    const pendingGeneration = this.generation;
    await readProcessIntent().closing;
    await this.disconnectingPromise;
    await this.waitForMutations();
    if (runtimeId !== this.runtimeId || pendingGeneration !== this.generation || !this.isCurrentRuntime()) return;
    if (this.connection?.isAttached) {
      ctx.ui.notify("This Pi session is already attached. Run /bot-disconnect before changing owner.", "info");
      return;
    }
    if (this.connectingPromise) return this.connectingPromise.catch(() => undefined);
    const generation = ++this.generation;
    const current = (): boolean => generation === this.generation && this.isCurrentRuntime() && connection.isAttached;
    const connection = this.createClient({
      onAttached: (frame) => {
        if (
          !current() ||
          (userId !== undefined && frame.userId !== userId) ||
          (routeId !== undefined && frame.routeId !== routeId)
        )
          throw new Error("Agent bridge attachment identity changed");
        this.identity = frame;
        this.setOwnerIntent(frame.userId, frame.routeId, ctx.sessionManager.getSessionId());
        const client = this.captureConnection();
        this.releaseTranscription = registerBridgeTranscription(
          `${this.runtimeId}:${generation}`,
          ({ path, model, language, signal }) => client.transcribeAudio(path, model, language, signal),
        );
        this.lastConnectionError = undefined;
        this.inbox.resume(ctx);
        this.updateStatus(ctx);
      },
      onPrompt: (prompt) => {
        if (!current()) return;
        void this.receivePrompt(prompt, ctx, current).catch((error: unknown) => {
          if (current())
            this.output({ type: "delivery-error", turnId: prompt.id, error: this.errorMessage(error) }, ctx);
        });
      },
      onAgentRequest: async (request) => {
        if (!current()) throw new Error("Agent bridge attachment changed");
        const result = await this.handleAgentRequest(request, ctx);
        if (!current()) throw new Error("Agent bridge attachment changed");
        return result;
      },
      onDisconnect: (error) => {
        if (generation !== this.generation) return;
        const currentRuntime = this.isCurrentRuntime();
        if (currentRuntime) this.setOwnerIntent();
        this.invalidateAttachment();
        if (!currentRuntime) return;
        this.lastConnectionError = error.message;
        this.updateStatus(ctx, error.message);
      },
    });
    this.connection = connection;
    this.connectingPromise = connection
      .attach(ctx.sessionManager.getSessionId(), userId, routeId, ctx.cwd)
      .then(() => undefined);
    try {
      await this.connectingPromise;
    } catch (error) {
      if (this.connection === connection && this.isCurrentRuntime()) ctx.ui.notify(this.errorMessage(error), "error");
    } finally {
      this.connectingPromise = undefined;
      if (this.connection === connection && this.isCurrentRuntime()) this.updateStatus(ctx, this.lastConnectionError);
    }
  }

  private async receivePrompt(prompt: PreparedPrompt, ctx: ExtensionContext, current: () => boolean): Promise<void> {
    const slot = this.inbox.reserve(ctx);
    const preparation = new AbortController();
    this.preparations.add(preparation);
    try {
      const turn = await this.prepare(prompt, preparation.signal);
      if (current()) slot.complete(turn);
      else slot.cancel();
    } catch (error) {
      slot.cancel();
      throw error;
    } finally {
      this.preparations.delete(preparation);
    }
  }

  private async handleAgentRequest(request: AgentRequest, ctx: ExtensionContext): Promise<unknown> {
    switch (request.operation) {
      case "snapshot":
        v.parse(AgentOperationBodies.snapshot, request.body);
        return agentSnapshot(this.pi, ctx);
      case "abort":
        v.parse(AgentOperationBodies.abort, request.body);
        if (ctx.isIdle()) return false;
        ctx.abort();
        return true;
      case "setModel": {
        const body = v.parse(AgentOperationBodies.setModel, request.body);
        if (!ctx.isIdle()) return false;
        const model = availableModels(ctx).find((model) => model.provider === body.provider && model.id === body.id);
        return model ? this.trackMutation(() => this.pi.setModel(model)) : false;
      }
      case "setThinking": {
        const body = v.parse(AgentOperationBodies.setThinking, request.body);
        if (!ctx.isIdle()) throw new Error("Pi is busy. Wait for the current turn to finish.");
        this.pi.setThinkingLevel(body.level);
        return v.parse(ThinkingLevelSchema, this.pi.getThinkingLevel());
      }
      case "compact":
        v.parse(AgentOperationBodies.compact, request.body);
        if (!ctx.isIdle()) return false;
        return this.trackMutation(
          () =>
            new Promise<boolean>((resolve, reject) => {
              ctx.compact({ onComplete: () => resolve(true), onError: reject });
            }),
        );
      case "newSession":
        v.parse(AgentOperationBodies.newSession, request.body);
        if (!ctx.isIdle() || this.identity?.routeId?.startsWith("task_")) return false;
        // Let the portable client write agent-result before this action detaches it.
        this.queueNewSession(ctx);
        return true;
    }
  }

  private queueNewSession(ctx: ExtensionContext): void {
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.queuedActions.delete(timer);
      if (generation !== this.generation || !this.isCurrentRuntime() || !this.connection?.isAttached) return;
      try {
        this.pi.sendUserMessage("/bot-new", { expandPromptTemplates: true });
      } catch (error) {
        this.updateStatus(ctx, this.errorMessage(error));
      }
    }, 0);
    this.queuedActions.add(timer);
  }

  private registerCommands(): void {
    this.pi.registerCommand("bot-connect", {
      description: "Attach this Pi session: [task_<id>] [owner ID]",
      handler: async (args, ctx) => {
        const parts = args.trim() ? args.trim().split(/\s+/) : [];
        const routeId = parts[0]?.startsWith("task_") ? parts.shift() : undefined;
        const userId = parts.shift();
        if (
          parts.length ||
          (routeId && !/^task_[a-z0-9_-]+$/i.test(routeId)) ||
          (userId && (userId.length > 128 || !/^[^\s]+$/.test(userId)))
        ) {
          ctx.ui.notify("Usage: /bot-connect [task_<id>] [owner ID]", "warning");
          return;
        }
        if (this.needsIdleBeforeAttach) {
          const generation = this.generation;
          await ctx.waitForIdle();
          if (generation !== this.generation || !this.isCurrentRuntime()) return;
          this.needsIdleBeforeAttach = false;
        }
        if (!this.runtimeClaimed) this.claimRuntime();
        await this.attach(ctx, userId, routeId);
      },
    });
    this.pi.registerCommand("bot-disconnect", {
      description: "Clear attachment intent and detach this Pi session",
      handler: async (_args, ctx) => {
        this.setOwnerIntent();
        this.generation += 1;
        await this.disconnect();
        this.lastConnectionError = undefined;
        this.updateStatus(ctx);
      },
    });
    this.pi.registerCommand("bot-status", {
      description: "Show local agent-bridge attachment state",
      handler: async (_args, ctx) =>
        ctx.ui.notify(
          [
            `state: ${this.connection?.isAttached ? "attached" : this.connectingPromise ? "attaching" : "detached"}`,
            `frontend: ${this.identity?.frontend.label ?? "unknown"}`,
            `route: ${this.identity?.routeId ?? "unknown"}`,
            `owner: ${this.identity?.userId ?? "unknown"}`,
            `replying: ${this.activeTurnId ? "yes" : "no"}`,
            `incoming messages waiting for pi: ${this.inbox.count}`,
            ...(this.lastConnectionError ? [`last error: ${this.lastConnectionError}`] : []),
          ].join(" | "),
          "info",
        ),
    });
    this.pi.registerCommand("bot-new", {
      description: "Start a new Pi session and reattach to agent-bridge",
      handler: async (_args, ctx) => {
        if (this.identity?.routeId?.startsWith("task_")) {
          ctx.ui.notify(
            "This thread retains its Pi session identity. Reply /release in Telegram before changing its association, then /bot-connect explicitly.",
            "warning",
          );
          return;
        }
        const generation = this.generation;
        await ctx.waitForIdle();
        if (generation !== this.generation || !this.isCurrentRuntime() || !this.connection?.isAttached) return;
        const parentSession = ctx.sessionManager.getSessionFile();
        const result = await ctx.newSession({ ...(parentSession ? { parentSession } : {}) });
        if (result.cancelled && generation === this.generation && this.isCurrentRuntime())
          ctx.ui.notify("New bot session was cancelled.", "warning");
      },
    });
  }

  private registerEvents(): void {
    this.pi.on("session_start", async (event, ctx) => {
      this.runtimeId = randomUUID();
      this.shuttingDown = false;
      const previous = this.claimRuntime();
      const closing = this.disconnect();
      const generation = this.generation;
      await previous.closing;
      await closing;
      if (generation !== this.generation || !this.isCurrentRuntime()) return;
      // Register after handoff, once Pi has bound its live tool inventory.
      registerAudioTranscriptionTool(this.pi);
      this.compacting = false;
      this.agentRunning = false;
      this.needsIdleBeforeAttach = false;
      this.waitForIdleAfterReload = event.reason === "reload" && !ctx.isIdle();
      const intent = readProcessIntent();
      const ownerId = intent.ownerId;
      if (
        ownerId !== undefined &&
        (!intent.routeId?.startsWith("task_") || intent.sessionId === ctx.sessionManager.getSessionId())
      )
        await this.attach(ctx, ownerId, intent.routeId);
      else this.updateStatus(ctx);
    });
    this.pi.on("session_shutdown", async (event) => this.onSessionShutdown(event.reason));
    this.pi.on("session_before_compact", async () => {
      if (this.isCurrentRuntime()) this.compacting = true;
    });
    const afterCompaction = (_event: unknown, ctx: ExtensionContext): void => {
      if (!this.isCurrentRuntime()) return;
      this.compacting = false;
      this.inbox.schedule(ctx);
    };
    this.pi.on("session_compact", afterCompaction);
    this.pi.on("session_compact_failed", afterCompaction);
    this.pi.on("before_agent_start", async (event) => ({
      systemPrompt: event.systemPrompt + SYSTEM_PROMPT_SUFFIX,
    }));
    this.pi.on("agent_start", async (_event, ctx) => {
      if (!this.isCurrentRuntime()) return;
      this.agentRunning = true;
      this.inbox.schedule(ctx);
      this.updateStatus(ctx);
    });
    this.pi.on("message_start", async (event, ctx) => this.onMessageStart(event.message, ctx));
    this.pi.on("message_update", async (event, ctx) => {
      if (this.activeTurnId && event.message.role === "assistant")
        this.output({ type: "text-update", text: getMessageText(event.message) }, ctx);
    });
    this.pi.on("message_end", async (event, ctx) => {
      if (!this.isCurrentRuntime() || !this.activeTurnId || event.message.role !== "assistant") return;
      this.lastAssistantError =
        event.message.stopReason === "error"
          ? event.message.errorMessage || "Pi failed while processing the request."
          : undefined;
      this.output({ type: "text-end", text: getMessageText(event.message), error: this.lastAssistantError }, ctx);
    });
    this.pi.on("agent_settled", async (_event, ctx) => {
      if (!this.isCurrentRuntime()) return;
      if (this.activeTurnId) this.output({ type: "settled", error: this.lastAssistantError }, ctx);
      this.activeTurnId = undefined;
      this.lastAssistantError = undefined;
      this.agentRunning = false;
      this.inbox.rejectUnacknowledged(ctx);
      this.updateStatus(ctx);
      this.inbox.schedule(ctx);
    });
  }
  private async onSessionShutdown(reason = "quit"): Promise<void> {
    this.shuttingDown = true;
    this.compacting = false;
    this.agentRunning = false;
    if (reason === "quit" || (reason !== "reload" && this.identity?.routeId?.startsWith("task_")))
      this.setOwnerIntent();
    const closing = this.disconnect();
    const intent = readProcessIntent();
    if (intent.runtimeId === this.runtimeId) writeProcessIntent({ ...intent, closing });
    await closing;
    const latest = readProcessIntent();
    if (latest.closing === closing) writeProcessIntent({ ...latest, closing: undefined });
  }
  private onMessageStart(message: AgentMessage, ctx: ExtensionContext): void {
    if (!this.isCurrentRuntime()) return;
    const turn = this.inbox.take(message, ctx);
    if (turn) {
      if (this.inbox.isPaused) return;
      this.activeTurnId = turn.id;
      this.lastAssistantError = undefined;
      this.output({ type: "turn-start", turnId: turn.id }, ctx);
      this.updateStatus(ctx);
    } else if (this.activeTurnId && (message.role === "user" || message.role === "custom")) {
      if (getBotTurnId(message) === this.activeTurnId) return;
      // End the bot's output route before terminal or other extension input.
      // The daemon settles its preview and typing loop; Pi keeps running.
      this.activeTurnId = undefined;
      this.lastAssistantError = undefined;
      this.output({ type: "settled" }, ctx);
      this.updateStatus(ctx);
    } else if (this.activeTurnId && message.role === "assistant") {
      this.lastAssistantError = undefined;
      this.output({ type: "text-start" }, ctx);
    }
  }
}
