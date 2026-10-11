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
  migrateSessionEntries,
  ProjectTrustStore,
  parseSessionEntries,
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
import { handleBotRequest } from "../bot/controls.ts";
import { BotDelivery } from "../bot/delivery.ts";
import { preparePrompt } from "../bot/messages.ts";
import {
  registerThreadTools,
  type ThreadHistory,
  type ThreadToolConnection,
  threadHistory,
} from "../bot/thread-tools.ts";
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
const localPath = (path: string, cwd: string): string =>
  resolve(cwd, path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path === "~" ? homedir() : path);

/** Managed sessions provide their own attachment; exclude our visible-session entrypoints before loading. */
async function managedExtensionPaths(
  resources: Awaited<ReturnType<DefaultPackageManager["resolve"]>>["extensions"],
): Promise<string[]> {
  const paths: string[] = [];
  for (const resource of resources) {
    if (!resource.enabled) continue;
    const canonical = await realpath(resource.path).catch(() => resource.path);
    let visibleAttachment = false;
    if (/^bot\.(ts|js)$/.test(basename(canonical)) && basename(dirname(canonical)) === "extensions") {
      const manifest: unknown = await readFile(resolve(dirname(canonical), "../package.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined);
      visibleAttachment = v.is(v.object({ name: v.literal("pi-tools") }), manifest);
    }
    if (!visibleAttachment) paths.push(resource.path);
  }
  return paths;
}

const historyHeader = v.object({ type: v.literal("session"), id: v.pipe(v.string(), v.nonEmpty()), cwd: v.string() });

/** Read stopped histories without opening, creating, migrating, or rewriting any saved file. */
export async function readThreadHistory(
  sessionFile: string,
  limit?: number,
  before?: string,
  expectedId?: string,
): Promise<ThreadHistory> {
  const content = await readFile(sessionFile, "utf8");
  const header = v.parse(historyHeader, JSON.parse(content.split("\n")[0]));
  if (expectedId && header.id !== expectedId) throw new Error("Mapped Pi session ID does not match file");
  const entries = parseSessionEntries(content);
  migrateSessionEntries(entries);
  // SessionManager assumes an acyclic tree; reject corrupt links before traversing it.
  const seen = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("parentId" in entry) ||
      typeof entry.id !== "string" ||
      seen.has(entry.id) ||
      (entry.parentId !== null && !seen.has(entry.parentId))
    )
      throw new Error("Invalid saved Pi session tree");
    seen.add(entry.id);
  }
  return threadHistory(SessionManager.inMemory(header.cwd, undefined, entries), limit, before);
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
    if (target.sessionId && !target.sessionFile)
      return Promise.reject(new Error("Mapped Pi sessions require an exact saved session file."));
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

  async peek(target: SessionTarget, limit?: number, before?: string): Promise<ThreadHistory> {
    if (this.closing) throw new Error("Pi backend is closed");
    const route = this.routes.get(target.routeId);
    if (route && !route.host.stopped) {
      if (!route.host.matchesInspection(target)) throw new Error("Pi route target changed");
      await route.pending;
      return route.host.peek(limit, before);
    }
    if (!target.sessionFile) throw new Error("Thread has no saved session file");
    return readThreadHistory(localPath(target.sessionFile, target.cwd), limit, before, target.sessionId);
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
  private compactionKeepRecent?: number;
  private client?: BridgeClient;
  private starting?: Promise<{ sessionId: string; sessionFile: string }>;
  private closing?: Promise<void>;
  private unsubscribe?: () => void;
  private extensionsBound = false;
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private mutating = false;
  private readonly delivery: BotDelivery;
  private get inbox() {
    return this.delivery.inbox;
  }

  constructor(
    private readonly target: SessionTarget,
    private readonly socketPath: string | undefined,
    private readonly factories: Factories,
    private readonly removed: () => void,
  ) {
    this.delivery = new BotDelivery({
      current: () => this.current(),
      prepare: this.factories.prepare,
      ready: () =>
        !this.mutating &&
        !!this.session &&
        !this.session.isCompacting &&
        (this.session.isStreaming || this.session.isIdle),
      send: (message) => {
        if (!this.session) throw new Error("Pi session is not ready");
        return this.session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "steer" });
      },
      output: (event) => this.output(event),
      track: (operation) => this.track(operation),
      changed: () => {},
    });
  }

  matchesInspection(target: SessionTarget): boolean {
    return (
      target.cwd === this.target.cwd &&
      target.ownerId === this.target.ownerId &&
      (!target.sessionId || target.sessionId === (this.session?.sessionId ?? this.target.sessionId)) &&
      (!target.sessionFile || target.sessionFile === (this.session?.sessionFile ?? this.target.sessionFile))
    );
  }
  matches(target: SessionTarget): boolean {
    return (
      target.cwd === this.target.cwd &&
      target.ownerId === this.target.ownerId &&
      target.attachmentToken === this.target.attachmentToken &&
      !!target.explicit === !!this.target.explicit &&
      !!target.isDefault === !!this.target.isDefault &&
      target.parentThreadId === this.target.parentThreadId &&
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
    // Keep delivery acknowledgements/status intact; only automatic text publication is private.
    if (this.target.explicit && ["text-start", "text-update", "text-end"].includes(event.type)) return;
    if (this.current()) this.client?.output(event);
  }
  peek(limit?: number, before?: string): ThreadHistory {
    this.check();
    if (!this.session) throw new Error("Pi session is not ready");
    return threadHistory(this.session.sessionManager, limit, before);
  }
  private configureDefaultCompaction(window = this.session?.model?.contextWindow): void {
    if (!this.target.isDefault || !this.settings || !window || !Number.isFinite(window) || window <= 0) return;
    this.compactionKeepRecent ??= this.settings.getCompactionSettings().keepRecentTokens;
    this.settings.applyOverrides({
      compaction: {
        reserveTokens: Math.ceil(window * 0.7),
        keepRecentTokens: Math.min(this.compactionKeepRecent, Math.floor(window * 0.1)),
      },
    });
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
        // BotDelivery uses custom messages, which bypass before_agent_start.
        // Append to the real base prompt and preserve discovered/global appends
        // on both initial load and native resource reload.
        appendSystemPromptOverride: (base) => [
          ...base,
          `Bot bridge is active. Tagged bot messages may include local attachment paths. Use bot_attach to send requested files through this session's bridge. Do not retranscribe voice messages that already include a transcript unless asked.${this.target.explicit ? `\nThread ID: ${this.target.routeId}.${this.target.isDefault ? " You are the default thread." : ""}${this.target.parentThreadId ? ` Parent thread: ${this.target.parentThreadId}.` : ""} Ordinary assistant text is private. Use reply_message with the incoming user message ID to reply, or message_thread to communicate with peers. Report delegated results explicitly to the sender.` : ""}`,
        ],
        // Discovery is retained, but supplied explicitly because 0.85 has no pre-load filter hook.
        noExtensions: true,
        additionalExtensionPaths: paths,
        extensionFactories: [
          {
            name: "managed-bot",
            factory: (pi) => {
              registerBotTools(pi, () => this.captureConnection());
              if (this.target.explicit) registerThreadTools(pi, () => this.captureConnection());
              if (this.target.isDefault) {
                pi.on("model_select", (event) => this.configureDefaultCompaction(event.model.contextWindow));
                pi.on("session_before_compact", (event) => {
                  if (event.reason !== "threshold") return;
                  // A huge retained turn/summary can stay above the early threshold.
                  // Do not summarize the identical retained boundary repeatedly.
                  const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
                  if (
                    previous?.type === "compaction" &&
                    previous.firstKeptEntryId === event.preparation.firstKeptEntryId
                  )
                    return { cancel: true };
                });
              }
              pi.registerTool(
                createAudioTranscriptionTool(pi, () => {
                  const connection = this.captureConnection();
                  return ({ path, model, language, signal }) =>
                    connection.transcribeAudio(path, model, language, signal);
                }),
              );
            },
          },
        ],
      },
    });
    this.check();
    const sessionDirSetting = process.env.PI_CODING_AGENT_SESSION_DIR || settings.getSessionDir();
    const sessionDir = sessionDirSetting ? localPath(sessionDirSetting, cwd) : undefined;
    let file = this.target.sessionFile;
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
    this.configureDefaultCompaction();
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
    await client.attach(
      session.sessionId,
      this.target.ownerId,
      this.target.routeId,
      cwd,
      this.target.attachmentToken,
      file,
    );
    this.check();
    if (!client.isAttached || session.sessionFile !== file)
      throw new Error("Pi session did not attach to its saved file");
    return { sessionId: session.sessionId, sessionFile: file };
  }

  private captureConnection(): ToolConnection & ThreadToolConnection {
    const client = this.client;
    if (!client || !this.current()) throw new Error("Pi bridge is not attached");
    const check = (): void => {
      if (!this.current() || this.client !== client) throw new Error("Pi bridge is not attached");
    };
    check();
    return {
      check,
      request: async (operation, body, signal) => {
        check();
        const result = await client.request(operation, body, signal);
        check();
        return result;
      },
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
    if (!this.session) return;
    this.track(this.delivery.receive(prompt, this.session.extensionRunner.createContext()));
  }

  private onEvent(event: AgentSessionEvent): void {
    if (!this.current() || !this.session) return;
    const ctx = this.session.extensionRunner.createContext();
    if (event.type === "message_start") this.delivery.messageStart(event.message, ctx);
    else if (event.type === "message_update") this.delivery.messageUpdate(event.message, ctx);
    else if (event.type === "message_end") this.delivery.messageEnd(event.message, ctx);
    else if (event.type === "agent_settled") this.delivery.agentSettled(ctx);
    this.inbox.schedule(ctx);
  }

  private async request(request: AgentRequest): Promise<unknown> {
    if (!this.current() || !this.session) throw new Error("Pi session is closed");
    const session = this.session;
    if (request.operation === "peek") {
      const body = v.parse(AgentOperationBodies.peek, request.body);
      return this.peek(body.limit, body.before);
    }
    const ctx = session.extensionRunner.createContext();
    return handleBotRequest(request, {
      ctx,
      busy: () => this.mutating || session.isCompacting,
      getThinkingLevel: () => session.thinkingLevel,
      setThinkingLevel: (level) => {
        session.setThinkingLevel(level);
        return session.thinkingLevel;
      },
      setModel: async (model) => {
        await session.setModel(model);
        this.configureDefaultCompaction();
        return true;
      },
      compact: async () => {
        await session.compact();
        return true;
      },
      mutate: async (operation) => {
        this.mutating = true;
        try {
          return await operation();
        } finally {
          this.mutating = false;
          if (this.current()) this.inbox.schedule(ctx);
        }
      },
      abort: async () => {
        const pending = this.delivery.cancelPending(ctx);
        const running = !session.isIdle || this.mutating;
        session.clearQueue();
        await session.abort();
        if (this.current()) this.inbox.resume(ctx);
        return pending || running;
      },
      newSession: () => false,
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.lifetime.abort();
    this.delivery.stop();
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
