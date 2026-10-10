// What the page and the diagram worker say to each other: one drawing asked for, and what it came
// to. Both sides import these shapes, so a message is checked by the compiler on each end.

import type { DiagramPalette } from "../palette.js";

/**
 * Which picture to draw: the one shown on screen, or the one a copy paints on a canvas, which
 * carries no HTML labels so the canvas stays readable.
 */
export type DiagramPictureKind = "shown" | "copied";

/** A diagram drawn: its picture's SVG markup, its natural size and the ground it sits on. */
export interface DrawnDiagram {
  readonly kind: "drawn";
  /** The SVG picture, as a standalone document. */
  readonly markup: string;
  /** The picture's natural width, in CSS pixels. */
  readonly width: number;
  /** The picture's natural height, in CSS pixels. */
  readonly height: number;
  /** The ground it was drawn for, `#rrggbb`, which a copy of it is painted on. */
  readonly groundColor: string;
}

/** A diagram that could not be drawn, and why, in one line. */
export interface FailedDiagram {
  readonly kind: "failed";
  readonly reason: string;
}

/** What drawing one diagram came to: its picture, or the reason it has none. */
export type DiagramOutcome = DrawnDiagram | FailedDiagram;

/** One drawing the page asks the worker for. */
export interface DiagramDrawRequest {
  readonly kind: "draw";
  /** Pairs the reply with this request. */
  readonly requestId: number;
  /** The source, already cleaned for the parser. */
  readonly source: string;
  readonly palette: DiagramPalette;
  readonly pictureKind: DiagramPictureKind;
}

/** A face labels are drawn in: the canvas font shorthand and its spacing, in CSS pixels. */
export interface LabelFace {
  readonly font: string;
  readonly letterSpacingPx: number;
  readonly wordSpacingPx: number;
}

/** Labels to measure in one face; an empty text asks for the face's line height alone. */
export interface LabelMeasureRequest {
  readonly face: LabelFace;
  readonly texts: readonly string[];
}

/**
 * One face's measurements: its line height, the ascent plus descent, and each text's advance in
 * the order the texts are listed, all in CSS pixels.
 */
export interface LabelMeasurements {
  readonly face: LabelFace;
  readonly lineHeight: number;
  readonly texts: readonly string[];
  readonly widths: readonly number[];
}

/** The worker asking the page to measure labels, so a drawing can be sized in the page's faces. */
export interface LabelMeasureAsk {
  readonly status: "measure-labels";
  /** Pairs the page's answer with this ask. */
  readonly askId: number;
  /** The drawing the ask belongs to, while it is still being drawn. */
  readonly requestId: number;
  readonly labels: readonly LabelMeasureRequest[];
}

/** The page's answer to one ask. */
export interface LabelMeasureAnswer {
  readonly kind: "label-widths";
  readonly askId: number;
  readonly measurements: readonly LabelMeasurements[];
}

/** Everything the page sends the worker. */
export type DiagramWorkerRequest = DiagramDrawRequest | LabelMeasureAnswer;

/**
 * What the worker says once merman has loaded, or failed to, which it says before any drawing's
 * reply. A failed load ends the worker.
 */
export type DiagramLibraryLoad =
  | { readonly status: "loaded" }
  | { readonly status: "load-failed"; readonly reason: string };

/**
 * What one drawing in the worker came to: the diagram's own outcome; a picture whose labels merman
 * measured by its own rules because the page's widths came too late; or merman's deadline passing
 * first. Only the diagram's own outcome is kept.
 */
export type DiagramDrawing =
  | { readonly status: "settled"; readonly outcome: DiagramOutcome }
  | { readonly status: "unmeasured"; readonly outcome: DrawnDiagram }
  | { readonly status: "timed-out" };

/**
 * The worker's answer to one request: what the drawing came to, or that the drawing library
 * itself failed (it did not load, or a drawing left it unusable), after which the page ends this
 * worker and starts another.
 */
export type DiagramDrawReply =
  | (DiagramDrawing & { readonly requestId: number })
  | { readonly requestId: number; readonly status: "library-failed"; readonly reason: string };

/** Everything the worker sends the page. */
export type DiagramWorkerReply = DiagramLibraryLoad | DiagramDrawReply | LabelMeasureAsk;

/**
 * How long one drawing may run, in milliseconds, before merman stops it at its next checkpoint.
 * The longest common diagram measured under 40 ms, so this leaves room for a slower machine and a
 * large diagram while one runaway drawing holds the single queue for no more than this.
 */
export const DRAWING_DEADLINE_MS = 1500;

/**
 * How long a drawing waits for the page to measure its labels before it is drawn with merman's own
 * measurer, in milliseconds. A cold batch measured under 7 ms; the rest is room for the page to
 * find an idle moment, so a busy page delays a picture by no more than this.
 */
export const LABEL_WAIT_MS = 400;

/**
 * The bytes of label widths the worker keeps, inside the pictures' share of memory. Each width
 * costs its face and text, about a hundred bytes, so this holds some twenty thousand labels.
 */
export const LABEL_WIDTH_CACHE_BYTES: number = 2 * 1024 * 1024;
