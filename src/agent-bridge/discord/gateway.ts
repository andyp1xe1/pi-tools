import * as v from "valibot";
import { type GatewayFrame, GatewayFrameSchema } from "./schemas.ts";

/** GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT. Portal approval may be required. */
export const DISCORD_MESSAGE_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
export type DiscordGatewayAction =
  | { type: "send"; payload: { op: number; d: unknown } }
  | { type: "heartbeat-timer"; delayMs: number }
  | { type: "reconnect"; delayMs: number; resume: boolean }
  | { type: "fatal"; message: string }
  | { type: "dispatch"; name: string; data: unknown; sequence: number };
const HelloSchema = v.object({ heartbeat_interval: v.pipe(v.number(), v.minValue(1)) });
const ReadySchema = v.object({
  session_id: v.pipe(v.string(), v.nonEmpty()),
  resume_gateway_url: v.pipe(v.string(), v.url()),
});
const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/**
 * Adapter-local Gateway protocol state. The daemon owns socket/timer scheduling and reconnects;
 * no sockets are opened here and no saved Pi session is created. Use JSON v10, no compression.
 */
export class DiscordGateway {
  private sessionId?: string;
  private resumeURL?: string;
  private sequence: number | null = null;
  private interval = 0;
  private awaitingAck = false;
  private hello = false;
  constructor(
    private readonly token: string,
    private readonly random: () => number = Math.random,
  ) {
    if (!token.trim() || /\s/.test(token)) throw new Error("A Discord bot token is required.");
  }
  url(initialURL: string): string {
    const url = new URL(this.resumeURL ?? initialURL);
    if (url.protocol !== "wss:" || !/(^|\.)discord\.gg$/.test(url.hostname))
      throw new Error("Untrusted Discord Gateway URL.");
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    return url.href;
  }
  opened(): void {
    this.hello = false;
    this.awaitingAck = false;
    this.interval = 0;
  }
  private canResume(): boolean {
    return !!this.sessionId && !!this.resumeURL && this.sequence !== null;
  }
  private resetSession(): void {
    this.sessionId = undefined;
    this.resumeURL = undefined;
    this.sequence = null;
  }
  receive(input: unknown): DiscordGatewayAction[] {
    const frame: GatewayFrame = v.parse(GatewayFrameSchema, input);
    switch (frame.op) {
      case 10: {
        if (this.hello) throw new Error("Duplicate Discord Gateway Hello.");
        this.hello = true;
        this.interval = v.parse(HelloSchema, frame.d).heartbeat_interval;
        return [
          { type: "heartbeat-timer", delayMs: this.interval * this.random() },
          {
            type: "send",
            payload: this.canResume()
              ? { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } }
              : {
                  op: 2,
                  d: {
                    token: this.token,
                    intents: DISCORD_MESSAGE_INTENTS,
                    properties: { os: process.platform, browser: "pi-tools", device: "pi-tools" },
                  },
                },
          },
        ];
      }
      case 11:
        this.awaitingAck = false;
        return [];
      case 1:
        // A server-requested heartbeat does not reschedule the regular interval or
        // start its ACK deadline: a periodic tick may be imminent, before the ACK arrives.
        return [{ type: "send", payload: { op: 1, d: this.sequence } }];
      case 7:
        return [{ type: "reconnect", delayMs: 0, resume: this.canResume() }];
      case 9: {
        const resumable = frame.d === true && this.canResume();
        if (!resumable) this.resetSession();
        return [{ type: "reconnect", delayMs: 1000 + this.random() * 4000, resume: resumable }];
      }
      case 0: {
        if (!this.hello || !frame.t || frame.s === undefined || frame.s === null)
          throw new Error("Invalid Discord Gateway dispatch.");
        this.sequence = frame.s;
        if (frame.t === "READY") {
          const ready = v.parse(ReadySchema, frame.d);
          // Validate before retaining a URL that will receive the credential on reconnect.
          const url = new URL(ready.resume_gateway_url);
          if (url.protocol !== "wss:" || !/(^|\.)discord\.gg$/.test(url.hostname))
            throw new Error("Untrusted Discord resume Gateway URL.");
          this.sessionId = ready.session_id;
          this.resumeURL = ready.resume_gateway_url;
        }
        return [{ type: "dispatch", name: frame.t, data: frame.d, sequence: frame.s }];
      }
      default:
        return [];
    }
  }
  heartbeat(): DiscordGatewayAction[] {
    if (!this.hello) return [];
    if (this.awaitingAck) return [{ type: "reconnect", delayMs: 0, resume: this.canResume() }];
    this.awaitingAck = true;
    return [
      { type: "send", payload: { op: 1, d: this.sequence } },
      { type: "heartbeat-timer", delayMs: this.interval },
    ];
  }
  disconnected(code: number): DiscordGatewayAction[] {
    this.hello = false;
    this.interval = 0;
    if (FATAL_CODES.has(code))
      return [
        { type: "fatal", message: `Discord Gateway closed (${code}); fix bot configuration before reconnecting.` },
      ];
    if (code === 4007 || code === 4009) this.resetSession();
    return [{ type: "reconnect", delayMs: 1000 + this.random() * 4000, resume: this.canResume() }];
  }
}
