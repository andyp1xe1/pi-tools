import * as v from "valibot";
import { TelegramDeliveryUnknown, TelegramError } from "./errors.ts";
import { PositiveInteger as positiveInteger, type TelegramMethod } from "./schemas.ts";
export interface TelegramRequest<S extends v.GenericSchema> {
  method: TelegramMethod;
  body: Record<string, unknown>;
  schema: S;
  signal?: AbortSignal;
  form?: FormData;
}
export interface TelegramAPI {
  call<S extends v.GenericSchema>(request: TelegramRequest<S>): Promise<v.InferOutput<S>>;
}
const EnvelopeSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.unknown() }),
  v.object({
    ok: v.literal(false),
    error_code: positiveInteger,
    parameters: v.optional(v.object({ retry_after: v.optional(positiveInteger) })),
  }),
]);
export class TelegramHttpClient implements TelegramAPI {
  constructor(
    private readonly token: string | (() => string),
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}

  private botToken(): string {
    const token = typeof this.token === "function" ? this.token() : this.token;
    if (!token) throw new Error("Telegram bot token is not configured");
    return token;
  }

  async download(filePath: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!/^[a-z0-9_./-]+$/i.test(filePath) || filePath.split("/").includes(".."))
      throw new Error("Invalid Telegram file path");
    try {
      const response = await this.fetcher(`https://api.telegram.org/file/bot${this.botToken()}/${filePath}`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new TelegramError(response.status);
      return await response.arrayBuffer();
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new Error("Telegram file download failed. Token and URL redacted.");
    }
  }

  async call<S extends v.GenericSchema>({
    method,
    body,
    schema,
    signal,
    form,
  }: TelegramRequest<S>): Promise<v.InferOutput<S>> {
    const creation = ["sendMessage", "sendPhoto", "sendDocument"].includes(method);
    const invalid = (message: string): Error => (creation ? new TelegramDeliveryUnknown() : new Error(message));
    const timeout = AbortSignal.timeout(method === "getUpdates" ? 40_000 : 15_000);
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.botToken()}/${method}`, {
        method: "POST",
        headers: form ? undefined : { "content-type": "application/json" },
        body: form ?? JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw invalid("Telegram request failed or timed out. Token and URL redacted.");
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw invalid("Telegram returned invalid JSON. Body redacted.");
    }
    const envelope = v.safeParse(EnvelopeSchema, data);
    if (!envelope.success) throw invalid("Telegram returned an invalid envelope. Body redacted.");
    if (!envelope.output.ok) {
      if (creation && envelope.output.error_code >= 500) throw new TelegramDeliveryUnknown();
      throw new TelegramError(envelope.output.error_code, envelope.output.parameters?.retry_after);
    }
    if (!response.ok) {
      if (creation && response.status >= 500) throw new TelegramDeliveryUnknown();
      throw new TelegramError(response.status);
    }
    const result = v.safeParse(schema, envelope.output.result);
    if (!result.success) throw invalid("Telegram returned an invalid result. Body redacted.");
    return result.output;
  }
}
