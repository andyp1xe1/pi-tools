import type { TelegramClient } from "./client.ts";
import { PREVIEW_THROTTLE_MS } from "./constants.ts";
import { TelegramError } from "./errors.ts";
import { chunkParagraphs } from "./messages.ts";

interface PreviewState {
  messages: Array<{ id: number; text: string }>;
  pendingText: string;
  lastSentText: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  scheduled: boolean;
  closed: boolean;
  creationUnknown: boolean;
}

/** One assistant message, streamed into stable Telegram bubbles. No ephemeral drafts. */
export class TelegramPreview {
  private state?: PreviewState;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(private readonly client: TelegramClient) {}

  start(): void {
    if (this.state) this.close(this.state);
    this.state = {
      messages: [],
      pendingText: "",
      lastSentText: "",
      scheduled: false,
      closed: false,
      creationUnknown: false,
    };
  }

  update(text: string): void {
    if (this.state) this.state.pendingText = text;
  }

  schedule(chatId: number, onError: (error: unknown) => void): void {
    const state = this.state;
    if (!state || state.closed || state.scheduled || state.creationUnknown) return;
    state.scheduled = true;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      void this.enqueue(async () => {
        if (!state.closed) await this.flush(chatId, state);
      }).then(
        () => {
          state.scheduled = false;
          if (!state.closed && state.pendingText.trim() !== state.lastSentText) this.schedule(chatId, onError);
        },
        (error) => {
          state.scheduled = false;
          onError(error);
        },
      );
    }, PREVIEW_THROTTLE_MS);
  }

  // Sends and edits must complete in order, including across assistant messages.
  // Closing a state cancels queued previews, but waits for an in-flight send.
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => undefined);
    return result;
  }

  private close(state: PreviewState): void {
    state.closed = true;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    if (this.state === state) this.state = undefined;
  }

  finalize(chatId: number): Promise<void> {
    const state = this.state;
    if (!state) return this.waitForIdle();
    this.close(state);
    return this.enqueue(() => this.flush(chatId, state));
  }

  waitForIdle(): Promise<void> {
    return this.operations.then(() => undefined);
  }

  stop(): Promise<void> {
    if (this.state) this.close(this.state);
    return this.waitForIdle();
  }

  private async flush(chatId: number, state: PreviewState): Promise<void> {
    const text = state.pendingText.trim();
    if (!text || text === state.lastSentText || state.creationUnknown) return;
    const chunks = chunkParagraphs(text);
    for (const [index, chunk] of chunks.entries()) {
      const existing = state.messages[index];
      if (!existing) {
        try {
          const sent = await this.client.call("sendMessage", { chat_id: chatId, text: chunk });
          state.messages.push({ id: sent.message_id, text: chunk });
        } catch (error) {
          if (!(error instanceof TelegramError)) state.creationUnknown = true;
          throw error;
        }
      } else if (chunk !== existing.text) {
        await this.client.call("editMessageText", { chat_id: chatId, message_id: existing.id, text: chunk });
        existing.text = chunk;
      }
    }
    state.lastSentText = text;
  }
}
