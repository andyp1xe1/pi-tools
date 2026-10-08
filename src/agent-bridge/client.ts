import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import * as v from "valibot";
import {
  AgentOperationBodies,
  AgentOperationResults,
  type AgentOutput,
  type AgentRequest,
  bridgeSocketPath,
  ClientFrameSchema,
  MAX_FRAME_BYTES,
  type Operation,
  OperationResults,
  type PreparedPrompt,
  type ServerFrame,
  ServerFrameSchema,
} from "./protocol.ts";

interface TranscriptionRequest {
  path: string;
  model?: string;
  language?: string;
  signal?: AbortSignal;
}
type TranscriptionProvider = (request: TranscriptionRequest) => Promise<string>;
const TRANSCRIPTION_PROVIDER = Symbol.for("pi-tools.agent-bridge.transcription-provider");
const TranscriptionProviderSchema = v.object({ key: v.pipe(v.string(), v.nonEmpty()), provider: v.function() });

export function registerBridgeTranscription(key: string, provider: TranscriptionProvider): () => void {
  Reflect.set(globalThis, TRANSCRIPTION_PROVIDER, v.parse(TranscriptionProviderSchema, { key, provider }));
  return () => {
    const value: unknown = Reflect.get(globalThis, TRANSCRIPTION_PROVIDER);
    const parsed = v.safeParse(TranscriptionProviderSchema, value);
    if (parsed.success && parsed.output.key === key && parsed.output.provider === provider)
      Reflect.deleteProperty(globalThis, TRANSCRIPTION_PROVIDER);
  };
}

/** Capture once before asynchronous validation; never look up a later attachment. */
export function captureBridgeTranscription(): TranscriptionProvider | undefined {
  const value: unknown = Reflect.get(globalThis, TRANSCRIPTION_PROVIDER);
  const parsed = v.safeParse(TranscriptionProviderSchema, value);
  if (!parsed.success) return undefined;
  const provider = parsed.output.provider;
  return (request) => {
    const result: unknown = Reflect.apply(provider, undefined, [request]);
    return Promise.resolve(result).then((value) => v.parse(v.string(), value));
  };
}

export class BridgeDeliveryUnknown extends Error {}
function serverError(frame: Extract<ServerFrame, { type: "error" }>): Error {
  return frame.unknownOutcome ? new BridgeDeliveryUnknown(frame.message) : new Error(frame.message);
}

type AttachedFrame = Extract<ServerFrame, { type: "attached" }>;

interface ConnectionOptions {
  socketPath?: string;
  attachTimeoutMs?: number;
  requestTimeoutMs?: number;
  onAttached(frame: AttachedFrame): void;
  onPrompt(prompt: PreparedPrompt): void;
  onAgentRequest(request: AgentRequest): Promise<unknown>;
  onDisconnect(error: Error): void;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** One attachment, never reconnected or reused. All wire values enter as unknown. */
export class BridgeClient {
  private socket?: Socket;
  private state: "detached" | "connecting" | "attached" | "detaching" = "detached";
  private fragments: Buffer[] = [];
  private bufferedBytes = 0;
  private readonly pending = new Map<string, PendingCall>();
  // Aborted requests can still receive a reply; other unsolicited IDs are fatal.
  private readonly retired = new Set<string>();
  private attachTimer?: ReturnType<typeof setTimeout>;
  private detachTimer?: ReturnType<typeof setTimeout>;
  private resolveAttach?: (frame: AttachedFrame) => void;
  private rejectAttach?: (error: Error) => void;
  private closed: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConnectionOptions) {}

  get isAttached(): boolean {
    return this.state === "attached";
  }

  attach(
    sessionId: string,
    userId?: string,
    routeId?: string,
    cwd?: string,
    attachmentToken?: string,
  ): Promise<AttachedFrame> {
    if (this.socket) return Promise.reject(new Error("Attachment client cannot be reused"));
    // Validate before opening a socket, including calls made by untyped consumers.
    const frame = v.parse(ClientFrameSchema, { type: "attach", sessionId, userId, routeId, cwd, attachmentToken });
    this.state = "connecting";
    const attached = new Promise<AttachedFrame>((resolve, reject) => {
      this.resolveAttach = resolve;
      this.rejectAttach = reject;
    });
    const socket = createConnection(this.options.socketPath ?? bridgeSocketPath());
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once("close", resolve));
    this.attachTimer = setTimeout(
      () => this.fail(new Error("Agent bridge attach timed out")),
      this.options.attachTimeoutMs ?? 10_000,
    );
    socket.on("connect", () => {
      if (this.state === "connecting") this.write(frame);
    });
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("end", () => this.fail(new Error("Agent bridge socket disconnected")));
    socket.on("close", () => this.fail(new Error("Agent bridge socket closed")));
    return attached;
  }

  request(operation: Operation, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.isAttached) return Promise.reject(new Error("Agent bridge is not attached"));
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.pending.size >= 256) return Promise.reject(new Error("Too many pending agent bridge requests"));
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`Agent bridge request timed out: ${operation}`)),
        this.options.requestTimeoutMs ?? (operation === "transcribeAudio" ? 6 * 60_000 : 60_000),
      );
      const onAbort = (): void => {
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        call.cleanup();
        this.retired.add(id);
        reject(new DOMException("Aborted", "AbortError"));
        this.write({ type: "cancel", id });
        if (this.retired.size > 1024) this.fail(new Error("Too many unanswered aborted requests"));
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.write({ type: "request", id, operation, body });
    });
  }

  output(event: AgentOutput): void {
    if (this.isAttached) this.write({ type: "output", event });
  }
  async sendAttachment(body: { path: string; fileName: string }, signal?: AbortSignal): Promise<void> {
    v.parse(OperationResults.sendAttachment, await this.request("sendAttachment", body, signal));
  }
  async transcribeAudio(path: string, model?: string, language?: string, signal?: AbortSignal): Promise<string> {
    const result = v.parse(
      OperationResults.transcribeAudio,
      await this.request("transcribeAudio", { path, model, language }, signal),
    );
    return typeof result === "string" ? result : await readFile(result.transcriptPath, { encoding: "utf8", signal });
  }
  async disconnect(): Promise<void> {
    if (this.isAttached) {
      this.state = "detaching";
      this.rejectPending(new Error("Agent bridge detached"));
      this.detachTimer = setTimeout(() => this.fail(new Error("Agent bridge detach timed out")), 1000);
      this.write({ type: "detach" });
    } else if (this.state !== "detaching") {
      this.fail(new Error("Agent bridge detached"));
    }
    await this.closed;
  }

  private write(frame: unknown): void {
    try {
      const validated = v.parse(ClientFrameSchema, frame);
      const line = JSON.stringify(validated);
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_FRAME_BYTES) throw new Error("Agent bridge frame too large");
      if ((this.socket?.writableLength ?? 0) + bytes > 2 * MAX_FRAME_BYTES) {
        throw new Error("Agent bridge socket write buffer exceeded");
      }
      this.socket?.write(`${line}\n`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Invalid outgoing agent bridge frame"));
    }
  }

  private receive(chunk: Buffer): void {
    if (this.state === "detached") return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        this.bufferedBytes += part.length;
        if (this.bufferedBytes > MAX_FRAME_BYTES) throw new Error("Agent bridge frame too large");
        if (part.length) this.fragments.push(part);
        if (newline === -1) return;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(this.fragments, this.bufferedBytes),
        );
        this.fragments = [];
        this.bufferedBytes = 0;
        const value: unknown = JSON.parse(text);
        this.handleFrame(v.parse(ServerFrameSchema, value));
        if (this.socket?.destroyed) return;
        start = newline + 1;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Invalid agent bridge frame"));
    }
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.type === "error" && frame.id === undefined) throw serverError(frame);
    if (frame.type === "status") return;
    if (frame.type === "stopping") throw new Error("Agent bridge is stopping");
    if (frame.type === "detached") {
      this.fail(new Error("Agent bridge detached"));
      return;
    }
    // Requests were rejected locally when detach started. Late replies or
    // updates cannot resume delivery while waiting for the acknowledgement.
    if (this.state === "detaching") return;
    if (frame.type === "attached") {
      if (this.state !== "connecting") throw new Error("Unexpected agent bridge attachment");
      this.state = "attached";
      clearTimeout(this.attachTimer);
      // Initialize attribution synchronously before processing a coalesced update.
      this.options.onAttached(frame);
      this.resolveAttach?.(frame);
      this.resolveAttach = undefined;
      this.rejectAttach = undefined;
      return;
    }
    if (!this.isAttached) throw new Error("Agent bridge frame received before attachment");
    if (frame.type === "prompt") {
      this.options.onPrompt(frame.prompt);
      return;
    }
    if (frame.type === "agent-request") {
      const request = { ...frame, body: v.parse(AgentOperationBodies[frame.operation], frame.body) };
      void this.options
        .onAgentRequest(request)
        .then((result) => {
          if (this.isAttached)
            this.write({
              type: "agent-result",
              id: frame.id,
              result: v.parse(AgentOperationResults[frame.operation], result),
            });
        })
        .catch((error) => {
          if (this.isAttached)
            this.write({
              type: "agent-error",
              id: frame.id,
              message: error instanceof Error ? error.message : "Agent request failed.",
            });
        });
      return;
    }
    if (frame.type !== "result" && frame.type !== "error") throw new Error("Unexpected agent bridge frame");
    const id = frame.id;
    if (!id || id.length > 128) throw new Error("Invalid agent bridge reply ID");
    const call = this.pending.get(id);
    if (!call) {
      if (this.retired.delete(id)) return;
      throw new Error("Unknown agent bridge reply ID");
    }
    const error = frame.type === "error" ? serverError(frame) : undefined;
    this.pending.delete(id);
    call.cleanup();
    if (error) call.reject(error);
    else if (frame.type === "result") call.resolve(frame.result);
  }

  private fail(error: Error): void {
    if (this.state === "detached") return;
    this.state = "detached";
    clearTimeout(this.attachTimer);
    clearTimeout(this.detachTimer);
    this.fragments = [];
    this.bufferedBytes = 0;
    this.socket?.destroy();
    this.rejectAttach?.(error);
    this.resolveAttach = undefined;
    this.rejectAttach = undefined;
    this.rejectPending(error);
    this.options.onDisconnect(error);
  }

  private rejectPending(error: Error): void {
    for (const call of this.pending.values()) {
      call.cleanup();
      call.reject(error);
    }
    this.pending.clear();
    this.retired.clear();
  }
}
