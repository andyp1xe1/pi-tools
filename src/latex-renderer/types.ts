export type RenderMode = "message" | "tool";

export type RenderedFormula = {
  tex: string;
  png?: string;
  error?: string;
};

export type RenderSegment = { type: "markdown"; markdown: string } | { type: "formula"; formula: RenderedFormula };

export type LatexDetails = {
  segments: RenderSegment[];
};

export type LatexBlock = {
  start: number;
  end: number;
  tex: string;
  wrapDisplay: boolean;
};

export type RGB = {
  r: number;
  g: number;
  b: number;
};
