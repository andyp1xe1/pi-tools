import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as v from "valibot";
import { type AgentSnapshot, AgentSnapshotSchema, ThinkingLevelSchema } from "../agent-bridge/protocol.ts";

export function availableModels(ctx: ExtensionContext): Model<Api>[] {
  return ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sessionStatus(ctx: ExtensionContext): string {
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    cost += usage.cost.total;
  }
  const lines: string[] = [];
  if (ctx.model) lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
  const tokens: string[] = [];
  if (input) tokens.push(`↑${formatTokens(input)}`);
  if (output) tokens.push(`↓${formatTokens(output)}`);
  if (cacheRead) tokens.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) tokens.push(`W${formatTokens(cacheWrite)}`);
  if (tokens.length) lines.push(`Usage: ${tokens.join(" ")}`);
  const subscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
  if (cost || subscription) lines.push(`Cost: $${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
  const usage = ctx.getContextUsage();
  if (usage) {
    const percent = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
    lines.push(`Context: ${percent}/${formatTokens(usage.contextWindow ?? ctx.model?.contextWindow ?? 0)}`);
  } else lines.push("Context: unknown");
  return lines.join("\n");
}

export function agentSnapshot(pi: Pick<ExtensionAPI, "getThinkingLevel">, ctx: ExtensionContext): AgentSnapshot {
  const modelInfo = (model: Model<Api>) => ({ provider: model.provider, id: model.id, name: model.name || model.id });
  const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"];
  return v.parse(AgentSnapshotSchema, {
    idle: ctx.isIdle(),
    model: ctx.model ? modelInfo(ctx.model) : undefined,
    models: availableModels(ctx)
      .map(modelInfo)
      .sort((a, b) => `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`)),
    thinking: v.parse(ThinkingLevelSchema, pi.getThinkingLevel()),
    supportedThinking: levels.filter((level) => v.is(ThinkingLevelSchema, level)),
    status: sessionStatus(ctx),
  });
}
