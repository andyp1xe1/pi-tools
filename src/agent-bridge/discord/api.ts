import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import {
  DiscordChannelSchema,
  DiscordMessageSchema,
  DiscordUserSchema,
  GatewayBotSchema,
  SnowflakeSchema,
} from "./schemas.ts";

export class DiscordAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
  ) {
    super(`Discord API request rejected (${status}${code === undefined ? "" : `, code ${code}`}).`);
  }
}
export class DiscordDeliveryUnknown extends Error {
  readonly unknownOutcome = true;
  constructor() {
    super("Discord delivery outcome is unknown; the send was not retried.");
  }
}
const RateLimitSchema = v.object({ retry_after: v.pipe(v.number(), v.minValue(0)), global: v.optional(v.boolean()) });
const ErrorSchema = v.object({ code: v.optional(v.number()) });
export interface DiscordCreateMessage {
  content?: string;
  nonce: string;
  enforce_nonce: true;
  allowed_mentions: { parse: never[]; users: string[]; replied_user: false };
  message_reference?: { type: 0; channel_id: string; message_id: string; fail_if_not_exists: true };
  attachments?: { id: number; filename: string }[];
}
export interface DiscordAPI {
  createMessage(
    channelId: string,
    body: DiscordCreateMessage,
    signal: AbortSignal,
    file?: { data: Blob; name: string },
  ): Promise<{ id: string; channel_id: string }>;
  typing(channelId: string, signal: AbortSignal): Promise<void>;
}

/** Small official REST client. No SDK, user token, webhook token, or arbitrary URL API. */
export class DiscordREST implements DiscordAPI {
  private tail: Promise<unknown> = Promise.resolve();
  private globalUntil = 0;
  private unauthorized = false;
  private readonly routeUntil = new Map<string, number>();
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!token.trim() || /\s/.test(token)) throw new Error("A Discord bot token is required.");
  }
  private request<S extends v.GenericSchema>(
    method: "GET" | "POST",
    path: string,
    schema: S | undefined,
    signal: AbortSignal,
    body?: object,
    file?: { data: Blob; name: string },
  ): Promise<v.InferOutput<S>> {
    const job = this.tail
      .catch(() => {})
      .then(async () => {
        // Conservative per-client serialization, with server-provided per-route/global deadlines.
        // This does not serialize agent work. A definitive 429 is the only retryable send response.
        signal.throwIfAborted();
        if (this.unauthorized) throw new DiscordAPIError(401);
        for (let attempt = 0; ; attempt++) {
          const wait = Math.max(this.globalUntil, this.routeUntil.get(path) ?? 0) - Date.now();
          if (wait > 0) await delay(wait, undefined, { signal });
          signal.throwIfAborted();
          const headers: Record<string, string> = {
            Authorization: `Bot ${this.token}`,
            "User-Agent": "DiscordBot (https://github.com/discord/discord-api-docs, 1.0) pi-tools",
          };
          let payload: string | FormData | undefined;
          if (file) {
            const form = new FormData();
            form.set("payload_json", JSON.stringify(body));
            form.set("files[0]", file.data, file.name);
            payload = form;
          } else if (body) {
            headers["Content-Type"] = "application/json";
            payload = JSON.stringify(body);
          }
          let response: Response;
          try {
            response = await this.fetcher(`https://discord.com/api/v10${path}`, {
              method,
              headers,
              body: payload,
              signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
              redirect: "error",
            });
          } catch {
            if (method === "POST") throw new DiscordDeliveryUnknown();
            signal.throwIfAborted();
            throw new Error("Discord REST connection failed.");
          }
          if (response.status === 401) this.unauthorized = true;
          const remaining = response.headers.get("X-RateLimit-Remaining");
          const reset = Number(response.headers.get("X-RateLimit-Reset-After"));
          if (remaining === "0" && Number.isFinite(reset) && reset >= 0)
            this.routeUntil.set(path, Date.now() + reset * 1000);
          let value: unknown;
          try {
            value = response.status === 204 ? undefined : await response.json();
          } catch {
            if (method === "POST" && (response.ok || response.status >= 500)) throw new DiscordDeliveryUnknown();
            throw new DiscordAPIError(response.status);
          }
          if (response.status === 429) {
            const rate = v.safeParse(RateLimitSchema, value);
            if (!rate.success) throw new DiscordAPIError(429);
            const until = Date.now() + rate.output.retry_after * 1000;
            if (rate.output.global || response.headers.get("X-RateLimit-Global") === "true") this.globalUntil = until;
            else this.routeUntil.set(path, until);
            if (attempt >= 2) throw new DiscordAPIError(429);
            continue;
          }
          if (!response.ok) {
            if (method === "POST" && response.status >= 500) throw new DiscordDeliveryUnknown();
            const parsed = v.safeParse(ErrorSchema, value);
            throw new DiscordAPIError(response.status, parsed.success ? parsed.output.code : undefined);
          }
          if (!schema) return undefined as v.InferOutput<S>;
          const parsed = v.safeParse(schema, value);
          if (!parsed.success) {
            if (method === "POST") throw new DiscordDeliveryUnknown();
            throw new Error("Discord REST returned an invalid response.");
          }
          return parsed.output;
        }
      });
    this.tail = job;
    return job;
  }
  me(signal: AbortSignal) {
    return this.request("GET", "/users/@me", DiscordUserSchema, signal);
  }
  gateway(signal: AbortSignal) {
    return this.request("GET", "/gateway/bot", GatewayBotSchema, signal);
  }
  channel(id: string, signal: AbortSignal) {
    return this.request("GET", `/channels/${v.parse(SnowflakeSchema, id)}`, DiscordChannelSchema, signal);
  }
  async createMessage(
    channelId: string,
    body: DiscordCreateMessage,
    signal: AbortSignal,
    file?: { data: Blob; name: string },
  ) {
    const id = v.parse(SnowflakeSchema, channelId);
    const message = await this.request("POST", `/channels/${id}/messages`, DiscordMessageSchema, signal, body, file);
    if (message.channel_id !== id) throw new DiscordDeliveryUnknown();
    return message;
  }
  async typing(channelId: string, signal: AbortSignal): Promise<void> {
    await this.request("POST", `/channels/${v.parse(SnowflakeSchema, channelId)}/typing`, undefined, signal);
  }
}
