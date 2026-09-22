import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MAX_MESSAGE_LENGTH, TELEGRAM_PREFIX } from "./constants.ts";

export function isTelegramPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function chunkParagraphs(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.trim()) chunks.push(current);
    current = "";
  };

  const splitLongBlock = (block: string): string[] => {
    if (block.length <= MAX_MESSAGE_LENGTH) return [block];
    const parts: string[] = [];
    let currentLine = "";

    for (const line of block.split("\n")) {
      const candidate = currentLine ? `${currentLine}\n${line}` : line;
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        currentLine = candidate;
        continue;
      }
      if (currentLine) parts.push(currentLine);
      currentLine = "";
      if (line.length <= MAX_MESSAGE_LENGTH) {
        currentLine = line;
      } else {
        for (let index = 0; index < line.length; index += MAX_MESSAGE_LENGTH) {
          parts.push(line.slice(index, index + MAX_MESSAGE_LENGTH));
        }
      }
    }
    if (currentLine) parts.push(currentLine);
    return parts;
  };

  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    for (const part of splitLongBlock(paragraph)) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= MAX_MESSAGE_LENGTH) current = candidate;
      else {
        flush();
        current = part;
      }
    }
  }
  flush();
  return chunks;
}

export function isAssistantMessage(message: AgentMessage): boolean {
  return (message as unknown as { role?: string }).role === "assistant";
}

export function getMessageText(message: AgentMessage): string {
  const value = message as unknown as Record<string, unknown>;
  const content = Array.isArray(value.content) ? value.content : [];
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

export function isTelegramUserMessage(message: AgentMessage): boolean {
  return (message as unknown as { role?: string }).role === "user" && isTelegramPrompt(getMessageText(message));
}

export function extractAssistantText(messages: AgentMessage[]): {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    const text = getMessageText(message as unknown as AgentMessage);
    return { text: text || undefined, stopReason, errorMessage };
  }
  return {};
}
