import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Container } from "../agent-bridge/domain.ts";
import type { Store } from "../agent-bridge/store.ts";

export function projectSpaceKey(container: Container): string {
  return [container.platform, container.spaceId, container.channelId].map(encodeURIComponent).join("/");
}

export const HELP = `Plain messages go to Main. Reply to a tracked message to continue that thread.
/bind <directory> binds this space (including DMs) to a project. Owners only.
/unbind disables this space; saved thread history is kept.
/new [request] creates a separate saved thread, without replacing Main.
/threads lists Main and sibling threads with their state.
/status, /model, /thinking, /compact and /stop target Main, or the thread you reply to. Session owner only.
/where shows the project and space key. /help shows these commands.
Terminal sessions in the project join as saved threads automatically; no attach/detach workflow.`;
export type Command =
  | { kind: "bind"; directory: string }
  | { kind: "unbind" }
  | { kind: "where" }
  | { kind: "help" }
  | { kind: "threads" }
  | { kind: "new"; request: string };

export function parseCommand(name: string, argument: string): Command | null {
  switch (name) {
    case "bind":
      return { kind: "bind", directory: argument };
    case "unbind":
      return { kind: "unbind" };
    case "where":
      return { kind: "where" };
    case "start":
    case "help":
      return { kind: "help" };
    case "new":
      return { kind: "new", request: argument };
    case "threads":
      return { kind: "threads" };
    default:
      return null;
  }
}

/** Resolves a directory without shell expansion or reading its contents. Owners only. */
export function projectDirectory(input: string): string {
  let path = input.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1);
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
  if (!isAbsolute(path)) throw new Error("Use an absolute directory or a path starting with ~/.");
  try {
    const directory = realpathSync(path);
    if (statSync(directory).isDirectory()) return directory;
  } catch {}
  throw new Error("That directory does not exist or is not accessible on the bridge host.");
}

export class Control {
  constructor(readonly store: Store) {}

  execute({ container, owner, command }: { container: Container; owner: boolean; command: Command }): string {
    switch (command.kind) {
      case "help":
        return HELP;
      case "threads":
        return "No project threads are available.";
      case "new":
        return "Mention the bot with your request to start a new conversation.";
      case "where": {
        const id = this.store.binding(container);
        return `Space: ${projectSpaceKey(container)}\nDirectory: ${id ? this.store.project(id)?.directory : "unbound, inactive"}`;
      }
      case "unbind": {
        if (!owner) return "Only configured bot owners can change bindings.";
        this.store.unbind(container);
        return "Unbound. This topic is inactive. Task history is retained.";
      }
      case "bind": {
        if (!owner) return "Only configured bot owners can change bindings.";
        try {
          const directory = projectDirectory(command.directory);
          return this.store.atomic(() => {
            const project = this.store.registerProject(directory);
            this.store.bind({ container, projectId: project.id });
            return `Bound to ${directory}. Send a message for Main, or /new [request] for a separate thread.`;
          });
        } catch (error) {
          return error instanceof Error ? error.message : "Could not bind topic";
        }
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }
}
