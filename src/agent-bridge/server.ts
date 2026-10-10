import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { preparePrivatePath } from "./config.ts";
import type { AgentPort, BridgeFrontend, FrontendPeer, SessionFrontend } from "./frontend.ts";
import {
  type AgentOperation,
  AgentOperationResults,
  type ClientFrame,
  ClientFrameSchema,
  MAX_FRAME_BYTES,
  OperationBodies,
  OperationResults,
  type ServerFrame,
} from "./protocol.ts";
import { TranscriptionError, transcribeAudio } from "./transcription.ts";

interface AgentCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Peer {
  socket: Socket;
  identity: FrontendPeer["identity"];
  routeId: string;
  sessionId: string;
  controller: AbortController;
  requests: Map<string, AbortController>;
  agentCalls: Map<string, AgentCall>;
  frontend: SessionFrontend;
}
function send(socket: Socket, frame: ServerFrame): void {
  const line = `${JSON.stringify(frame)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_FRAME_BYTES || socket.writableLength + bytes > 2 * MAX_FRAME_BYTES) {
    socket.destroy();
    return;
  }
  if (!socket.destroyed && !socket.writableEnded) socket.write(line);
}
async function socketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(true);
    });
  });
}
export class BridgeServer {
  private readonly peers = new Map<string, Peer>();
  private readonly sockets = new Set<Socket>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly startedAt = Date.now();
  private server?: Server;
  private socketPath?: string;
  private closing = false;
  constructor(
    private readonly transport: BridgeFrontend,
    private readonly stop: () => void,
  ) {}
  async listen(input: string): Promise<void> {
    const path = preparePrivatePath(input);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
        throw new Error("Refusing to replace a non-owned IPC socket.");
      if (await socketLive(path)) throw new Error("An agent-bridge daemon already owns this socket.");
      unlinkSync(path);
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    this.socketPath = path;
    chmodSync(path, 0o600);
  }
  private track(task: Promise<unknown>): void {
    this.jobs.add(task);
    void task.finally(() => this.jobs.delete(task)).catch(() => {});
  }
  private release(peer: Peer): void {
    if (this.peers.get(peer.routeId) !== peer) return;
    this.peers.delete(peer.routeId);
    peer.controller.abort();
    for (const call of peer.agentCalls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Agent detached"));
    }
    peer.agentCalls.clear();
    this.track(peer.frontend.close());
  }
  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.sockets.delete(socket);
      for (const peer of this.peers.values()) if (peer.socket === socket) this.release(peer);
    });
    let fragments: Buffer[] = [];
    let bytes = 0;
    let pending = 0;
    let chain = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        bytes += part.length;
        if (bytes > MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        if (part.length) fragments.push(part);
        if (newline === -1) return;
        const line = Buffer.concat(fragments, bytes);
        fragments = [];
        bytes = 0;
        start = newline + 1;
        if (++pending > 128) {
          socket.destroy();
          return;
        }
        chain = chain
          .then(() => {
            if (socket.destroyed || socket.writableEnded) return;
            let frame: ClientFrame;
            try {
              frame = v.parse(ClientFrameSchema, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
            } catch {
              send(socket, { type: "error", message: "Invalid bridge request." });
              socket.end();
              return;
            }
            if ((frame.type === "request" || frame.type === "notify") && this.jobs.size >= 128) {
              send(socket, {
                type: "error",
                ...(frame.type === "request" ? { id: frame.id } : {}),
                message: "Bridge is busy. Try again later.",
              });
              return;
            }
            const task = this.handle(socket, frame).catch((error) => {
              send(socket, {
                type: "error",
                ...("id" in frame ? { id: frame.id } : {}),
                ...(this.transport.error(error) ?? {
                  message: error instanceof TranscriptionError ? error.message : "Bridge request failed.",
                }),
              });
            });
            // Long tool calls cannot block cancellation, detach, or reverse RPC replies.
            if (frame.type === "request" || frame.type === "notify") this.track(task);
            else return task;
          })
          .catch(() => {
            socket.destroy();
          })
          .finally(() => {
            pending--;
          });
      }
    });
  }
  private peer(socket: Socket): Peer | undefined {
    return [...this.peers.values()].find((peer) => peer.socket === socket);
  }
  private agentCall<K extends AgentOperation>(
    peer: Peer,
    operation: K,
    body: Record<string, unknown> = {},
  ): Promise<v.InferOutput<(typeof AgentOperationResults)[K]>> {
    if (peer.controller.signal.aborted) return Promise.reject(new Error("Agent detached"));
    if (peer.agentCalls.size >= 32) return Promise.reject(new Error("Too many pending agent commands"));
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          peer.agentCalls.delete(id);
          reject(new Error("Agent command timed out"));
          peer.socket.destroy();
        },
        operation === "compact" ? 6 * 60_000 : 60_000,
      );
      peer.agentCalls.set(id, { resolve, reject, timer });
      send(peer.socket, { type: "agent-request", id, operation, body });
    });
    return result.then((value) => v.parse(AgentOperationResults[operation], value));
  }
  private async handle(socket: Socket, frame: ClientFrame): Promise<void> {
    const peer = this.peer(socket);
    switch (frame.type) {
      case "cancel":
        peer?.requests.get(frame.id)?.abort();
        return;
      case "detach":
        if (peer) this.release(peer);
        socket.end(`${JSON.stringify({ type: "detached" })}\n`);
        return;
      case "status":
        send(socket, this.status());
        return;
      case "stop":
        socket.end(`${JSON.stringify({ type: "stopping" })}\n`, () => this.stop());
        return;
      case "notify":
        if (!this.transport.notify) throw new Error("This frontend does not support notifications.");
        await this.transport.notify(frame);
        send(socket, { type: "notified", userId: frame.userId });
        return;
      case "agent-result":
      case "agent-error": {
        const call = peer?.agentCalls.get(frame.id);
        if (!call) {
          socket.destroy();
          return;
        }
        peer?.agentCalls.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.type === "agent-error") call.reject(new Error(frame.message));
        else call.resolve(frame.result);
        return;
      }
      case "output":
        if (!peer) throw new Error("Not attached");
        peer.frontend.output(frame.event);
        return;
      case "attach": {
        if (peer) throw new Error("Socket already attached");
        let identity: ReturnType<BridgeFrontend["authorize"]>;
        try {
          // Authorization and persistence are synchronous, so no competing attach can interleave.
          identity = this.transport.authorize(frame);
          if (this.peers.has(identity.routeId))
            throw new Error("This route already has an attached session. Disconnect it first.");
          if ([...this.peers.values()].some((other) => other.sessionId === frame.sessionId))
            throw new Error("This Pi session already has an attached route.");
          this.transport.bind(frame, identity);
        } catch (error) {
          send(socket, { type: "error", message: error instanceof Error ? error.message : "Attachment refused." });
          socket.end();
          return;
        }
        const controller = new AbortController();
        const current = () => !controller.signal.aborted && !socket.destroyed && !socket.writableEnded;
        const port: AgentPort = {
          current,
          snapshot: () => this.agentCall(attached, "snapshot"),
          setModel: (model) => this.agentCall(attached, "setModel", model),
          setThinking: (level) => this.agentCall(attached, "setThinking", { level }),
          abort: () => this.agentCall(attached, "abort"),
          compact: () => this.agentCall(attached, "compact"),
          newSession: () => this.agentCall(attached, "newSession"),
          prompt: (prompt) => send(socket, { type: "prompt", prompt }),
        };
        const frontend = this.transport.open(identity, port);
        const attached: Peer = {
          socket,
          identity,
          routeId: identity.routeId,
          sessionId: frame.sessionId,
          controller,
          requests: new Map(),
          agentCalls: new Map(),
          frontend,
        };
        this.peers.set(identity.routeId, attached);
        send(socket, { type: "attached", ...identity });
        return;
      }
      case "request": {
        if (!peer) {
          send(socket, { type: "error", id: frame.id, message: "Attach a session before requesting delivery." });
          return;
        }
        if (peer.requests.has(frame.id)) {
          socket.destroy();
          return;
        }
        if (peer.requests.size >= 32) {
          send(socket, { type: "error", id: frame.id, message: "Too many active requests." });
          return;
        }
        const controller = new AbortController();
        peer.requests.set(frame.id, controller);
        const signal = AbortSignal.any([peer.controller.signal, controller.signal]);
        try {
          let result: unknown;
          switch (frame.operation) {
            case "sendAttachment": {
              const body = v.parse(OperationBodies.sendAttachment, frame.body);
              await peer.frontend.sendAttachment(body, signal);
              result = true;
              break;
            }
            case "transcribeAudio": {
              const body = v.parse(OperationBodies.transcribeAudio, frame.body);
              result = await transcribeAudio(body.path, { model: body.model, language: body.language, signal });
              if (typeof result === "string" && Buffer.byteLength(JSON.stringify(result)) > MAX_FRAME_BYTES / 2) {
                const directory = await mkdtemp(join(tmpdir(), "agent-bridge-"));
                const transcriptPath = join(directory, `${randomUUID()}-transcript.txt`);
                await writeFile(transcriptPath, result, { mode: 0o600, flag: "wx", signal });
                result = { transcriptPath };
              }
              break;
            }
          }
          send(socket, { type: "result", id: frame.id, result: v.parse(OperationResults[frame.operation], result) });
        } finally {
          peer.requests.delete(frame.id);
        }
        return;
      }
    }
  }
  private status(): Extract<ServerFrame, { type: "status" }> {
    return {
      type: "status",
      frontend: this.transport.identity,
      sessions: [...this.peers.values()].map(({ identity, sessionId, routeId }) => ({
        userId: identity.userId,
        sessionId,
        routeId,
      })),
      statistics: this.transport.statistics(),
      mode: this.transport.mode,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)),
    };
  }
  attachment(routeId: string): FrontendPeer | undefined {
    const peer = this.peers.get(routeId);
    return peer && !peer.socket.destroyed && !peer.controller.signal.aborted ? peer : undefined;
  }
  detachRoute(routeId: string): void {
    const peer = this.peers.get(routeId);
    if (!peer) return;
    this.release(peer);
    peer.socket.end(`${JSON.stringify({ type: "detached" })}\n`);
  }
  inspect(): Extract<ServerFrame, { type: "status" }> {
    return this.status();
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const peer of this.peers.values()) this.release(peer);
    for (const socket of this.sockets) socket.destroy();
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    const server = this.server;
    if (server?.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (this.socketPath && existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }
}
