import { LATEX_ENVIRONMENTS } from "./config.ts";
import type { LatexBlock } from "./types.ts";

export function extractBlockLatex(input: string): LatexBlock[] {
  const masked = maskCodeBlocks(input);
  const blocks: LatexBlock[] = [];
  let index = 0;

  while (index < masked.length) {
    if (isEscaped(masked, index)) {
      index++;
      continue;
    }

    const dollarBlock = readDelimitedBlock(input, masked, index, "$$", "$$");
    if (dollarBlock) {
      blocks.push(dollarBlock);
      index = dollarBlock.end;
      continue;
    }

    const bracketBlock = readDelimitedBlock(input, masked, index, "\\[", "\\]");
    if (bracketBlock) {
      blocks.push(bracketBlock);
      index = bracketBlock.end;
      continue;
    }

    const environmentBlock = readEnvironmentBlock(input, masked, index);
    if (environmentBlock) {
      blocks.push(environmentBlock);
      index = environmentBlock.end;
      continue;
    }

    index++;
  }

  return blocks;
}

function readDelimitedBlock(
  input: string,
  masked: string,
  start: number,
  open: string,
  close: string,
): LatexBlock | undefined {
  if (!masked.startsWith(open, start)) return undefined;

  const bodyStart = start + open.length;
  const bodyEnd = findUnescaped(masked, close, bodyStart);
  if (bodyEnd === -1) return undefined;

  return latexBlock(start, bodyEnd + close.length, input.slice(bodyStart, bodyEnd), true);
}

function readEnvironmentBlock(input: string, masked: string, start: number): LatexBlock | undefined {
  const env = beginEnvironmentAt(masked, start);
  if (!env) return undefined;

  const open = `\\begin{${env}}`;
  const close = `\\end{${env}}`;
  const bodyStart = start + open.length;
  const bodyEnd = findUnescaped(masked, close, bodyStart);
  if (bodyEnd === -1) return undefined;

  return latexBlock(start, bodyEnd + close.length, input.slice(start, bodyEnd + close.length), false);
}

function beginEnvironmentAt(text: string, index: number): string | undefined {
  const match = text.slice(index).match(/^\\begin\{([^}]+)\}/);
  const env = match?.[1];
  return env && LATEX_ENVIRONMENTS.has(env) ? env : undefined;
}

function latexBlock(start: number, end: number, tex: string, wrapDisplay: boolean): LatexBlock | undefined {
  const trimmed = tex.trim();
  return trimmed ? { start, end, tex: trimmed, wrapDisplay } : undefined;
}

function maskCodeBlocks(input: string): string {
  return input.replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length));
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function findUnescaped(text: string, needle: string, from: number): number {
  let position = text.indexOf(needle, from);
  while (position !== -1) {
    if (!isEscaped(text, position)) return position;
    position = text.indexOf(needle, position + needle.length);
  }
  return -1;
}
