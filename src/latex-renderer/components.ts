import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getCellDimensions,
  getImageDimensions,
  Image,
  type ImageDimensions,
  Markdown,
  Text,
} from "@earendil-works/pi-tui";
import {
  DISPLAY_SCALE,
  FORMULA_HORIZONTAL_ALIGN,
  FORMULA_MARGIN_BOTTOM_LINES,
  FORMULA_MARGIN_TOP_LINES,
  MAX_WIDTH_CELLS,
  PNG_MIME,
} from "./config.ts";
import type { RenderedFormula, RenderSegment } from "./types.ts";

export class EmptyComponent implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

export class RenderLatexMessage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private container?: Container;
  private segments: RenderSegment[];
  private theme: Theme;

  constructor(segments: RenderSegment[], theme: Theme) {
    this.segments = segments;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const container = new Container();
    for (const segment of this.segments) {
      if (segment.type === "markdown") {
        const markdown = segment.markdown.trim();
        if (markdown) container.addChild(new Markdown(markdown, 0, 0, getMarkdownTheme()));
      } else {
        container.addChild(new FormulaImage(segment.formula, this.theme));
      }
    }

    this.container = container;
    this.cachedWidth = width;
    this.cachedLines = container.render(width);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.container?.invalidate();
  }
}

class FormulaImage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private formula: RenderedFormula;
  private theme: Theme;

  constructor(formula: RenderedFormula, theme: Theme) {
    this.formula = formula;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const content = this.formula.png
      ? this.renderImage(width, this.formula.png)
      : this.renderError(this.formula.error ?? "render failed", width);
    const lines = withVerticalMargin(content);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private renderImage(width: number, pngBase64: string): string[] {
    const dimensions = getImageDimensions(pngBase64, PNG_MIME);
    if (!dimensions) return this.renderError("invalid PNG dimensions", width);

    const cells = naturalCellSize(dimensions);
    const displayedColumns = Math.max(1, Math.min(Math.max(1, width - 2), MAX_WIDTH_CELLS, cells.columns));
    const image = new Image(
      pngBase64,
      PNG_MIME,
      { fallbackColor: (text: string) => this.theme.fg("dim", text) },
      {
        maxWidthCells: displayedColumns,
        maxHeightCells: cells.rows,
      },
      dimensions,
    );
    return alignLines(image.render(width), width, displayedColumns);
  }

  private renderError(error: string, width: number): string[] {
    return new Text(this.theme.fg("error", `LaTeX render error: ${error}`), 0, 0).render(width);
  }
}

function naturalCellSize(dimensions: ImageDimensions): { columns: number; rows: number } {
  const cell = getCellDimensions();
  return {
    columns: Math.max(1, Math.ceil((dimensions.widthPx * DISPLAY_SCALE) / cell.widthPx)),
    rows: Math.max(1, Math.ceil((dimensions.heightPx * DISPLAY_SCALE) / cell.heightPx)),
  };
}

function alignLines(lines: string[], width: number, displayedColumns: number): string[] {
  if (FORMULA_HORIZONTAL_ALIGN !== "center") return lines;

  const indent = Math.max(0, Math.floor((width - displayedColumns) / 2));
  if (indent === 0) return lines;

  const prefix = " ".repeat(indent);
  return lines.map((line) => (line ? prefix + line : line));
}

function withVerticalMargin(lines: string[]): string[] {
  return [
    ...Array.from({ length: FORMULA_MARGIN_TOP_LINES }, () => ""),
    ...lines,
    ...Array.from({ length: FORMULA_MARGIN_BOTTOM_LINES }, () => ""),
  ];
}
