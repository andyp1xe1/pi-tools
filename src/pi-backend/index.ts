import { open as openFile, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSessionFromServices,
  createAgentSessionServices,
  DefaultPackageManager,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as v from "valibot";
import { BridgeClient } from "../agent-bridge/client.ts";
import type { SessionBackend, SessionTarget } from "../agent-bridge/frontend.ts";
import {
  AgentOperationBodies,
  type AgentOutput,
  type AgentRequest,
  type PreparedPrompt,
} from "../agent-bridge/protocol.ts";
import { createAudioTranscriptionTool } from "../audio-transcription/index.ts";
import { BotInbox, type BotSubmission } from "../bot/inbox.ts";
import { BOT_MESSAGE_TYPE, getBotTurnId, getMessageText, type PendingBotTurn, preparePrompt } from "../bot/messages.ts";
import { agentSnapshot, availableModels } from "../bot/status.ts";
import { registerBotTools, type ToolConnection } from "../bot/tools.ts";

interface Factories {
  createServices: typeof createAgentSessionServices;
  createSession: typeof createAgentSessionFromServices;
  createClient(options: ConstructorParameters<typeof BridgeClient>[0]): BridgeClient;
  prepare: typeof preparePrompt;
}
const defaults: Factories = {
  createServices: createAgentSessionServices,
  createSession: createAgentSessionFromServices,
  createClient: (options) => new BridgeClient(options),
  prepare: preparePrompt,
};
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const localPath = (path: string, cwd: string): string =>
  resolve(cwd, path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path === "~" ? homedir() : path);

/** Filter discovery BEFORE factories run, including symlinked legacy entrypoints. */
async function managedExtensionPaths(
  resources: Awaited<ReturnType<DefaultPackageManager["resolve"]>>["extensions"],
): Promise<string[]> {
  const paths: string[] = [];
  for (const resource of resources) {
    if (!resource.enabled) continue;
    const canonical = await realpath(resource.path).catch(() => resource.path);
    let legacy = false;
    if (/^telegram\.(ts|js)$/.test(basename(canonical)) && basename(dirname(canonical)) === "extensions") {
      const manifest: unknown = await readFile(resolve(dirname(canonical), "../package.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined);
      legacy = v.is(v.object({ name: v.literal("pi-tools") }), manifest);
    }
    if (!legacy) paths.push(resource.path);
  }
  return paths;
}

/** One process, one native SDK session and portable socket attachment per route. */
export class PiSessionBackend implements SessionBackend {
  private readonly routes = new Map<
    string,
    { host: ManagedSession; pending: Promise<{ sessionId: string; sessionFile: string }> }
  >();
  private closing?: Promise<void>;
  private readonly factories: Factories;

  // The second argument is only a deterministic test seam; production needs only socketPath.
  constructor(
    private readonly options: { socketPath?: string } = {},
    factories: Partial<Factories> = {},
  ) {
    this.factories = { ...defaults, ...factories };
  }

  open(target: SessionTarget): Promise<{ sessionId: string; sessionFile: string }> {
    if (this.closing) return Promise.reject(new Error("Pi backend is closed"));
    const cached = this.routes.get(target.routeId);
    if (cached) {
      if (cached.host.stopped) return Promise.reject(new Error("Pi session is closing; retry after shutdown"));
      if (!cached.host.matches(target)) return Promise.reject(new Error("Pi route target changed"));
      return cached.pending;
    }
    const host = new ManagedSession({ ...target }, this.options.socketPath, this.factories, () => {
      if (this.routes.get(target.routeId)?.host === host) this.routes.delete(target.routeId);
    });
    const pending = host.start().catch(async (error: unknown) => {
      await host.close();
      throw error;
    });
    this.routes.set(target.routeId, { host, pending });
    return pending;
  }

  closeRoute(routeId: string): Promise<void> {
    return this.routes.get(routeId)?.host.close() ?? Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.closing) {
      const hosts = [...this.routes.values()].map(({ host }) => host);
      this.closing = Promise.allSettled(hosts.map((host) => host.close())).then((results) => {
        this.routes.clear();
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "Pi session shutdown failed");
      });
    }
    return this.closing;
  }
}

class ManagedSession {
  stopped = false;
  private session?: AgentSession;
  private settings?: SettingsManager;
  private client?: BridgeClient;
  private starting?: Promise<{ sessionId: string; sessionFile: string }>;
  private closing?: Promise<void>;
  private unsubscribe?: () => void;
  private extensionsBound = false;
  private readonly lifetime = new AbortController();
  private readonly preparations = new Map<string, AbortController>();
  private readonly waiting = new Set<string>();
  private readonly operations = new Set<Promise<unknown>>();
  private mutating = false;
  private activeTurn?: string;
  private assistantError?: string;
  private readonly inbox: BotInbox;

  constructor(
    private readonly target: SessionTarget,
    private readonly socketPath: string | undefined,
    private readonly factories: Factories,
    private readonly removed: () => void,
  ) {
    this.inbox = new BotInbox({
      ready: () =>
        this.current() &&
        !this.mutating &&
        !!this.session &&
        !this.session.isCompacting &&
        (this.session.isStreaming || this.session.isIdle),
      submit: (turn, _ctx, submission) => this.track(this.submit(turn, submission)),
      changed: () => {},
      failed: (turn, _ctx, error) => this.deliveryError(turn.id, error),
    });
    this.inbox.pause();
  }

  matches(target: SessionTarget): boolean {
    return (
      target.cwd === this.target.cwd &&
      target.ownerId === this.target.ownerId &&
      target.attachmentToken === this.target.attachmentToken &&
      (!target.sessionId || target.sessionId === (this.session?.sessionId ?? this.target.sessionId)) &&
      (!target.sessionFile || target.sessionFile === (this.session?.sessionFile ?? this.target.sessionFile))
    );
  }
  start(): Promise<{ sessionId: string; sessionFile: string }> {
    this.starting = this.initialize();
    return this.starting;
  }
  private check(): void {
    if (this.stopped) throw new Error("Pi session is closed");
  }
  private current(): boolean {
    return !this.stopped && this.client?.isAttached === true;
  }
  private output(event: AgentOutput): void {
    if (this.current()) this.client?.output(event);
  }
  private deliveryError(id: string, error: unknown): void {
    this.waiting.delete(id);
    this.output({ type: "delivery-error", turnId: id, error: errorText(error) });
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private async initialize(): Promise<{ sessionId: string; sessionFile: string }> {
    const { cwd } = this.target;
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    this.settings = settings;
    // Match noninteractive startup: saved decisions win, and "ask" never approves.
    const trusted =
      new ProjectTrustStore(agentDir).get(cwd) ??
      (!hasTrustRequiringProjectResources(cwd) || settings.getDefaultProjectTrust() === "always");
    settings.setProjectTrusted(trusted);
    const discovered = await new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }).resolve();
    this.check();
    const paths = await managedExtensionPaths(discovered.extensions);
    this.check();
    const services = await this.factories.createServices({
      cwd,
      agentDir,
      settingsManager: settings,
      modelRuntimeSignal: this.lifetime.signal,
      resourceLoaderOptions: {
        // Discovery is retained, but supplied explicitly because 0.85 has no pre-load filter hook.
        noExtensions: true,
        additionalExtensionPaths: paths,
        extensionFactories: [
          {
            name: "managed-bot",
            factory: (pi) => {
              registerBotTools(pi, () => this.captureConnection());
              pi.registerTool(
                createAudioTranscriptionTool(pi, () => {
                  const connection = this.captureConnection();
                  return ({ path, model, language, signal }) =>
                    connection.transcribeAudio(path, model, language, signal);
                }),
              );
              pi.on("before_agent_start", (event) => ({
                systemPrompt: `${event.systemPrompt}\n\nBot bridge is active. Tagged bot messages may include local attachment paths. Use telegram_attach to send requested files through this session's bridge. Do not retranscribe voice messages that already include a transcript unless asked.`,
              }));
            },
          },
        ],
      },
    });
    this.check();
    const sessionDirSetting = process.env.PI_CODING_AGENT_SESSION_DIR || settings.getSessionDir();
    const sessionDir = sessionDirSetting ? localPath(sessionDirSetting, cwd) : undefined;
    let file = this.target.sessionFile;
    if (!file && this.target.sessionId) {
      file = (await SessionManager.list(cwd, sessionDir)).find((item) => item.id === this.target.sessionId)?.path;
      if (!file) throw new Error(`Mapped Pi session not found: ${this.target.sessionId}`);
    }
    this.check();
    let manager: SessionManager;
    if (file) {
      file = localPath(file, cwd);
      // SessionManager.open can initialize an absent/empty file. A mapping must never do so.
      const header: unknown = JSON.parse((await readFile(file, "utf8")).split("\n")[0]);
      if (
        !header ||
        typeof header !== "object" ||
        !("type" in header) ||
        header.type !== "session" ||
        !("id" in header) ||
        typeof header.id !== "string"
      )
        throw new Error(`Invalid mapped Pi session: ${file}`);
      if (this.target.sessionId && header.id !== this.target.sessionId)
        throw new Error("Mapped Pi session ID does not match file");
      this.check();
      manager = SessionManager.open(file, sessionDir, cwd);
      if (manager.getSessionId() !== header.id) throw new Error("Mapped Pi session changed while opening");
    } else {
      manager = SessionManager.create(cwd, sessionDir);
      file = manager.getSessionFile();
      if (!file) throw new Error("Pi did not create a saved session path");
      const fd = await openFile(file, "wx", 0o600);
      try {
        await fd.writeFile(`${JSON.stringify(manager.getHeader())}\n`);
        await fd.sync();
      } finally {
        await fd.close();
      }
      // Reopen through Pi so it knows the reserved header is already flushed.
      // Otherwise its first assistant write attempts another exclusive create.
      manager = SessionManager.open(file, sessionDir, cwd);
    }
    this.check();
    const patterns = settings.getEnabledModels();
    const scope = patterns?.length
      ? await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal: this.lifetime.signal })
      : undefined;
    this.check();
    const { session } = await this.factories.createSession({
      services,
      sessionManager: manager,
      scopedModels: scope?.scopedModels,
    });
    this.session = session;
    this.check();
    session.agent.toolExecution = "parallel";
    if (!this.target.sessionId && !this.target.sessionFile) session.setSessionName(this.target.name);
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
    // Print-mode UI declines confirmations by default. Never synthesize permission grants.
    this.extensionsBound = true;
    await session.bindExtensions({
      mode: "print",
      shutdownHandler: () => {
        void this.close().catch(() => {});
      },
    });
    this.check();
    const client = this.factories.createClient({
      socketPath: this.socketPath,
      onAttached: (identity) => {
        this.check();
        if (identity.routeId !== this.target.routeId || identity.userId !== this.target.ownerId)
          throw new Error("Pi attachment identity changed");
        this.inbox.resume(session.extensionRunner.createContext());
      },
      onPrompt: (prompt) => this.receive(prompt),
      onAgentRequest: (request) => this.track(this.request(request)),
      onDisconnect: () => {
        void this.close().catch(() => {});
      },
    });
    this.client = client;
    await client.attach(session.sessionId, this.target.ownerId, this.target.routeId, cwd, this.target.attachmentToken);
    this.check();
    if (!client.isAttached || session.sessionFile !== file)
      throw new Error("Pi session did not attach to its saved file");
    return { sessionId: session.sessionId, sessionFile: file };
  }

  private captureConnection(): ToolConnection {
    const client = this.client;
    if (!client || !this.current()) throw new Error("Pi bridge is not attached");
    const check = (): void => {
      if (!this.current() || this.client !== client) throw new Error("Pi bridge is not attached");
    };
    check();
    return {
      check,
      sendAttachment: async (body, signal) => {
        check();
        await client.sendAttachment(body, signal);
        check();
      },
      transcribeAudio: async (path, model, language, signal) => {
        check();
        const result = await client.transcribeAudio(path, model, language, signal);
        check();
        return result;
      },
    };
  }

  private receive(prompt: PreparedPrompt): void {
    if (!this.current() || !this.session) return;
    if (this.waiting.has(prompt.id) || this.activeTurn === prompt.id) {
      this.output({ type: "delivery-error", turnId: prompt.id, error: "Duplicate bot turn ID" });
      return;
    }
    const slot = this.inbox.reserve(this.session.extensionRunner.createContext());
    const controller = new AbortController();
    this.preparations.set(prompt.id, controller);
    this.waiting.add(prompt.id);
    this.track(
      (async () => {
        try {
          const turn = await this.factories.prepare(prompt, controller.signal);
          if (controller.signal.aborted || !this.current()) {
            slot.cancel();
            return;
          }
          slot.complete(turn);
        } catch (error) {
          slot.cancel();
          if (!controller.signal.aborted) this.deliveryError(prompt.id, error);
        } finally {
          if (this.preparations.get(prompt.id) === controller) this.preparations.delete(prompt.id);
        }
      })(),
    );
  }
  private async submit(turn: PendingBotTurn, submission: BotSubmission): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("Pi session is not ready");
    const ctx = session.extensionRunner.createContext();
    const current = (): boolean => submission.isCurrent() && this.current();
    if (!current()) return;
    if (!ctx.model) throw new Error("No model selected for Pi session");
    const authenticated =
      ctx.modelRegistry.hasConfiguredAuth(ctx.model) ||
      (await ctx.modelRegistry.getProviderAuth(ctx.model.provider)) !== undefined;
    if (!current()) return;
    if (!authenticated) throw new Error(`No API key found for ${ctx.model.provider}`);
    let pending: Promise<void> | undefined;
    submission.emit(() => {
      pending = session.sendCustomMessage(
        { customType: BOT_MESSAGE_TYPE, content: turn.content, display: true, details: { turnId: turn.id } },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });
    if (pending) {
      try {
        await this.track(pending);
      } catch (error) {
        if (this.current() && this.activeTurn === turn.id) {
          this.output({ type: "settled", error: errorText(error) });
          this.activeTurn = undefined;
        }
        throw error;
      }
    }
  }

  private onEvent(event: AgentSessionEvent): void {
    if (!this.current() || !this.session) return;
    const ctx = this.session.extensionRunner.createContext();
    if (event.type === "message_start") {
      const turn = this.inbox.take(event.message, ctx);
      if (turn) {
        this.waiting.delete(turn.id);
        this.activeTurn = turn.id;
        this.assistantError = undefined;
        this.output({ type: "turn-start", turnId: turn.id });
      } else if (this.activeTurn && (event.message.role === "user" || event.message.role === "custom")) {
        if (getBotTurnId(event.message) !== this.activeTurn) {
          this.output({ type: "settled" });
          this.activeTurn = undefined;
          this.assistantError = undefined;
        }
      } else if (this.activeTurn && event.message.role === "assistant") {
        this.assistantError = undefined;
        this.output({ type: "text-start" });
      }
    } else if (event.type === "message_update" && this.activeTurn && event.message.role === "assistant") {
      this.output({ type: "text-update", text: getMessageText(event.message) });
    } else if (event.type === "message_end" && this.activeTurn && event.message.role === "assistant") {
      this.assistantError =
        event.message.stopReason === "error" || event.message.stopReason === "aborted"
          ? event.message.errorMessage || "Pi turn failed or was aborted"
          : undefined;
      this.output({ type: "text-end", text: getMessageText(event.message), error: this.assistantError });
    } else if (event.type === "agent_settled") {
      if (this.activeTurn) this.output({ type: "settled", error: this.assistantError });
      this.activeTurn = undefined;
      this.assistantError = undefined;
      this.inbox.rejectUnacknowledged(ctx);
    }
    this.inbox.schedule(ctx);
  }

  private async request(request: AgentRequest): Promise<unknown> {
    if (!this.current() || !this.session) throw new Error("Pi session is closed");
    const session = this.session;
    const ctx = session.extensionRunner.createContext();
    v.parse(AgentOperationBodies[request.operation], request.body);
    if (request.operation === "snapshot") return agentSnapshot({ getThinkingLevel: () => session.thinkingLevel }, ctx);
    if (request.operation === "newSession") return false;
    if (request.operation === "abort") {
      if (session.isIdle && !this.waiting.size && !this.mutating) return false;
      this.cancelIncoming("Bot input cancelled");
      session.clearQueue();
      await session.abort();
      if (this.current()) this.inbox.resume(ctx);
      return true;
    }
    if (!session.isIdle || this.mutating) {
      if (request.operation === "setThinking") throw new Error("Pi is busy. Wait for the current turn to finish.");
      return false;
    }
    this.mutating = true;
    try {
      switch (request.operation) {
        case "setModel": {
          const body = v.parse(AgentOperationBodies.setModel, request.body);
          const model = availableModels(ctx).find((model) => model.provider === body.provider && model.id === body.id);
          if (!model) return false;
          await session.setModel(model);
          return true;
        }
        case "setThinking": {
          const body = v.parse(AgentOperationBodies.setThinking, request.body);
          session.setThinkingLevel(body.level);
          return session.thinkingLevel;
        }
        case "compact":
          await session.compact();
          return true;
      }
    } finally {
      this.mutating = false;
      if (this.current()) this.inbox.schedule(ctx);
    }
  }

  private cancelIncoming(reason: string): void {
    for (const id of this.waiting) this.deliveryError(id, new Error(reason));
    for (const controller of this.preparations.values()) controller.abort();
    this.inbox.stop();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.lifetime.abort();
    this.cancelIncoming("Pi session closed");
    this.activeTurn = undefined;
    this.unsubscribe?.();
    // Defer side effects until the shared close promise is installed: disconnect
    // can synchronously call onDisconnect, including during a failed handshake.
    this.closing = Promise.resolve().then(async () => {
      try {
        const disconnected = this.client?.disconnect();
        this.session?.clearQueue();
        const aborted = this.session?.abort();
        await Promise.allSettled([disconnected, aborted, this.starting]);
        // A factory or startup hook may have completed after close was requested.
        this.session?.clearQueue();
        const abortResult = await Promise.allSettled([this.session?.abort()]);
        while (this.operations.size) await Promise.allSettled([...this.operations]);
        if (this.extensionsBound)
          await this.session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        if (abortResult[0].status === "rejected") throw abortResult[0].reason;
      } finally {
        try {
          this.session?.dispose();
        } finally {
          try {
            await this.settings?.flush();
          } finally {
            this.removed();
          }
        }
      }
    });
    return this.closing;
  }
}
