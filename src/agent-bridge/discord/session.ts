import { randomUUID } from "node:crypto";
import type { ThreadSession } from "../../bot/runtime.ts";
import type { Task } from "../domain.ts";
import type { AgentPort } from "../frontend.ts";
import type { AgentOutput, PreparedPrompt } from "../protocol.ts";
import type { DiscordTransport } from "./transport.ts";

/** Structural ThreadSession for the shared BotRuntime. This is not a second thread runtime. */
export class DiscordSession implements ThreadSession {
  private closed = false;
  private active = false;
  private readonly prompts = new Set<string>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly agent: AgentPort,
    private readonly task: Task,
    private readonly transport: DiscordTransport,
    private readonly current: () => boolean,
    private readonly report: (error: Error) => void = () => {},
  ) {}
  get isLive(): boolean {
    return !this.closed && this.agent.current() && this.current();
  }
  get isRunning(): boolean {
    return this.active || this.prompts.size > 0;
  }
  receivePrepared(content: PreparedPrompt["content"]): void {
    if (!this.isLive) throw new Error("Discord thread is no longer current.");
    const id = randomUUID();
    this.prompts.add(id);
    try {
      this.agent.prompt({ id, content });
    } catch (error) {
      this.prompts.delete(id);
      throw error;
    }
  }
  output(event: AgentOutput): void {
    if (!this.isLive) return;
    switch (event.type) {
      case "run-state":
        this.active = event.running;
        break;
      case "turn-start":
        if (!this.prompts.delete(event.turnId)) throw new Error("Unknown Discord turn.");
        this.active = true;
        break;
      case "delivery-error":
        if (this.prompts.delete(event.turnId)) this.report(new Error(event.error));
        break;
      case "settled":
        this.active = false;
        if (event.error) this.report(new Error(event.error));
        break;
      case "text-start":
      case "text-update":
      case "text-end":
        // Saved assistant text (including errors) is private. Publication is explicit reply_message.
        break;
    }
  }
  async sendAttachment(body: { path: string; fileName: string }, signal: AbortSignal): Promise<void> {
    if (!this.isLive) throw new Error("Discord thread is no longer current.");
    await this.transport.sendAttachment(this.task, body, AbortSignal.any([signal, this.lifetime.signal]));
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.active = false;
    this.prompts.clear();
  }
}
