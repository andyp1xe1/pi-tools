import { tmpdir } from "node:os";
import path from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const CUSTOM_TYPE = "latex-renderer";
export const RENDER_MODE_FLAG = "latex-render-mode";

export const CACHE_DIR = path.join(process.env.HOME ?? tmpdir(), ".cache", "pi-latex-renderer");
export const CACHE_VERSION = 7;
export const TEMP_DIR_PREFIX = "pi-latex-";

export const RENDER_DPI = 360;
export const DISPLAY_SCALE = 0.42;
export const MAX_WIDTH_CELLS = 90;
export const FORMULA_MARGIN_TOP_LINES = 1;
export const FORMULA_MARGIN_BOTTOM_LINES = 1;
export const FORMULA_HORIZONTAL_ALIGN: "left" | "center" = "center";
export const PREVIEW_BORDER = "2pt";

// Theme color key, or a CSS-style hex color such as "#bdae93".
export const FORMULA_COLOR: ThemeColor | `#${string}` = "#ebdbb2";
export const PNG_MIME = "image/png";

export const LATEX_TIMEOUT_MS = 10_000;
export const LATEX_MAX_BUFFER = 1024 * 1024;
export const LATEX_SOURCE_FILE = "formula.tex";
export const LATEX_DVI_FILE = "formula.dvi";
export const LATEX_PNG_FILE = "formula.png";
export const DVIPNG_TRUECOLOR = true;

export const LATEX_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
]);
