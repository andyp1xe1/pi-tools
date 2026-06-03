import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { EmptyComponent, RenderLatexMessage } from "./components.ts";
import { CUSTOM_TYPE, RENDER_MODE_FLAG } from "./config.ts";
import { buildSegments } from "./segments.ts";
import type { LatexDetails, RenderMode } from "./types.ts";

const SHOWCASE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "latex", "showcase.md");

export default function (pi: ExtensionAPI) {
  pi.registerFlag(RENDER_MODE_FLAG, {
    description: "Where render_latex shows rich output: 'message' or 'tool'",
    type: "string",
    default: defaultRenderMode(),
  });

  pi.registerMessageRenderer<LatexDetails>(CUSTOM_TYPE, (message, _options, theme) => {
    const details = message.details;
    return details?.segments?.length ? new RenderLatexMessage(details.segments, theme) : undefined;
  });

  pi.registerTool({
    name: "render_latex",
    label: "Render LaTeX",
    description:
      "Display Markdown with block LaTeX formulas rendered as images. Formula source is hidden in the rendered view.",
    promptSnippet: "Display Markdown with rendered block LaTeX formulas",
    promptGuidelines: [
      "Use render_latex when the user asks for math-heavy output, equations, derivations, or a clean rich answer with rendered formulas.",
      "For render_latex, put formulas as block math using $$...$$ or \\[...\\]. Do not use it just for ordinary inline formulas.",
      "Use render_latex for final answers only when rendered math is the main value; otherwise answer normally.",
    ],
    parameters: Type.Object({
      markdown: Type.String({
        description:
          "Markdown text. Only block LaTeX is rendered: $$...$$, \\[...\\], and equation/align/gather/multline environments.",
      }),
      title: Type.Optional(Type.String({ description: "Optional short title for the rendered message." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = parseRenderMode(pi.getFlag(RENDER_MODE_FLAG));
      const details: LatexDetails = { segments: await buildSegments(params.markdown, ctx.ui.theme) };
      const formulaCount = details.segments.filter((segment) => segment.type === "formula").length;

      if (mode === "message") {
        pi.sendMessage<LatexDetails>({
          customType: CUSTOM_TYPE,
          content: cleanTitle(params.title) ?? "Rendered LaTeX",
          display: true,
          details,
        });
      }

      return {
        content: [{ type: "text", text: `Displayed rendered LaTeX ${mode} (${formulaCount} formulas).` }],
        details: mode === "tool" ? details : { mode, formulaCount },
        terminate: true,
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("dim", cleanTitle(args?.title) ?? "LaTeX"), 0, 0);
    },
    renderResult(result, _options, theme) {
      return isLatexDetails(result.details)
        ? new RenderLatexMessage(result.details.segments, theme)
        : new EmptyComponent();
    },
  });

  pi.registerCommand("latex-renderer-test", {
    description: "Show a test rendered LaTeX message",
    handler: async (_args, ctx) => {
      const markdown = await readFile(SHOWCASE_FIXTURE, "utf8");
      pi.sendMessage<LatexDetails>({
        customType: CUSTOM_TYPE,
        content: "Rendered LaTeX test",
        display: true,
        details: { segments: await buildSegments(markdown, ctx.ui.theme) },
      });
    },
  });
}

function defaultRenderMode(): RenderMode {
  return process.env.PI_LATEX_RENDER_MODE === "tool" ? "tool" : "message";
}

function parseRenderMode(value: unknown): RenderMode {
  if (value === "message" || value === "tool") return value;
  throw new Error(`Invalid ${RENDER_MODE_FLAG}: expected 'message' or 'tool', got ${String(value)}`);
}

function cleanTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isLatexDetails(value: unknown): value is LatexDetails {
  return !!value && typeof value === "object" && Array.isArray((value as LatexDetails).segments);
}
