import type {
  AgentOutput,
  AgentSnapshot,
  ClientFrame,
  PreparedPrompt,
  ServerFrame,
  Statistics,
  ThinkingLevel,
} from "./protocol.ts";

/** The bot frontend depends on capabilities, not an agent SDK. */
export interface AgentPort {
  current(): boolean;
  snapshot(): Promise<AgentSnapshot>;
  setModel(model: { provider: string; id: string }): Promise<boolean>;
  setThinking(level: ThinkingLevel): Promise<ThinkingLevel>;
  abort(): Promise<boolean>;
  compact(): Promise<boolean>;
  newSession(): Promise<boolean>;
  prompt(prompt: PreparedPrompt): void;
}

export type AttachmentRequest = Extract<ClientFrame, { type: "attach" }>;
export type AttachmentIdentity = Omit<Extract<ServerFrame, { type: "attached" }>, "type">;

/** The IPC core knows routes and agent capabilities, never platform updates or credentials. */
export interface SessionFrontend {
  output(event: AgentOutput): void;
  sendAttachment(body: { path: string; fileName: string }, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface BridgeFrontend {
  readonly identity: AttachmentIdentity["frontend"];
  readonly mode: "setup" | "routing";
  authorize(request: AttachmentRequest): AttachmentIdentity & { routeId: string };
  open(identity: AttachmentIdentity, agent: AgentPort): SessionFrontend;
  bind(request: AttachmentRequest, identity: AttachmentIdentity): void;
  statistics(): Statistics;
  error(error: unknown): { message: string; unknownOutcome?: boolean } | undefined;
}
export interface FrontendPeer {
  readonly identity: AttachmentIdentity;
  readonly frontend: SessionFrontend;
}

/** Native-session host. Implementations attach through the same portable IPC client. */
export interface SessionTarget {
  routeId: string;
  cwd: string;
  ownerId: string;
  name: string;
  sessionId?: string;
  sessionFile?: string;
  attachmentToken?: string;
}
export interface SessionBackend {
  open(target: SessionTarget): Promise<{ sessionId: string; sessionFile: string }>;
  closeRoute(routeId: string): Promise<void>;
  close(): Promise<void>;
}
