import * as v from "valibot";
import type { IncomingMessage, RouteResult, Task } from "../agent-bridge/domain.ts";
import { ThinkingLevelSchema } from "../agent-bridge/protocol.ts";
import { Router } from "../agent-bridge/router.ts";
import type { BridgeServer } from "../agent-bridge/server.ts";
import { Control, parseCommand } from "./commands.ts";
import type { BotRuntime } from "./runtime.ts";

export const SESSION_COMMANDS = ["model", "thinking", "status", "compact", "stop"] as const;
export function isSessionCommand(name: string): boolean {
  return SESSION_COMMANDS.some((command) => command === name);
}
export interface CommandDispatch {
  result: RouteResult | null;
  reply: string | null;
  empty: boolean;
  control: boolean;
}

/** Shared admission/targeting and project commands; media and UI controls remain adapter concerns. */
export class BotCommandService {
  private readonly router: Router;
  private readonly control: Control;
  constructor(readonly runtime: BotRuntime) {
    this.router = new Router(runtime.store);
    this.control = new Control(runtime.store);
  }
  dispatch(message: IncomingMessage, token: { name: string; argument: string } | null): CommandDispatch {
    const { store } = this.runtime;
    const command = token ? parseCommand(token.name, token.argument) : null;
    const control = !!token && isSessionCommand(token.name);
    const owner = this.runtime.options.ownerIds.includes(message.authorId);
    const response = (reply: string): CommandDispatch => ({ result: null, reply, empty: false, control });
    if (command?.kind === "threads") return response(this.overview(message));
    if (command && command.kind !== "new") {
      const before = store.binding(message.container);
      const reply = this.control.execute({ container: message.container, owner, command });
      if (
        owner &&
        (command.kind === "unbind" || (command.kind === "bind" && before !== store.binding(message.container)))
      ) {
        for (const task of store.tasksFor(message.container)) void this.runtime.cancelSession(task.id).catch(() => {});
      }
      return response(command.kind === "where" ? `${reply}\nYour user ID: ${message.authorId}` : reply);
    }
    if (token && !command && !control) return response("Unknown command. Use /help to see available commands.");
    if (control && !owner) return response("Only configured bot owners can control sessions.");
    if (command?.kind === "new") {
      message.route = { kind: "start", rootId: message.id };
      message.text = command.request;
    } else if (message.route.kind === "ignore") message.route = { kind: "default" };
    if (control && message.route.kind === "default") {
      const main = store.defaultTask(message.container);
      if (!main)
        return response(
          store.binding(message.container)
            ? "No Main thread yet. Send a message first."
            : "No project is bound. Use /bind <directory> first.",
        );
      message.route = { kind: "thread", threadId: main.rootId };
    }
    const result = this.router.route(message);
    if (result.kind === "ignored")
      return {
        result,
        reply:
          result.reason === "unbound"
            ? "No project is bound. Use /bind <directory> first."
            : "This target is not linked to this project's saved threads. Reply to a tracked message or use /new.",
        empty: false,
        control,
      };
    if (result.kind === "routed" && control && this.runtime.ownerForTask(result.task) !== message.authorId)
      return response("Only the saved session owner can control this thread.");
    if (result.kind === "routed" && control && token?.name === "stop") {
      const queued = this.runtime.hasPendingInputs(result.task.id);
      this.runtime.cancelPendingInputs(result.task.id);
      const live = this.runtime.server?.attachment(result.task.id)?.frontend;
      if (!this.runtime.session(live) || !live.isLive) {
        const pending = this.runtime.starts.get(result.task.id)?.pending || queued;
        if (pending) void this.runtime.cancelSession(result.task.id).catch(() => {});
        return response(pending ? "Aborted current turn." : "No active turn.");
      }
    }
    return { result, reply: null, empty: command?.kind === "new" && !message.text, control };
  }
  overview(message: Pick<IncomingMessage, "container">): string {
    const { store, server } = this.runtime;
    const projectId = store.binding(message.container);
    if (!projectId) return "No project is bound. Use /bind <directory> first.";
    const tasks = store.threadPage(message.container, projectId, 50);
    if (!tasks.length) return "No threads yet. Send a message to start Main.";
    return tasks
      .map((task) => {
        const session = server?.attachment(task.id)?.frontend;
        const state = this.runtime.closingThreads.has(task.id)
          ? "stopped"
          : this.runtime.starts.get(task.id)?.pending
            ? "starting"
            : this.runtime.session(session) && session.isLive
              ? session.isRunning
                ? "running"
                : "idle"
              : store.visibleWriter(task.id)
                ? "unconfirmed"
                : "stopped";
        return `${store.threadSettings(task).isDefault ? "Main" : task.title} · ${state}\n${task.id}`;
      })
      .join("\n\n")
      .slice(0, 3900);
  }
}

/** Text-mode session controls for transports without a picker UI. No implicit targeting here. */
export async function executeSessionControl(
  runtime: BotRuntime,
  task: Task,
  name: string,
  argument: string,
  authorId: string,
): Promise<string> {
  if (!isSessionCommand(name)) throw new Error("Unknown session command.");
  if (!runtime.options.ownerIds.includes(authorId) || runtime.ownerForTask(task) !== authorId)
    return "Only this session's configured owner can control it.";
  const live = await runtime.ensureSession(task);
  const server = runtime.server;
  if (!server) throw new Error("No session host is connected.");
  const peer = server.attachment(task.id);
  const generation = runtime.threadGeneration(task.id);
  const check = () => {
    if (
      runtime.closed() ||
      runtime.threadGeneration(task.id) !== generation ||
      runtime.ownerForTask(task) !== authorId ||
      !peer ||
      peer.frontend !== live ||
      !live.isLive ||
      server.attachment(task.id) !== peer ||
      runtime.store.binding(task.container) !== task.projectId
    )
      throw new Error("The saved session writer changed during this control.");
  };
  const call: Pick<BridgeServer, "inspectAgent"> = {
    inspectAgent(routeId, operation, body) {
      check();
      return server.inspectAgent(routeId, operation, body).then((result) => {
        check();
        return result;
      });
    },
  };
  switch (name) {
    case "status":
      return (await call.inspectAgent(task.id, "snapshot")).status;
    case "stop":
      return (await call.inspectAgent(task.id, "abort")) ? "Aborted current turn." : "No active turn.";
    case "compact":
      return (await call.inspectAgent(task.id, "compact"))
        ? "Compaction completed."
        : "Cannot compact while the agent is busy.";
    case "model": {
      const snapshot = await call.inspectAgent(task.id, "snapshot");
      if (!argument) return snapshot.models.map((model) => `${model.provider}/${model.id}`).join("\n");
      const model = snapshot.models.find((model) => `${model.provider}/${model.id}` === argument);
      if (!model) return "Unknown model. Use /model to list available models.";
      return (await call.inspectAgent(task.id, "setModel", model))
        ? `Model: ${argument}`
        : "Cannot change model while the agent is busy.";
    }
    case "thinking": {
      if (!argument) return `Thinking: ${(await call.inspectAgent(task.id, "snapshot")).thinking}`;
      const parsed = v.safeParse(ThinkingLevelSchema, argument);
      if (!parsed.success) return "Unknown thinking level.";
      return `Thinking: ${await call.inspectAgent(task.id, "setThinking", { level: parsed.output })}`;
    }
    default:
      throw new Error("Unknown session command.");
  }
}
