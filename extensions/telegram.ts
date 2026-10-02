import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegram } from "../src/telegram/index.ts";

export default function telegram(pi: ExtensionAPI): void {
  registerTelegram(pi);
}
