import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TelegramBridge } from "./bridge.ts";

export function registerTelegram(pi: ExtensionAPI): void {
  new TelegramBridge(pi).register();
}
