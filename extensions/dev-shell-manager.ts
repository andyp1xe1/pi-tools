import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDevShellManager } from "../src/dev-shell-manager/index.ts";

export default function devShellManager(pi: ExtensionAPI): void {
  registerDevShellManager(pi);
}
