import type { TelegramClient } from "./client.ts";
import { MAX_MESSAGE_LENGTH, PREVIEW_THROTTLE_MS, TELEGRAM_DRAFT_ID_MAX } from "./constants.ts";
import type { TelegramSentMessage } from "./types.ts";

interface PreviewState {
  mode: "draft" | "message";
  draftId?: number;
  messageId?: number;
  pendingText: string;
  lastSentText: string;
  flushTimer?: ReturnType<typeof setTimeout>;
}

export class TelegramPreview {
  private state?: PreviewState;
  private draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
  private nextDraftId = 0;

  constructor(private readonly client: TelegramClient) {}

  start(): void {
    this.state = {
      mode: this.draftSupport === "unsupported" ? "message" : "draft",
      pendingText: "",
      lastSentText: "",
    };
  }

  update(text: string): void {
    if (!this.state) this.start();
    if (this.state) this.state.pendingText = text;
  }

  hasContent(): boolean {
    return Boolean(this.state && (this.state.pendingText.trim() || this.state.lastSentText.trim()));
  }

  schedule(chatId: number, onError: (error: unknown) => void): void {
    if (!this.state || this.state.flushTimer) return;
    this.state.flushTimer = setTimeout(() => {
      void this.flush(chatId).catch(onError);
    }, PREVIEW_THROTTLE_MS);
  }

  async clear(chatId: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    this.state = undefined;
    if (state.mode === "draft" && state.draftId !== undefined) {
      try {
        await this.client.call("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
      } catch {
        // Draft cleanup is best-effort.
      }
    }
  }

  async finalize(chatId: number): Promise<boolean> {
    const state = this.state;
    if (!state) return false;
    await this.flush(chatId);
    const finalText = (state.pendingText.trim() || state.lastSentText).trim();
    if (!finalText) {
      await this.clear(chatId);
      return false;
    }
    if (state.mode === "draft") {
      await this.client.call<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: finalText });
      await this.clear(chatId);
      return true;
    }
    this.state = undefined;
    return state.messageId !== undefined;
  }

  private allocateDraftId(): number {
    this.nextDraftId = this.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : this.nextDraftId + 1;
    return this.nextDraftId;
  }

  private async flush(chatId: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    state.flushTimer = undefined;
    const text = state.pendingText.trim();
    if (!text || text === state.lastSentText) return;
    const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

    if (this.draftSupport !== "unsupported") {
      const draftId = state.draftId ?? this.allocateDraftId();
      state.draftId = draftId;
      try {
        await this.client.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
        this.draftSupport = "supported";
        state.mode = "draft";
        state.lastSentText = truncated;
        return;
      } catch {
        this.draftSupport = "unsupported";
      }
    }

    if (state.messageId === undefined) {
      const sent = await this.client.call<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
      state.messageId = sent.message_id;
      state.mode = "message";
      state.lastSentText = truncated;
      return;
    }
    await this.client.call("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
    state.mode = "message";
    state.lastSentText = truncated;
  }
}
