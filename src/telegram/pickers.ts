import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramClient } from "./client.ts";
import type { TelegramCallbackQuery, TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup } from "./types.ts";

const CALLBACK_PREFIX = "pi:";
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
    private readonly pi: ExtensionAPI,
    private readonly client: TelegramClient,
  ) {}

  clear(): void {
    this.actions.clear();
  }

  async showModelPicker(chatId: number, ctx: ExtensionContext): Promise<void> {
    if (this.availableModels(ctx).length === 0) {
      await this.client.sendText(chatId, 0, "No authenticated models are available.");
      return;
    }
    const markup = this.buildModelRoot(ctx);
    await this.client.sendMenu(chatId, this.modelHeading(ctx), markup);
  }

  async showThinkingPicker(chatId: number, ctx: ExtensionContext): Promise<void> {
    await this.client.sendMenu(chatId, this.thinkingHeading(ctx), this.buildThinkingMenu(ctx));
  }

  async handleCallback(query: TelegramCallbackQuery, ctx: ExtensionContext): Promise<boolean> {
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

    if (!ctx.isIdle()) {
      await this.client.answerCallbackQuery(query.id, "Pi is busy. Try again when the current turn finishes.");
      return true;
    }

    if (action.type === "model-select") {
      const model = this.availableModels(ctx).find(
        (candidate) => candidate.provider === action.provider && candidate.id === action.modelId,
      );
      if (!model) {
        await this.client.answerCallbackQuery(query.id, "That model is no longer available.");
        return true;
      }
      const selected = await this.pi.setModel(model);
      if (!selected) {
        await this.client.answerCallbackQuery(query.id, "Authentication is not configured for that model.");
        return true;
      }
      await this.client.answerCallbackQuery(query.id, "Model changed.");
      await this.client.editMenu(
        message.chat.id,
        message.message_id,
        `Model: ${model.provider}/${model.id}\nThinking: ${this.pi.getThinkingLevel()}`,
        this.keyboard([[this.button("Choose thinking level", { type: "thinking-root" })]]),
      );
      return true;
    }

    this.pi.setThinkingLevel(action.level);
    const effectiveLevel = this.pi.getThinkingLevel();
    await this.client.answerCallbackQuery(query.id, `Thinking set to ${effectiveLevel}.`);
    await this.client.editMenu(
      message.chat.id,
      message.message_id,
      `${this.modelHeading(ctx)}\nThinking: ${effectiveLevel}`,
      this.keyboard([
        [this.button("Change thinking level", { type: "thinking-root" })],
        [this.button("Change model", { type: "model-root" })],
      ]),
    );
    return true;
  }

  private async showProviderPage(
    chatId: number,
    messageId: number,
    provider: string,
    requestedPage: number,
    ctx: ExtensionContext,
  ): Promise<void> {
    const models = this.availableModels(ctx).filter((model) => model.provider === provider);
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

    await this.client.editMenu(
      chatId,
      messageId,
      `Choose a ${provider} model (${page + 1}/${pageCount})`,
      this.keyboard(rows),
    );
  }

  private buildModelRoot(ctx: ExtensionContext): TelegramInlineKeyboardMarkup {
    const providers = [...new Set(this.availableModels(ctx).map((model) => model.provider))].sort();
    if (providers.length === 1) {
      const provider = providers[0];
      if (provider) {
        return this.keyboard([[this.button(provider, { type: "model-provider", provider, page: 0 })]]);
      }
    }
    return this.keyboard(
      this.rowsOf(
        providers.map((provider) =>
          this.button(this.truncate(provider, 48), { type: "model-provider", provider, page: 0 }),
        ),
        2,
      ),
    );
  }

  private buildThinkingMenu(ctx: ExtensionContext): TelegramInlineKeyboardMarkup {
    const levels = ctx.model ? (getSupportedThinkingLevels(ctx.model) as ThinkingLevel[]) : ["off" as ThinkingLevel];
    const current = this.pi.getThinkingLevel();
    return this.keyboard(
      this.rowsOf(
        levels.map((level) =>
          this.button(`${level === current ? "✓ " : ""}${level}`, { type: "thinking-select", level }),
        ),
        2,
      ),
    );
  }

  private availableModels(ctx: ExtensionContext): Model<Api>[] {
    const models = ctx.scopedModels.length
      ? ctx.scopedModels.map((entry) => entry.model)
      : ctx.modelRegistry.getAvailable();
    return [...models].sort((left, right) =>
      `${left.provider}/${left.name || left.id}`.localeCompare(`${right.provider}/${right.name || right.id}`),
    );
  }

  private modelHeading(ctx: ExtensionContext): string {
    return ctx.model
      ? `Current model: ${ctx.model.provider}/${ctx.model.id}\nChoose a provider:`
      : "Choose a provider:";
  }

  private thinkingHeading(ctx: ExtensionContext): string {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
    return `Model: ${model}\nCurrent thinking: ${this.pi.getThinkingLevel()}`;
  }

  private isCurrentModel(model: Model<Api>, ctx: ExtensionContext): boolean {
    return ctx.model?.provider === model.provider && ctx.model.id === model.id;
  }

  private button(text: string, action: PickerAction): TelegramInlineKeyboardButton {
    this.pruneActions();
    const id = (++this.nextActionId).toString(36);
    this.actions.set(id, { action, expiresAt: Date.now() + PICKER_TTL_MS });
    return { text, callback_data: `${CALLBACK_PREFIX}${id}` };
  }

  private keyboard(inline_keyboard: TelegramInlineKeyboardButton[][]): TelegramInlineKeyboardMarkup {
    return { inline_keyboard };
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
