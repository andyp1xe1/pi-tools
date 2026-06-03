import type { Theme } from "@earendil-works/pi-coding-agent";
import { dvipngForeground } from "./color.ts";
import { renderFormula } from "./latex.ts";
import { extractBlockLatex } from "./parser.ts";
import type { RenderSegment } from "./types.ts";

export async function buildSegments(markdown: string, theme: Theme): Promise<RenderSegment[]> {
  const blocks = extractBlockLatex(markdown);
  if (blocks.length === 0) return [{ type: "markdown", markdown }];

  const foreground = dvipngForeground(theme);
  const formulas = await Promise.all(blocks.map((block) => renderFormula(block.tex, foreground, block.wrapDisplay)));
  const segments: RenderSegment[] = [];
  let cursor = 0;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const before = markdown.slice(cursor, block.start);
    if (before.trim()) segments.push({ type: "markdown", markdown: before });
    segments.push({ type: "formula", formula: formulas[index] });
    cursor = block.end;
  }

  const rest = markdown.slice(cursor);
  if (rest.trim()) segments.push({ type: "markdown", markdown: rest });
  return segments;
}
