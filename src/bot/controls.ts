import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as v from "valibot";
import { AgentOperationBodies, type AgentRequest, type ThinkingLevel } from "../agent-bridge/protocol.ts";
import { agentSnapshot, availableModels } from "./status.ts";

interface ControlHost {
  ctx: ExtensionContext;
  busy(): boolean;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): ThinkingLevel;
  setModel(model: Model<Api>): Promise<boolean>;
  compact(): Promise<boolean>;
  abort(): Promise<boolean> | boolean;
  newSession(): Promise<boolean> | boolean;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
}

/** One validation and busy/model policy for native sessions and visible attachments. */
export async function handleBotRequest(request: AgentRequest, host: ControlHost): Promise<unknown> {
  v.parse(AgentOperationBodies[request.operation], request.body);
  if (request.operation === "snapshot") return agentSnapshot(host, host.ctx);
  if (request.operation === "abort") return host.abort();
  if (!host.ctx.isIdle() || host.busy()) {
    if (request.operation === "setThinking") throw new Error("Pi is busy. Wait for the current turn to finish.");
    return false;
  }
  switch (request.operation) {
    case "setModel": {
      const body = v.parse(AgentOperationBodies.setModel, request.body);
      const model = availableModels(host.ctx).find((model) => model.provider === body.provider && model.id === body.id);
      return model ? host.mutate(() => host.setModel(model)) : false;
    }
    case "setThinking": {
      const body = v.parse(AgentOperationBodies.setThinking, request.body);
      return host.setThinkingLevel(body.level);
    }
    case "compact":
      return host.mutate(() => host.compact());
    case "newSession":
      return host.newSession();
  }
}
