import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CACHE_DIR,
  CACHE_VERSION,
  DVIPNG_TRUECOLOR,
  LATEX_DVI_FILE,
  LATEX_MAX_BUFFER,
  LATEX_PNG_FILE,
  LATEX_SOURCE_FILE,
  LATEX_TIMEOUT_MS,
  PREVIEW_BORDER,
  RENDER_DPI,
  TEMP_DIR_PREFIX,
} from "./config.ts";
import type { RenderedFormula } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function renderFormula(tex: string, foreground: string, wrapDisplay: boolean): Promise<RenderedFormula> {
  const key = createHash("sha256")
    .update(JSON.stringify({ tex, foreground, wrapDisplay, dpi: RENDER_DPI, version: CACHE_VERSION }))
    .digest("hex");
  const pngPath = path.join(CACHE_DIR, `${key}.png`);
  await fs.mkdir(CACHE_DIR, { recursive: true });

  try {
    const cached = await fs.readFile(pngPath);
    return { tex, png: cached.toString("base64") };
  } catch {
    // cache miss
  }

  const dir = await fs.mkdtemp(path.join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    await fs.writeFile(
      path.join(dir, LATEX_SOURCE_FILE),
      latexDocument(wrapDisplay ? tightDisplayMath(tex) : tex),
      "utf8",
    );

    await execFileAsync("latex", ["-interaction=nonstopmode", LATEX_SOURCE_FILE], {
      cwd: dir,
      timeout: LATEX_TIMEOUT_MS,
      maxBuffer: LATEX_MAX_BUFFER,
    });
    await execFileAsync(
      "dvipng",
      [
        "-T",
        "tight",
        "-D",
        String(RENDER_DPI),
        "-bg",
        "Transparent",
        "-fg",
        foreground,
        ...(DVIPNG_TRUECOLOR ? ["--truecolor"] : []),
        "-o",
        LATEX_PNG_FILE,
        LATEX_DVI_FILE,
      ],
      {
        cwd: dir,
        timeout: LATEX_TIMEOUT_MS,
        maxBuffer: LATEX_MAX_BUFFER,
      },
    );

    const png = await fs.readFile(path.join(dir, LATEX_PNG_FILE));
    await fs.writeFile(pngPath, png);
    return { tex, png: png.toString("base64") };
  } catch (error: unknown) {
    return { tex, error: latexError(error) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function tightDisplayMath(tex: string): string {
  return `\\(\\displaystyle ${tex}\\)`;
}

function latexError(error: unknown): string {
  const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return (
    String(err.stderr || err.stdout || err.message || error)
      .split("\n")
      .slice(0, 3)
      .join(" ") || "unknown error"
  );
}

function latexDocument(body: string): string {
  return String.raw`\documentclass[12pt]{article}
\usepackage[active,tightpage]{preview}
\usepackage{amsmath,amssymb,mathtools,bm}
\setlength\PreviewBorder{${PREVIEW_BORDER}}
\pagestyle{empty}
\begin{document}
\begin{preview}
${body}
\end{preview}
\end{document}
`;
}
