import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Container } from "./domain.ts";
import type { Store } from "./store.ts";

export const HELP = `Mention the bot with a request to start a saved Pi conversation. Reply to continue it.
/bind <directory> enables this chat/topic for that project. Bot owners only.
/unbind stops its sessions and disables this chat/topic; history is kept.
/new [request] starts a separate conversation; it never erases the old one.
/status shows the project and sessions, or the session you reply to.
/model, /thinking, /compact and /stop control the conversation you reply to (or the only active one). Attachment owner only.
/where shows the project binding. /help shows these commands.
Sessions start automatically; no Pi terminal attachment is required.`;
export type Command =
  | { kind: "bind"; directory: string }
  | { kind: "unbind" }
  | { kind: "where" }
  | { kind: "help" }
  | { kind: "release" }
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
    case "release":
      return { kind: "release" };
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
      case "release":
        return "Reply to a tracked thread to release its Pi session association.";
      case "new":
        return "Mention the bot with your request to start a new conversation.";
      case "where": {
        const id = this.store.binding(container);
        return `Community: ${container.spaceId}\nTopic: ${container.channelId}\nDirectory: ${id ? this.store.project(id)?.directory : "unbound, inactive"}`;
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
            return `Bound to ${directory}. Mention the bot with a request; a saved Pi session starts automatically.`;
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
