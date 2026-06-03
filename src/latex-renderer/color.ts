import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { FORMULA_COLOR } from "./config.ts";
import type { RGB } from "./types.ts";

export function dvipngForeground(theme: Theme): string {
  const rgb = FORMULA_COLOR.startsWith("#") ? hexToRgb(FORMULA_COLOR) : themeColorToRgb(theme, FORMULA_COLOR);
  return `rgb ${rgb.r / 255} ${rgb.g / 255} ${rgb.b / 255}`;
}

function themeColorToRgb(theme: Theme, color: ThemeColor): RGB {
  const rgb = ansiToRgb(theme.getFgAnsi(color));
  if (!rgb) throw new Error(`Theme color ${color} must be an explicit ANSI foreground`);
  return rgb;
}

function hexToRgb(hex: `#${string}`): RGB {
  const match = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) throw new Error(`Invalid FORMULA_COLOR hex: ${hex}`);
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  };
}

function ansiToRgb(ansi: string): RGB | undefined {
  const trueColor = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
  if (trueColor) return { r: byte(trueColor[1]), g: byte(trueColor[2]), b: byte(trueColor[3]) };

  const color256 = ansi.match(/38;5;(\d+)/);
  if (color256) return ansi256ToRgb(byte(color256[1]));

  return undefined;
}

function byte(value: string): number {
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0 && number <= 255) return number;
  throw new Error(`Invalid ANSI byte: ${value}`);
}

const ANSI_16: RGB[] = [
  { r: 0, g: 0, b: 0 },
  { r: 128, g: 0, b: 0 },
  { r: 0, g: 128, b: 0 },
  { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 128 },
  { r: 0, g: 128, b: 128 },
  { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

const ANSI_CUBE = [0, 95, 135, 175, 215, 255];

function ansi256ToRgb(index: number): RGB {
  if (index < 16) return ANSI_16[index];

  if (index < 232) {
    const n = index - 16;
    return {
      r: ANSI_CUBE[Math.floor(n / 36) % 6],
      g: ANSI_CUBE[Math.floor(n / 6) % 6],
      b: ANSI_CUBE[n % 6],
    };
  }

  const gray = 8 + (index - 232) * 10;
  return { r: gray, g: gray, b: gray };
}
