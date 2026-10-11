import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBotTurnId, type PendingBotTurn } from "./messages.ts";

export interface BotSubmission {
  isCurrent(): boolean;
  emit(send: () => void): void;
}
interface Submission {
  turn: PendingBotTurn;
  emitted: boolean;
}
interface InboxOptions {
  ready(ctx: ExtensionContext): boolean;
  submit(turn: PendingBotTurn, ctx: ExtensionContext, submission: BotSubmission): Promise<void> | void;
  changed(ctx: ExtensionContext): void;
  failed(turn: PendingBotTurn, ctx: ExtensionContext, error: unknown): void;
}

/** FIFO with one submission awaiting message_start acknowledgement. */
export class BotInbox {
  private readonly pending: { turn?: PendingBotTurn }[] = [];
  private submitted?: Submission;
  private timer?: ReturnType<typeof setTimeout>;
  private paused = false;

  constructor(private readonly options: InboxOptions) {}

  get isPaused(): boolean {
    return this.paused;
  }

  get count(): number {
    return this.pending.length;
  }

  reserve(ctx: ExtensionContext): { complete(turn: PendingBotTurn): void; cancel(): void } {
    const slot: { turn?: PendingBotTurn } = {};
    this.pending.push(slot);
    this.options.changed(ctx);
    return {
      complete: (turn) => {
        if (!this.pending.includes(slot) || slot.turn) return;
        slot.turn = turn;
        this.options.changed(ctx);
        this.deliverNext(ctx);
      },
      cancel: () => {
        const index = this.pending.indexOf(slot);
        if (index < 0 || (this.submitted && this.submitted.turn === slot.turn)) return;
        this.pending.splice(index, 1);
        this.options.changed(ctx);
        this.deliverNext(ctx);
      },
    };
  }

  take(message: AgentMessage, ctx: ExtensionContext): PendingBotTurn | undefined {
    const turn = this.submitted?.turn;
    if (!this.submitted?.emitted || !turn || getBotTurnId(message) !== turn.id) return;
    this.pending.shift();
    this.submitted = undefined;
    this.schedule(ctx);
    this.options.changed(ctx);
    return turn;
  }

  rejectUnacknowledged(ctx: ExtensionContext): void {
    const submission = this.submitted;
    // An earlier run can settle while authentication is still in flight.
    if (submission?.emitted)
      this.rejectSubmission(submission, ctx, new Error("Pi settled without acknowledging bot input"));
  }

  private rejectSubmission(submission: Submission, ctx: ExtensionContext, error: unknown): void {
    if (this.submitted !== submission) return;
    this.submitted = undefined;
    this.pending.shift();
    this.options.failed(submission.turn, ctx, error);
    this.options.changed(ctx);
    this.schedule(ctx);
  }

  // Never submit inside compaction/message lifecycle hooks. A timer lets pi
  // finish clearing its busy state first; ready() also covers pre-hook windows.
  schedule(ctx: ExtensionContext): void {
    if (this.paused || this.timer || !this.pending[0]?.turn || this.submitted) return;
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
    const turn = this.pending[0]?.turn;
    if (this.paused || !turn || this.submitted) return;
    if (!this.options.ready(ctx)) {
      this.schedule(ctx);
      return;
    }
    // Submission success is not acknowledgement. A ticket also fences delayed
    // rejection after acknowledgement, stop, or reuse of the same turn object.
    const submission: Submission = { turn, emitted: false };
    this.submitted = submission;
    const rejected = (error: unknown): void => this.rejectSubmission(submission, ctx, error);
    const lease: BotSubmission = {
      isCurrent: () => this.submitted === submission,
      emit: (send) => {
        if (this.submitted !== submission) return;
        submission.emitted = true;
        send();
      },
    };
    try {
      const result = this.options.submit(turn, ctx, lease);
      if (result) void result.catch(rejected);
    } catch (error) {
      rejected(error);
    }
  }
}
