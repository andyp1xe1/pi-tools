import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TEMP_DIR } from "./constants.ts";
import { guessImageMediaType, sanitizeFileName } from "./media.ts";
import { chunkParagraphs } from "./messages.ts";
import type {
  QueuedAttachment,
  TelegramApiResponse,
  TelegramConfig,
  TelegramFileResult,
  TelegramInlineKeyboardMarkup,
  TelegramSentMessage,
} from "./types.ts";

export interface TelegramCallOptions {
  signal?: AbortSignal;
  retries?: number;
}

class TelegramRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TelegramRequestError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TelegramClient {
  constructor(private readonly getConfig: () => TelegramConfig) {}

  private async request<TResponse>(
    method: string,
    init: RequestInit,
    options: TelegramCallOptions = {},
  ): Promise<TResponse> {
    const { botToken } = this.getConfig();
    if (!botToken) throw new Error("Telegram bot token is not configured");
    const retries = options.retries ?? 2;

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          ...init,
          signal: options.signal,
        });
        const data = (await response.json()) as TelegramApiResponse<TResponse>;
        if (!response.ok || !data.ok || data.result === undefined) {
          throw new TelegramRequestError(
            data.description || `Telegram API ${method} failed with HTTP ${response.status}`,
            response.status === 429 || response.status >= 500,
            data.parameters?.retry_after ? data.parameters.retry_after * 1000 : undefined,
          );
        }
        return data.result;
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) throw error;
        const retryable = !(error instanceof TelegramRequestError) || error.retryable;
        if (!retryable || attempt >= retries) throw error;
        const retryAfterMs = error instanceof TelegramRequestError ? error.retryAfterMs : undefined;
        await waitBeforeRetry(retryAfterMs ?? 500 * 2 ** attempt, options.signal);
      }
    }
  }

  async call<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramCallOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>(
      method,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      options,
    );
  }

  private async callMultipart<TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: TelegramCallOptions,
  ): Promise<TResponse> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const buffer = await readFile(filePath);
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(buffer);
    form.set(fileField, new Blob([bytes]), fileName);
    return this.request<TResponse>(method, { method: "POST", body: form }, options);
  }

  async registerCommands(
    commands: readonly { command: string; description: string }[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call<boolean>("setMyCommands", { commands, scope: { type: "all_private_chats" } }, { signal });
  }

  async downloadFile(fileId: string, suggestedName: string): Promise<string> {
    const { botToken } = this.getConfig();
    if (!botToken) throw new Error("Telegram bot token is not configured");
    const file = await this.call<TelegramFileResult>("getFile", { file_id: fileId });
    await mkdir(TEMP_DIR, { recursive: true });
    const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
        if (!response.ok) {
          throw new TelegramRequestError(
            `Failed to download Telegram file: HTTP ${response.status}`,
            response.status >= 500,
          );
        }
        await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
        return targetPath;
      } catch (error) {
        const retryable = !(error instanceof TelegramRequestError) || error.retryable;
        if (!retryable || attempt >= 2) throw error;
        await waitBeforeRetry(500 * 2 ** attempt);
      }
    }
  }

  async sendText(chatId: number, _replyToMessageId: number, text: string): Promise<number | undefined> {
    let lastMessageId: number | undefined;
    for (const chunk of chunkParagraphs(text)) {
      const sent = await this.call<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: chunk });
      lastMessageId = sent.message_id;
    }
    return lastMessageId;
  }

  async sendMenu(chatId: number, text: string, replyMarkup: TelegramInlineKeyboardMarkup): Promise<number> {
    const sent = await this.call<TelegramSentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    });
    return sent.message_id;
  }

  async editMenu(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    await this.call<TelegramSentMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async sendAttachment(chatId: number, attachment: QueuedAttachment, signal?: AbortSignal): Promise<void> {
    const mediaType = guessImageMediaType(attachment.path);
    await this.callMultipart<TelegramSentMessage>(
      mediaType ? "sendPhoto" : "sendDocument",
      { chat_id: String(chatId) },
      mediaType ? "photo" : "document",
      attachment.path,
      attachment.fileName,
      { signal },
    );
  }
}
