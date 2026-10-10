import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BotSessionAdapter } from "./session-adapter.ts";

export function registerBot(pi: ExtensionAPI): void {
  new BotSessionAdapter(pi).register();
}
