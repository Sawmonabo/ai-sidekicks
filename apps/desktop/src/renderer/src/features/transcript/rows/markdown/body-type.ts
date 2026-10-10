// A markdown body's measure and type, as its resize observation reads them: what its text wraps by.
// Block and table geometry is remembered under it, so a body of the same width at another text
// size recalls nothing measured at the old one.

import { getWindow } from "@floating-ui/utils/dom";

import { DEFAULT_BLOCK_TYPOGRAPHY } from "./block-window/estimate.js";

/** A laid-out body's content width and its text's size and line height, in CSS pixels. */
export interface MarkdownBodyType {
  /** The content width, in whole CSS pixels. */
  readonly widthPx: number;
  readonly fontSizePx: number;
  readonly lineHeightPx: number;
}

/**
 * Reads `body`'s type in its resize observation, after the browser's layout and style, so the read
 * computes nothing; `contentInlineSizePx` is the observed content box's inline size. A size the
 * style does not answer in pixels reads as a reply's default.
 */
export function readMarkdownBodyType(
  body: HTMLElement,
  contentInlineSizePx: number,
): MarkdownBodyType {
  const style = getWindow(body).getComputedStyle(body);
  const fontSizePx = Number.parseFloat(style.fontSize);
  const lineHeightPx = Number.parseFloat(style.lineHeight);
  return {
    widthPx: Math.round(contentInlineSizePx),
    fontSizePx: Number.isFinite(fontSizePx) ? fontSizePx : DEFAULT_BLOCK_TYPOGRAPHY.fontSizePx,
    lineHeightPx: Number.isFinite(lineHeightPx)
      ? lineHeightPx
      : DEFAULT_BLOCK_TYPOGRAPHY.lineHeightPx,
  };
}

/** Whether two readings wrap text alike; either may be unread. */
export function isSameBodyType(
  first: MarkdownBodyType | undefined,
  second: MarkdownBodyType | undefined,
): boolean {
  return (
    first === second ||
    (first !== undefined &&
      second !== undefined &&
      first.widthPx === second.widthPx &&
      first.fontSizePx === second.fontSizePx &&
      first.lineHeightPx === second.lineHeightPx)
  );
}

/** The part of a geometry memory's key a body's type writes. */
export function bodyTypeKeyOf(type: MarkdownBodyType): string {
  return `${String(type.widthPx)}/${String(type.fontSizePx)}/${String(type.lineHeightPx)}`;
}
