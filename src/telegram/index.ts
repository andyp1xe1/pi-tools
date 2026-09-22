import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TelegramBridge } from "./bridge.ts";

export default function telegramExtension(pi: ExtensionAPI): void {
  new TelegramBridge(pi).register();
}
