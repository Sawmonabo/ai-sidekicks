// A block's height before it is drawn, from its lines and the body's type. It stands only until the
// block measures, but every pixel it is off moves what is below it, so it counts line boxes: a code
// fence by its source lines, prose by the lines its text wraps to at the body's width. It reads the
// lengths of the block's lines, never its text, so a new width estimates again from them alone.

import { READING_LINE_HEIGHT, TYPE_SCALE_REM } from "#renderer/styles/typography.js";

/** The body's type, as an estimate reads it. */
export interface BlockTypography {
  readonly fontSizePx: number;
  readonly lineHeightPx: number;
  /** The body's content width, or `undefined` before the body is laid out. */
  readonly widthPx: number | undefined;
}

/** CSS's initial root size, which the type scale's rem steps are named at. */
const DEFAULT_ROOT_FONT_SIZE_PX = 16;

/** A reply's type at the default root: what a body is estimated at before it measures its own. */
export const DEFAULT_BLOCK_TYPOGRAPHY: BlockTypography = {
  fontSizePx: (TYPE_SCALE_REM["text-sm"] ?? 1) * DEFAULT_ROOT_FONT_SIZE_PX,
  lineHeightPx: (TYPE_SCALE_REM["text-sm"] ?? 1) * DEFAULT_ROOT_FONT_SIZE_PX * READING_LINE_HEIGHT,
  widthPx: undefined,
};

/** A block opening on a code fence, which an estimate counts by its source lines. */
export const FENCE_OPENER: RegExp = /^ {0,3}(?:`{3,}|~{3,})/u;

/**
 * A block's estimated height, in CSS pixels, at the given type, from the lengths of its lines
 * (`measureLineLengths`) and whether it opens on a code fence (`FENCE_OPENER`).
 */
export function estimateBlockHeightPx(
  lineLengths: Uint32Array,
  isFence: boolean,
  typography: BlockTypography,
): number {
  if (isFence) {
    return (lineLengths.length + CODE_BLOCK_CHROME_LINES) * typography.lineHeightPx;
  }
  const charactersPerLine = Math.max(
    1,
    Math.floor(proseMeasurePx(typography) / averageAdvancePx(typography)),
  );
  let wrappedLines = 0;
  for (const length of lineLengths) {
    wrappedLines += Math.max(1, Math.ceil(length / charactersPerLine));
  }
  return (wrappedLines + PROSE_BLOCK_GAP_LINES) * typography.lineHeightPx;
}

/**
 * Hands `take` the length of each line of `text` an estimate counts, in UTF-16 code units, in
 * order: every line but the empty ones its trailing line breaks end on, and one empty line for an
 * empty text.
 */
export function measureLineLengths(text: string, take: (length: number) => void): void {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === LINE_FEED) {
    end -= 1;
  }
  let lineStart = 0;
  for (;;) {
    const lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1 || lineEnd >= end) {
      take(end - lineStart);
      return;
    }
    take(lineEnd - lineStart);
    lineStart = lineEnd + 1;
  }
}

/** The lengths of `text`'s lines as `measureLineLengths` counts them, for a text read once. */
export function lineLengthsOf(text: string): Uint32Array {
  const lengths: number[] = [];
  measureLineLengths(text, (length) => {
    lengths.push(length);
  });
  return Uint32Array.from(lengths);
}

/** The line feed's code unit. */
const LINE_FEED = 0x0a;

/** The line boxes a code block's frame adds around its lines: its padding and its bar. */
const CODE_BLOCK_CHROME_LINES = 2;

/** The margin below a prose block, in line boxes: half of one. */
const PROSE_BLOCK_GAP_LINES = 0.5;

/** A paragraph's measure: the reading column's 68ch, at a zero's advance of about 0.55 em. */
const PROSE_MEASURE_EM = 68 * 0.55;

/** The reading face's average advance, about half an em across mixed lowercase prose. */
const AVERAGE_ADVANCE_EM = 0.5;

function proseMeasurePx(typography: BlockTypography): number {
  const measurePx = PROSE_MEASURE_EM * typography.fontSizePx;
  return typography.widthPx === undefined ? measurePx : Math.min(measurePx, typography.widthPx);
}

function averageAdvancePx(typography: BlockTypography): number {
  return AVERAGE_ADVANCE_EM * typography.fontSizePx;
}
