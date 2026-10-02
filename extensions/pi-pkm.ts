import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiPkm } from "../src/pi-pkm/index.ts";

export default function piPkm(pi: ExtensionAPI): void {
  registerPiPkm(pi);
}
