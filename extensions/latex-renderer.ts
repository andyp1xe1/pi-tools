import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLatexRenderer } from "../src/latex-renderer/index.ts";

export default function latexRenderer(pi: ExtensionAPI): void {
  registerLatexRenderer(pi);
}
