import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMessageText, isTelegramUserMessage } from "./messages.ts";
import type { PendingTelegramTurn } from "./types.ts";

interface InboxOptions {
  ready(ctx: ExtensionContext): boolean;
  submit(turn: PendingTelegramTurn): void;
  changed(ctx: ExtensionContext): void;
  failed(turn: PendingTelegramTurn, ctx: ExtensionContext, error: unknown): void;
}

/** FIFO with one submission awaiting message_start acknowledgement. */
export class TelegramInbox {
  private readonly pending: PendingTelegramTurn[] = [];
  private submitted?: PendingTelegramTurn;
  private timer?: ReturnType<typeof setTimeout>;
  private paused = false;

  constructor(private readonly options: InboxOptions) {}

  get isPaused(): boolean {
    return this.paused;
  }

  get count(): number {
    return this.pending.length;
  }

  enqueue(turn: PendingTelegramTurn, ctx: ExtensionContext): void {
    this.pending.push(turn);
    this.options.changed(ctx);
    this.deliverNext(ctx);
  }

  take(message: AgentMessage, ctx: ExtensionContext): PendingTelegramTurn | undefined {
    const turn = this.submitted;
    if (!turn || !isTelegramUserMessage(message)) return;
    const prompt = turn.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (getMessageText(message) !== prompt) return;
    this.pending.shift();
    this.submitted = undefined;
    this.schedule(ctx);
    this.options.changed(ctx);
    return turn;
  }

  // Never submit inside compaction/message lifecycle hooks. A timer lets pi
  // finish clearing its busy state first; ready() also covers pre-hook windows.
  schedule(ctx: ExtensionContext): void {
    if (this.paused || this.timer || !this.pending.length || this.submitted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.deliverNext(ctx);
    }, 50);
  }

  pause(): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  resume(ctx: ExtensionContext): void {
    this.paused = false;
    this.schedule(ctx);
  }

  stop(): void {
    this.pause();
    this.pending.length = 0;
    this.submitted = undefined;
  }

  private deliverNext(ctx: ExtensionContext): void {
    const turn = this.pending[0];
    if (this.paused || !turn || this.submitted) return;
    if (!this.options.ready(ctx)) {
      this.schedule(ctx);
      return;
    }
    // sendUserMessage is fire-and-forget: retain the item until message_start,
    // rather than treating its void return as successful delivery.
    this.submitted = turn;
    try {
      this.options.submit(turn);
    } catch (error) {
      this.submitted = undefined;
      this.pending.shift();
      this.options.failed(turn, ctx, error);
      this.options.changed(ctx);
      this.schedule(ctx);
    }
  }
}
