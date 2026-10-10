import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { type IncomingMessage, type RouteResult, type Task, TaskIdSchema } from "./domain.ts";
import type { Store } from "./store.ts";

export class Router {
  constructor(readonly store: Store) {}

  route(message: IncomingMessage): RouteResult {
    return this.store.atomic(() => {
      const projectId = this.store.binding(message.container);
      if (!projectId || !this.store.project(projectId)) return { kind: "ignored", reason: "unbound" };
      const seen = this.store.taskForMessage({
        container: message.container,
        messageId: message.id,
      });
      if (seen) return { kind: "duplicate", task: seen };
      let task: Task | null;
      let created = false;
      switch (message.route.kind) {
        case "start": {
          const rootId = message.route.rootId;
          // A re-mention inside a mapped reply chain continues that independent session.
          task = message.route.parentId
            ? this.store.taskForMessage({ container: message.container, messageId: message.route.parentId })
            : null;
          task ??= this.store.taskForRoot({ container: message.container, rootId });
          if (!task) {
            task = {
              id: v.parse(TaskIdSchema, `task_${randomUUID()}`),
              projectId,
              container: message.container,
              rootId,
              title: message.text.trim().slice(0, 120) || "Untitled task",
              createdAt: new Date().toISOString(),
            };
            this.store.createTask(task);
            created = true;
          }
          break;
        }
        case "reply":
          task = this.store.taskForMessage({
            container: message.container,
            messageId: message.route.parentId,
          });
          break;
        case "thread":
          task = this.store.taskForRoot({
            container: message.container,
            rootId: message.route.threadId,
          });
          break;
        case "ignore":
          return { kind: "ignored", reason: "chatter" };
        default: {
          const exhaustive: never = message.route;
          return exhaustive;
        }
      }
      if (!task) return { kind: "ignored", reason: "chatter" };
      if (task.projectId !== projectId) return { kind: "ignored", reason: "project-changed" };
      this.store.mapMessage({
        container: message.container,
        messageId: message.id,
        taskId: task.id,
      });
      const input = this.store.recordInput({
        task,
        messageId: message.id,
        authorId: message.authorId,
        text: message.text,
      });
      return { kind: "routed", task, input, created };
    });
  }
}
