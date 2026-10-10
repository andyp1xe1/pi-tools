import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as v from "valibot";
import { transcribeAudio } from "../transcription.ts";
import { TelegramHttpClient } from "./api.ts";
import { TEMP_DIR } from "./constants.ts";
import { TelegramAttachmentError, TelegramDeliveryUnknown, TelegramError } from "./errors.ts";
import { guessImageMediaType, sanitizeFileName } from "./media.ts";
import { chunkParagraphs } from "./messages.ts";
import { type TelegramInlineKeyboardMarkup, type TelegramMethod, TelegramResultSchemas } from "./schemas.ts";

export interface TelegramConfig {
  botToken?: string;
}
export interface TelegramAttachment {
  path: string;
  fileName: string;
}

export interface TelegramCallOptions {
  signal?: AbortSignal;
  retries?: number;
}
export function isPollingConflict(error: unknown): boolean {
  return error instanceof TelegramError && error.code === 409;
}
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
async function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
let activeUploads = 0;
export interface TelegramSendScope {
  threadId?: number;
  replyToMessageId?: number;
  sent?(messageId: number): void;
}
export interface TelegramConversation extends Omit<TelegramSendScope, "replyToMessageId"> {
  chatId: number;
  current(): boolean;
  signal: AbortSignal;
  menu?(messageId: number): void;
}
export type TelegramTransport = Pick<TelegramClient, "call" | "downloadFile" | "transcribeAudio" | "sendAttachment">;
export class TelegramClient {
  private readonly http?: TelegramHttpClient;
  private readonly transport?: TelegramTransport;
  private readonly conversation?: TelegramConversation;
  constructor(getConfig: () => TelegramConfig, fetcher?: (url: string, init: RequestInit) => Promise<Response>);
  constructor(transport: TelegramTransport, conversation: TelegramConversation);
  constructor(
    source: (() => TelegramConfig) | TelegramTransport,
    options?: ((url: string, init: RequestInit) => Promise<Response>) | TelegramConversation,
  ) {
    if (typeof source === "function") {
      this.http = new TelegramHttpClient(
        () => source().botToken ?? "",
        typeof options === "function" ? options : undefined,
      );
    } else {
      this.transport = source;
      this.conversation = typeof options === "object" ? options : undefined;
    }
  }
  private check(): void {
    if (this.conversation && !this.conversation.current())
      throw new Error("Bot session detached or project binding changed");
    this.conversation?.signal.throwIfAborted();
  }
  private signal(signal?: AbortSignal): AbortSignal | undefined {
    return this.conversation
      ? signal
        ? AbortSignal.any([this.conversation.signal, signal])
        : this.conversation.signal
      : signal;
  }
  private sent(messageId: number, menu = false): void {
    this.check();
    this.conversation?.sent?.(messageId);
    if (menu) this.conversation?.menu?.(messageId);
  }
  async call<M extends TelegramMethod>(
    method: M,
    body: Record<string, unknown>,
    options: TelegramCallOptions = {},
  ): Promise<v.InferOutput<(typeof TelegramResultSchemas)[M]>> {
    this.check();
    const scope = this.conversation;
    if (scope && body.chat_id !== undefined && String(body.chat_id) !== String(scope.chatId))
      throw new Error("Wrong attachment destination");
    const creates = method === "sendMessage" || method === "sendPhoto" || method === "sendDocument";
    if (scope && body.chat_id !== undefined)
      body = {
        ...body,
        ...(scope.threadId === undefined ? {} : { message_thread_id: scope.threadId }),
      };
    options = { ...options, signal: this.signal(options.signal) };
    if (this.transport) {
      const result = await this.transport.call(method, body, options);
      this.check();
      if (
        creates &&
        typeof result === "object" &&
        result &&
        "message_id" in result &&
        typeof result.message_id === "number"
      )
        this.sent(result.message_id, !!body.reply_markup);
      return result;
    }
    if (!this.http) throw new Error("Missing Telegram HTTP transport");
    const schema = TelegramResultSchemas[method];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.http.call({ method, body, schema, signal: options.signal });
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) throw error;
        const retryable =
          !(error instanceof TelegramDeliveryUnknown) &&
          (!(error instanceof TelegramError) || error.code === 429 || error.code >= 500);
        if (!retryable || attempt >= (options.retries ?? 2)) throw error;
        await waitBeforeRetry(
          error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 500 * 2 ** attempt,
          options.signal,
        );
      }
    }
  }
  async registerCommands(
    commands: readonly { command: string; description: string }[],
    signal?: AbortSignal,
    scope: "all_private_chats" | "all_group_chats" = "all_private_chats",
  ): Promise<void> {
    await this.call("setMyCommands", { commands, scope: { type: scope } }, { signal });
  }
  async downloadFile(fileId: string, suggestedName: string, signal?: AbortSignal): Promise<string> {
    this.check();
    signal = this.signal(signal);
    if (this.transport) {
      const path = await this.transport.downloadFile(fileId, suggestedName, signal);
      this.check();
      return path;
    }
    if (!this.http) throw new Error("Missing Telegram HTTP transport");
    const file = await this.call("getFile", { file_id: fileId }, { signal });
    await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
    const target = join(TEMP_DIR, `${randomUUID()}-${sanitizeFileName(suggestedName)}`);
    await writeFile(target, Buffer.from(await this.http.download(file.file_path, signal)), { mode: 0o600 });
    return target;
  }
  async sendText(chatId: number, replyToMessageId: number, text: string): Promise<number | undefined> {
    let id: number | undefined;
    for (const chunk of chunkParagraphs(text))
      id = (
        await this.call("sendMessage", {
          chat_id: chatId,
          text: chunk,
          ...(replyToMessageId > 0
            ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: false } }
            : {}),
        })
      ).message_id;
    return id;
  }
  async sendMenu(
    chatId: number,
    text: string,
    replyMarkup: TelegramInlineKeyboardMarkup,
    replyToMessageId = 0,
  ): Promise<number> {
    return (
      await this.call("sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: replyMarkup,
        ...(replyToMessageId > 0
          ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: false } }
          : {}),
      })
    ).message_id;
  }
  async editMenu(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup });
  }
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }
  async transcribeAudio(path: string, model?: string, language?: string, signal?: AbortSignal): Promise<string> {
    this.check();
    signal = this.signal(signal);
    const result = await (this.transport
      ? this.transport.transcribeAudio(path, model, language, signal)
      : transcribeAudio(path, { model, language, signal }));
    this.check();
    return result;
  }
  async sendAttachment(
    chatId: number,
    attachment: TelegramAttachment,
    signal?: AbortSignal,
    destination?: TelegramSendScope,
  ): Promise<void> {
    this.check();
    signal = this.signal(signal);
    if (this.transport) {
      if (chatId !== this.conversation?.chatId) throw new Error("Wrong attachment destination");
      await this.transport.sendAttachment(chatId, attachment, signal, {
        threadId: this.conversation.threadId,
        replyToMessageId: destination?.replyToMessageId,
        sent: (id) => this.sent(id),
      });
      this.check();
      return;
    }
    if (!this.http) throw new Error("Missing Telegram HTTP transport");
    signal?.throwIfAborted();
    if (activeUploads >= 2) throw new TelegramAttachmentError("Attachment delivery is busy. Try again later.");
    activeUploads++;
    try {
      const file = await open(attachment.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new TelegramAttachmentError("Attachments must be regular local files.");
        if (stat.size > MAX_UPLOAD_BYTES) throw new TelegramAttachmentError("Attachments must not exceed 50 MiB.");
        signal?.throwIfAborted();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of file.createReadStream({
          autoClose: false,
          start: 0,
          end: MAX_UPLOAD_BYTES,
          signal,
        })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_UPLOAD_BYTES) throw new TelegramAttachmentError("Attachments must not exceed 50 MiB.");
          chunks.push(bytes);
        }
        signal?.throwIfAborted();
        const image = guessImageMediaType(attachment.path) && size <= 10 * 1024 * 1024;
        const form = new FormData();
        form.set("chat_id", String(chatId));
        if (destination?.threadId !== undefined) form.set("message_thread_id", String(destination.threadId));
        if (destination?.replyToMessageId)
          form.set(
            "reply_parameters",
            JSON.stringify({ message_id: destination.replyToMessageId, allow_sending_without_reply: false }),
          );
        form.set(
          image ? "photo" : "document",
          new Blob([new Uint8Array(Buffer.concat(chunks, size))]),
          attachment.fileName,
        );
        const method = image ? "sendPhoto" : "sendDocument";
        const sent = await this.http.call({ method, body: {}, schema: TelegramResultSchemas[method], signal, form });
        destination?.sent?.(sent.message_id);
      } finally {
        await file.close();
      }
    } finally {
      activeUploads--;
    }
  }
}
