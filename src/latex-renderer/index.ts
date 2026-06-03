import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { EmptyComponent, RenderLatexMessage } from "./components.ts";
import { CUSTOM_TYPE, RENDER_MODE_FLAG } from "./config.ts";
import { buildSegments } from "./segments.ts";
import type { LatexDetails, RenderMode } from "./types.ts";

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
      pi.sendMessage<LatexDetails>({
        customType: CUSTOM_TYPE,
        content: "Rendered LaTeX test",
        display: true,
        details: { segments: await buildSegments(TEST_MARKDOWN, ctx.ui.theme) },
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

const TEST_MARKDOWN = String.raw`# LaTeX renderer showcase

This message exercises every supported delimiter and environment, plus a real classical proof. Inline math like $E = mc^2$ and $\pi \approx 3.14159$ is left untouched in normal Markdown flow — only **block** formulas are rendered as images.

## 1. Dollar-delimited blocks (\$\$ … \$\$)

Euler's identity, the most beautiful equation in mathematics:

$$
e^{i\pi} + 1 = 0
$$

The Gaussian density, normalized so its integral over the real line is one:

$$
f(x) \;=\; \frac{1}{\sigma\sqrt{2\pi}}\, \exp\!\left(-\frac{(x - \mu)^2}{2\sigma^2}\right)
$$

## 2. Bracket-delimited blocks (\\[ … \\])

The Cauchy–Schwarz inequality in an inner-product space:

\[
\bigl|\langle u, v\rangle\bigr|^{2} \;\le\; \langle u, u\rangle \cdot \langle v, v\rangle
\]

## 3. \`equation\` environment

The time-dependent Schrödinger equation:

\begin{equation}
i\hbar \, \frac{\partial}{\partial t}\,\Psi(\mathbf{r}, t) \;=\; \hat{H}\,\Psi(\mathbf{r}, t)
\end{equation}

## 4. \`align\` environment — a classical proof

**Theorem (Gauss).** $\displaystyle \int_{-\infty}^{\infty} e^{-x^{2}}\,dx = \sqrt{\pi}.$

*Proof.* Let $I = \int_{-\infty}^{\infty} e^{-x^{2}}\,dx$. Squaring and switching to polar coordinates $(x, y) = (r\cos\theta,\, r\sin\theta)$:

\begin{align}
I^{2}
&= \left(\int_{-\infty}^{\infty} e^{-x^{2}}\,dx\right)\!\left(\int_{-\infty}^{\infty} e^{-y^{2}}\,dy\right) \\
&= \int_{-\infty}^{\infty}\!\int_{-\infty}^{\infty} e^{-(x^{2}+y^{2})}\,dx\,dy \\
&= \int_{0}^{2\pi}\!\!\int_{0}^{\infty} e^{-r^{2}}\, r \,dr\,d\theta \\
&= 2\pi \cdot \left[-\tfrac{1}{2} e^{-r^{2}}\right]_{0}^{\infty} \\
&= \pi.
\end{align}

Taking the positive square root gives $I = \sqrt{\pi}$. $\blacksquare$

## 5. \`gather\` environment

Maxwell's equations in differential form, in vacuum:

\begin{gather}
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_{0}} \\
\nabla \cdot \mathbf{B} = 0 \\
\nabla \times \mathbf{E} = -\,\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} = \mu_{0}\mathbf{J} + \mu_{0}\varepsilon_{0}\,\frac{\partial \mathbf{E}}{\partial t}
\end{gather}

## 6. \`multline\` environment

A long expression that needs to break across lines:

\begin{multline}
(a + b + c + d)^{4} \;=\; a^{4} + 4a^{3}b + 4a^{3}c + 4a^{3}d + 6a^{2}b^{2} + 12a^{2}bc + 12a^{2}bd \\
+\, 6a^{2}c^{2} + 12a^{2}cd + 6a^{2}d^{2} + 4ab^{3} + 12ab^{2}c + 12ab^{2}d + 12abc^{2} \\
+\, 24abcd + 12abd^{2} + 4ac^{3} + 12ac^{2}d + 12acd^{2} + 4ad^{3} + b^{4} + \cdots + d^{4}
\end{multline}

## 7. Starred (unnumbered) variants

\begin{align*}
\sum_{k=0}^{n} \binom{n}{k} &= 2^{n} \\
\sum_{k=0}^{n} (-1)^{k}\binom{n}{k} &= 0 \\
\sum_{k=0}^{n} k\binom{n}{k} &= n \, 2^{n-1}
\end{align*}

---

End of showcase. Each block above was rendered as an image; inline math was kept as plain text.`;
