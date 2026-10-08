import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBot } from "../src/bot/index.ts";

export default function telegram(pi: ExtensionAPI): void {
  registerBot(pi);
}
