import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentOutput, PreparedPrompt } from "../agent-bridge/protocol.ts";
import { BotInbox, type BotSubmission } from "./inbox.ts";
import { BOT_MESSAGE_TYPE, getBotTurnId, getMessageText, type PendingBotTurn, preparePrompt } from "./messages.ts";

interface DeliveryOptions {
  current(): boolean;
  ready(ctx: ExtensionContext): boolean;
  send(message: Parameters<ExtensionAPI["sendMessage"]>[0]): Promise<void> | void;
  output(event: AgentOutput, ctx: ExtensionContext): void;
  changed(ctx: ExtensionContext): void;
  prepare?: typeof preparePrompt;
  track?(operation: Promise<void>): Promise<void>;
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Shared bot input, acknowledgement and output attribution; hosts only own SDK lifecycle. */
export class BotDelivery {
  readonly inbox: BotInbox;
  private readonly preparations = new Map<string, AbortController>();
  private readonly waiting = new Set<string>();
  activeTurnId?: string;
  private assistantError?: string;

  constructor(private readonly options: DeliveryOptions) {
    this.inbox = new BotInbox({
      ready: (ctx) => options.current() && options.ready(ctx),
      submit: (turn, ctx, lease) => {
        const pending = this.submit(turn, ctx, lease);
        return options.track ? options.track(pending) : pending;
      },
      changed: options.changed,
      failed: (turn, ctx, error) => this.failed(turn.id, ctx, error),
    });
    this.inbox.pause();
  }

  private output(event: AgentOutput, ctx: ExtensionContext): void {
    if (this.options.current()) this.options.output(event, ctx);
  }
  private failed(id: string, ctx: ExtensionContext, error: unknown): void {
    this.waiting.delete(id);
    this.output({ type: "delivery-error", turnId: id, error: errorText(error) }, ctx);
  }

  async receive(prompt: PreparedPrompt, ctx: ExtensionContext): Promise<void> {
    if (!this.options.current()) return;
    if (this.waiting.has(prompt.id) || this.activeTurnId === prompt.id) {
      this.output({ type: "delivery-error", turnId: prompt.id, error: "Duplicate bot turn ID" }, ctx);
      return;
    }
    const slot = this.inbox.reserve(ctx);
    const controller = new AbortController();
    this.preparations.set(prompt.id, controller);
    this.waiting.add(prompt.id);
    try {
      const turn = await (this.options.prepare ?? preparePrompt)(prompt, controller.signal);
      if (controller.signal.aborted || !this.options.current()) slot.cancel();
      else slot.complete(turn);
    } catch (error) {
      slot.cancel();
      if (!controller.signal.aborted) this.failed(prompt.id, ctx, error);
    } finally {
      if (this.preparations.get(prompt.id) === controller) this.preparations.delete(prompt.id);
    }
  }

  private async submit(turn: PendingBotTurn, ctx: ExtensionContext, lease: BotSubmission): Promise<void> {
    const current = () => lease.isCurrent() && this.options.current();
    if (!current()) return;
    const model = ctx.model;
    if (!model) throw new Error("No model selected. Select a model before sending bot input.");
    const authenticated =
      ctx.modelRegistry.hasConfiguredAuth(model) ||
      (await ctx.modelRegistry.getProviderAuth(model.provider)) !== undefined;
    if (!current()) return;
    if (!authenticated) throw new Error(`No API key found for ${model.provider}. Use /login or configure an API key.`);
    let pending: Promise<void> | undefined;
    lease.emit(() => {
      pending =
        this.options.send({
          customType: BOT_MESSAGE_TYPE,
          content: turn.content,
          display: true,
          details: { turnId: turn.id },
        }) ?? undefined;
    });
    try {
      await pending;
    } catch (error) {
      if (this.options.current() && this.activeTurnId === turn.id) this.settled(ctx, errorText(error));
      throw error;
    }
  }

  messageStart(message: AgentMessage, ctx: ExtensionContext): void {
    if (!this.options.current()) return;
    const turn = this.inbox.take(message, ctx);
    if (turn) {
      this.waiting.delete(turn.id);
      this.activeTurnId = turn.id;
      this.assistantError = undefined;
      this.output({ type: "turn-start", turnId: turn.id }, ctx);
      this.options.changed(ctx);
    } else if (this.activeTurnId && (message.role === "user" || message.role === "custom")) {
      if (getBotTurnId(message) !== this.activeTurnId) this.settled(ctx);
    } else if (this.activeTurnId && message.role === "assistant") {
      this.assistantError = undefined;
      this.output({ type: "text-start" }, ctx);
    }
  }
  messageUpdate(message: AgentMessage, ctx: ExtensionContext): void {
    if (this.activeTurnId && message.role === "assistant")
      this.output({ type: "text-update", text: getMessageText(message) }, ctx);
  }
  messageEnd(message: AgentMessage, ctx: ExtensionContext): void {
    if (!this.options.current() || !this.activeTurnId || message.role !== "assistant") return;
    this.assistantError =
      message.stopReason === "error" || message.stopReason === "aborted"
        ? message.errorMessage || "Pi turn failed or was aborted"
        : undefined;
    this.output({ type: "text-end", text: getMessageText(message), error: this.assistantError }, ctx);
  }
  settled(ctx: ExtensionContext, error?: string): void {
    if (this.activeTurnId) this.output({ type: "settled", error }, ctx);
    this.activeTurnId = undefined;
    this.assistantError = undefined;
    this.options.changed(ctx);
  }
  agentSettled(ctx: ExtensionContext): void {
    this.settled(ctx, this.assistantError);
    this.inbox.rejectUnacknowledged(ctx);
    this.inbox.schedule(ctx);
  }

  /** Cancel preparation, preflight and unacknowledged steering, including while Pi is idle. */
  cancelPending(ctx: ExtensionContext, reason = "Bot input cancelled"): boolean {
    const pending = this.waiting.size > 0;
    for (const id of this.waiting) this.failed(id, ctx, new Error(reason));
    this.clearPending();
    return pending;
  }
  private clearPending(): void {
    for (const controller of this.preparations.values()) controller.abort();
    this.preparations.clear();
    this.waiting.clear();
    this.inbox.stop();
  }
  stop(): void {
    this.clearPending();
    this.activeTurnId = undefined;
    this.assistantError = undefined;
  }
}
