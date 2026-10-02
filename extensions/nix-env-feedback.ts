import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNixEnvFeedback } from "../src/nix-env-feedback/index.ts";

export default function nixEnvFeedback(pi: ExtensionAPI): void {
  registerNixEnvFeedback(pi);
}
