import type { AgentPort } from "../frontend.ts";
import type { AgentSnapshot, ThinkingLevel } from "../protocol.ts";
import type { TelegramClient } from "./client.ts";
import type { TelegramCallbackQuery, TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup } from "./schemas.ts";

type Model = AgentSnapshot["models"][number];

const CALLBACK_PREFIX = "bridge:";
const PICKER_TTL_MS = 15 * 60 * 1000;
const MODELS_PER_PAGE = 8;

type PickerAction =
  | { type: "model-root" }
  | { type: "model-provider"; provider: string; page: number }
  | { type: "model-select"; provider: string; modelId: string }
  | { type: "thinking-root" }
  | { type: "thinking-select"; level: ThinkingLevel };

interface StoredAction {
  action: PickerAction;
  expiresAt: number;
}

export class TelegramPickers {
  private readonly actions = new Map<string, StoredAction>();
  private nextActionId = 0;

  constructor(
    private readonly agent: AgentPort,
    private readonly client: TelegramClient,
  ) {}

  clear(): void {
    this.actions.clear();
  }

  async showModelPicker(chatId: number, replyToMessageId = 0): Promise<void> {
    const ctx = await this.agent.snapshot();
    if (!this.agent.current()) return;
    if (ctx.models.length === 0) {
      await this.client.sendText(chatId, replyToMessageId, "No authenticated models are available.");
      return;
    }
    const markup = this.buildModelRoot(ctx);
    await this.client.sendMenu(chatId, this.modelHeading(ctx), markup, replyToMessageId);
  }

  async showThinkingPicker(chatId: number, replyToMessageId = 0): Promise<void> {
    const ctx = await this.agent.snapshot();
    if (!this.agent.current()) return;
    await this.client.sendMenu(chatId, this.thinkingHeading(ctx), this.buildThinkingMenu(ctx), replyToMessageId);
  }

  async handleCallback(query: TelegramCallbackQuery): Promise<boolean> {
    const ctx = await this.agent.snapshot();
    if (!this.agent.current()) return true;
    if (!query.data?.startsWith(CALLBACK_PREFIX)) return false;
    const message = query.message;
    if (!message) {
      await this.client.answerCallbackQuery(query.id, "This menu is unavailable.");
      return true;
    }

    const stored = this.actions.get(query.data.slice(CALLBACK_PREFIX.length));
    if (!stored || stored.expiresAt < Date.now()) {
      await this.client.answerCallbackQuery(query.id, "This menu expired. Run the command again.");
      return true;
    }

    const { action } = stored;
    if (action.type === "model-root") {
      await this.client.answerCallbackQuery(query.id);
      await this.client.editMenu(message.chat.id, message.message_id, this.modelHeading(ctx), this.buildModelRoot(ctx));
      return true;
    }

    if (action.type === "model-provider") {
      await this.client.answerCallbackQuery(query.id);
      await this.showProviderPage(message.chat.id, message.message_id, action.provider, action.page, ctx);
      return true;
    }

    if (action.type === "thinking-root") {
      await this.client.answerCallbackQuery(query.id);
      await this.client.editMenu(
        message.chat.id,
        message.message_id,
        this.thinkingHeading(ctx),
        this.buildThinkingMenu(ctx),
      );
      return true;
    }

    if (!ctx.idle) {
      await this.client.answerCallbackQuery(query.id, "The agent is busy. Try again when the current turn finishes.");
      return true;
    }

    if (action.type === "model-select") {
      const model = ctx.models.find(
        (candidate) => candidate.provider === action.provider && candidate.id === action.modelId,
      );
      if (!model) {
        await this.client.answerCallbackQuery(query.id, "That model is no longer available.");
        return true;
      }
      const selected = await this.agent.setModel(model);
      if (!this.agent.current()) return true;
      if (!selected) {
        await this.client.answerCallbackQuery(query.id, "Authentication is not configured for that model.");
        return true;
      }
      await this.client.answerCallbackQuery(query.id, "Model changed.");
      await this.client.editMenu(
        message.chat.id,
        message.message_id,
        `Model: ${model.provider}/${model.id}\nThinking: ${(await this.agent.snapshot()).thinking}`,
        { inline_keyboard: [[this.button("Choose thinking level", { type: "thinking-root" })]] },
      );
      return true;
    }

    const effectiveLevel = await this.agent.setThinking(action.level);
    if (!this.agent.current()) return true;
    await this.client.answerCallbackQuery(query.id, `Thinking set to ${effectiveLevel}.`);
    await this.client.editMenu(
      message.chat.id,
      message.message_id,
      `${this.modelHeading(ctx)}\nThinking: ${effectiveLevel}`,
      {
        inline_keyboard: [
          [this.button("Change thinking level", { type: "thinking-root" })],
          [this.button("Change model", { type: "model-root" })],
        ],
      },
    );
    return true;
  }

  private async showProviderPage(
    chatId: number,
    messageId: number,
    provider: string,
    requestedPage: number,
    ctx: AgentSnapshot,
  ): Promise<void> {
    const models = ctx.models.filter((model) => model.provider === provider);
    const pageCount = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
    const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
    const pageModels = models.slice(page * MODELS_PER_PAGE, (page + 1) * MODELS_PER_PAGE);
    const rows = pageModels.map((model) => [
      this.button(`${this.isCurrentModel(model, ctx) ? "✓ " : ""}${this.truncate(model.name || model.id, 48)}`, {
        type: "model-select",
        provider: model.provider,
        modelId: model.id,
      }),
    ]);

    const navigation: TelegramInlineKeyboardButton[] = [];
    if (page > 0) navigation.push(this.button("‹ Previous", { type: "model-provider", provider, page: page - 1 }));
    if (page + 1 < pageCount)
      navigation.push(this.button("Next ›", { type: "model-provider", provider, page: page + 1 }));
    if (navigation.length) rows.push(navigation);
    rows.push([this.button("‹ Providers", { type: "model-root" })]);

    await this.client.editMenu(chatId, messageId, `Choose a ${provider} model (${page + 1}/${pageCount})`, {
      inline_keyboard: rows,
    });
  }

  private buildModelRoot(ctx: AgentSnapshot): TelegramInlineKeyboardMarkup {
    const providers = [...new Set(ctx.models.map((model) => model.provider))].sort();
    return {
      inline_keyboard: this.rowsOf(
        providers.map((provider) =>
          this.button(this.truncate(provider, 48), { type: "model-provider", provider, page: 0 }),
        ),
        2,
      ),
    };
  }

  private buildThinkingMenu(ctx: AgentSnapshot): TelegramInlineKeyboardMarkup {
    const levels = ctx.supportedThinking;
    const current = ctx.thinking;
    return {
      inline_keyboard: this.rowsOf(
        levels.map((level) =>
          this.button(`${level === current ? "✓ " : ""}${level}`, { type: "thinking-select", level }),
        ),
        2,
      ),
    };
  }

  private modelHeading(ctx: AgentSnapshot): string {
    return ctx.model
      ? `Current model: ${ctx.model.provider}/${ctx.model.id}\nChoose a provider:`
      : "Choose a provider:";
  }

  private thinkingHeading(ctx: AgentSnapshot): string {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
    return `Model: ${model}\nCurrent thinking: ${ctx.thinking}`;
  }

  private isCurrentModel(model: Model, ctx: AgentSnapshot): boolean {
    return ctx.model?.provider === model.provider && ctx.model.id === model.id;
  }

  private button(text: string, action: PickerAction): TelegramInlineKeyboardButton {
    this.pruneActions();
    const id = (++this.nextActionId).toString(36);
    this.actions.set(id, { action, expiresAt: Date.now() + PICKER_TTL_MS });
    if (this.actions.size > 4096) {
      const oldest = this.actions.keys().next().value;
      if (oldest !== undefined) this.actions.delete(oldest);
    }
    return { text, callback_data: `${CALLBACK_PREFIX}${id}` };
  }

  private rowsOf<T>(items: T[], width: number): T[][] {
    const rows: T[][] = [];
    for (let index = 0; index < items.length; index += width) rows.push(items.slice(index, index + width));
    return rows;
  }

  private pruneActions(): void {
    const now = Date.now();
    for (const [id, stored] of this.actions) if (stored.expiresAt < now) this.actions.delete(id);
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
  }
}
