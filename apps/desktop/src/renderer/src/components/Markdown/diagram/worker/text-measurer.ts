// Measures a diagram's labels in the worker from widths the page measured, in the faces the picture
// draws with. The worker loads no face of its own: each drawing pass answers merman from the width
// cache, and a label the cache lacks is answered unhandled, so merman measures it by its own rules,
// and recorded for the page to measure. A box is sized from an SVG text box, whose height is the
// face's ascent plus descent and whose width is the advance, which is what the page's canvas
// reports. A wrapped line's width is the sum of its words and the spaces between them.

import type {
  HostTextMeasureRequest,
  HostTextMeasureResult,
  HostTextMeasurer,
} from "@mermanjs/web-render";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import {
  LABEL_WIDTH_CACHE_BYTES,
  type LabelFace,
  type LabelMeasureRequest,
  type LabelMeasurements,
} from "./messages.js";

/** One drawing pass's measurer, and the labels it was asked for that the cache lacked. */
export interface LabelMeasuringPass {
  readonly measurer: HostTextMeasurer;
  /** The labels to measure on the page, grouped by face. */
  misses(): LabelMeasureRequest[];
}

/**
 * The widths the page measured, kept across drawings under a byte bound, least recently used
 * first to go. Each face's line height is kept beside its widths.
 */
export class LabelWidths {
  readonly #widths = new ByteBoundedCache<number>(LABEL_WIDTH_CACHE_BYTES, () => WIDTH_BYTES);

  /** Keep what the page measured. */
  public fill(measurements: readonly LabelMeasurements[]): void {
    for (const { face, lineHeight, widths, texts } of measurements) {
      const faceKey = faceKeyOf(face);
      this.#widths.set(lineHeightKeyOf(faceKey), lineHeight);
      texts.forEach((text, index) => {
        const width = widths[index];
        if (text !== "" && width !== undefined) {
          this.#widths.set(widthKeyOf(faceKey, text), width);
        }
      });
    }
  }

  /** A measurer for one drawing pass, where a request naming no face takes `defaultFontFamily`. */
  public pass(defaultFontFamily: string): LabelMeasuringPass {
    const pass = new CachedTextMeasurer(this.#widths, defaultFontFamily);
    return { measurer: (request) => pass.measure(request), misses: () => pass.misses() };
  }
}

/** What a cached width costs beyond its key, in bytes. */
const WIDTH_BYTES = 8;

const UNHANDLED: HostTextMeasureResult = { handled: false };

/** What separates explicit lines in a label: a line feed or an HTML line break. */
const EXPLICIT_LINE_BREAK = /<br\s*\/?>|\r?\n/giu;

/** One drawing pass over the cache: the face in use and every miss so far. */
class CachedTextMeasurer {
  readonly #widths: ByteBoundedCache<number>;
  readonly #defaultFontFamily: string;
  /** Missed texts, by face key, with the face they belong to. */
  readonly #misses = new Map<string, { readonly face: LabelFace; readonly texts: Set<string> }>();
  #face: LabelFace = { font: "", letterSpacingPx: 0, wordSpacingPx: 0 };
  #faceKey = "";
  #collapsesWhitespace = true;
  /** Whether the request being answered needed a measurement the cache lacks. */
  #isIncomplete = false;

  public constructor(widths: ByteBoundedCache<number>, defaultFontFamily: string) {
    this.#widths = widths;
    this.#defaultFontFamily = defaultFontFamily;
  }

  public misses(): LabelMeasureRequest[] {
    return [...this.#misses.values()].map(({ face, texts }) => ({ face, texts: [...texts] }));
  }

  public measure(request: HostTextMeasureRequest): HostTextMeasureResult {
    this.#face = faceOf(request, this.#defaultFontFamily);
    this.#faceKey = faceKeyOf(this.#face);
    this.#collapsesWhitespace = request.white_space !== "break-spaces";
    this.#isIncomplete = false;
    const result = this.#answer(request);
    return this.#isIncomplete ? UNHANDLED : result;
  }

  #answer(request: HostTextMeasureRequest): HostTextMeasureResult {
    switch (request.operation) {
      case "measure":
      case "mermaid-calculate-text-dimensions": {
        const width = this.#lineWidthOf(request.text);
        return {
          kind: "metrics",
          width,
          height: width === 0 ? 0 : this.#lineHeight(),
          line_count: 1,
        };
      }
      case "computed-length":
      case "simple-bbox-width":
      case "wrap-probe-bbox-width":
      case "raw-bbox-width":
      case "tspan-bbox-width":
      case "bounding-client-rect-width":
      case "canvas-measure-text-width":
        return { kind: "length", length: this.#lineWidthOf(request.text) };
      case "raw-bbox-height":
      case "tspan-bbox-height":
      case "simple-bbox-height":
        return { kind: "length", length: request.text === "" ? 0 : this.#lineHeight() };
      case "bbox-x":
      case "bbox-x-with-ascii-overhang":
      case "title-bbox-x": {
        // Drawn centered on its anchor, the box reaches half the advance either side.
        const half = this.#lineWidthOf(request.text) / 2;
        return { kind: "horizontal-extents", bbox_left: half, bbox_right: half };
      }
      case "wrapped":
        return { kind: "metrics", ...this.#wrapped(request).metrics };
      case "wrapped-with-raw-width": {
        const wrapped = this.#wrapped(request);
        return { kind: "wrapped-with-raw-width", ...wrapped.metrics, raw_width: wrapped.rawWidth };
      }
      case "create-text-bbox-y-offset":
      case "create-text-middle-bbox-y-offset":
        return UNHANDLED;
    }
  }

  /**
   * The cached measurement under `key`, or 0 with the request marked incomplete and `text` missed.
   */
  #cached(key: string, text: string): number {
    const value = this.#widths.get(key);
    if (value !== undefined) {
      return value;
    }
    this.#isIncomplete = true;
    let missed = this.#misses.get(this.#faceKey);
    if (missed === undefined) {
      missed = { face: this.#face, texts: new Set() };
      this.#misses.set(this.#faceKey, missed);
    }
    missed.texts.add(text);
    return 0;
  }

  /** The face's ascent plus descent, which the page reports with any text measured in it. */
  #lineHeight(): number {
    return this.#cached(lineHeightKeyOf(this.#faceKey), "");
  }

  /** The advance of `text` as drawn: its runs of white space collapsed and its ends trimmed. */
  #lineWidthOf(text: string): number {
    const drawn = this.#collapsesWhitespace ? text.replace(/\s+/gu, " ").trim() : text;
    return drawn === "" ? 0 : this.#cached(widthKeyOf(this.#faceKey, drawn), drawn);
  }

  /** The advance of a line of `words`, as the words and the spaces between them. */
  #wordsWidthOf(words: readonly string[]): number {
    const spaces = Math.max(0, words.length - 1);
    const spaceWidth = spaces === 0 ? 0 : this.#cached(widthKeyOf(this.#faceKey, SPACE), SPACE);
    return words.reduce((sum, word) => sum + this.#lineWidthOf(word), spaces * spaceWidth);
  }

  /**
   * A label set on lines no wider than its maximum, broken at spaces and, where a word is wider
   * than a line, inside it. An HTML label's lines are one line height apart; an SVG label spans
   * from the first line's top to the last line's foot.
   */
  #wrapped(request: HostTextMeasureRequest): {
    readonly metrics: { width: number; height: number; line_count: number };
    readonly rawWidth: number;
  } {
    const maxWidth =
      request.has_max_width && typeof request.max_width === "number" && request.max_width > 0
        ? request.max_width
        : undefined;
    const explicitLines = request.text.split(EXPLICIT_LINE_BREAK);
    const rawWidth = Math.max(0, ...explicitLines.map((line) => this.#lineWidthOf(line)));
    const wrappedLines =
      maxWidth === undefined
        ? undefined
        : explicitLines.flatMap((line) =>
            this.#wrapLine(wordsOf(line), maxWidth, request.wrap_mode === "svg-like"),
          );
    const width =
      wrappedLines === undefined
        ? rawWidth
        : Math.max(0, ...wrappedLines.map((line) => this.#wordsWidthOf(line)));
    const lineCount = Math.max(1, wrappedLines?.length ?? explicitLines.length);
    if (request.wrap_mode === "html-like") {
      const lineHeight = Math.max(1, request.line_height || request.font_size);
      return {
        metrics: {
          width: maxWidth !== undefined && rawWidth > maxWidth ? Math.max(maxWidth, width) : width,
          height: lineCount * lineHeight,
          line_count: lineCount,
        },
        rawWidth,
      };
    }
    const lineAdvance = Math.max(1, request.line_height);
    return {
      metrics: {
        width,
        height: request.text === "" ? 0 : (lineCount - 1) * lineAdvance + this.#lineHeight(),
        line_count: lineCount,
      },
      rawWidth,
    };
  }

  /** `words` set on lines no wider than `maxWidth`, each line as its words. */
  #wrapLine(words: readonly string[], maxWidth: number, breaksLongWords: boolean): string[][] {
    const lines: string[][] = [];
    let current: string[] = [];
    for (const word of words) {
      if (this.#wordsWidthOf([...current, word]) <= maxWidth) {
        current.push(word);
        continue;
      }
      if (current.length > 0) {
        lines.push(current);
      }
      if (!breaksLongWords || this.#lineWidthOf(word) <= maxWidth) {
        current = [word];
        continue;
      }
      let piece = "";
      for (const grapheme of graphemesOf(word)) {
        const extended = piece + grapheme;
        if (piece !== "" && this.#lineWidthOf(extended) > maxWidth) {
          lines.push([piece]);
          piece = grapheme;
        } else {
          piece = extended;
        }
      }
      current = piece === "" ? [] : [piece];
    }
    if (current.length > 0) {
      lines.push(current);
    }
    return lines.length === 0 ? [[]] : lines;
  }
}

/** The one space between words, measured on its own. */
const SPACE = " ";

/** What separates the parts of a cache key; it occurs in no font shorthand. */
const KEY_SEPARATOR = "\u0000";

/** The face a request is drawn in, as the canvas font shorthand and its spacing. */
function faceOf(request: HostTextMeasureRequest, defaultFontFamily: string): LabelFace {
  const fontSize = Number.isFinite(request.font_size) ? Math.max(1, request.font_size) : 16;
  const family = request.font_family ?? defaultFontFamily;
  const weight = request.font_weight ?? "normal";
  return {
    font: `${request.font_style} ${weight} ${String(fontSize)}px ${family}`,
    letterSpacingPx: request.letter_spacing,
    wordSpacingPx: request.word_spacing,
  };
}

function faceKeyOf(face: LabelFace): string {
  return `${face.font}|${String(face.letterSpacingPx)}|${String(face.wordSpacingPx)}`;
}

function widthKeyOf(faceKey: string, text: string): string {
  return faceKey + KEY_SEPARATOR + text;
}

/** The line height sits under a key no text can make, since every text key has a separator. */
function lineHeightKeyOf(faceKey: string): string {
  return faceKey;
}

function wordsOf(line: string): string[] {
  return line.trim().split(/\s+/u).filter(Boolean);
}

function graphemesOf(text: string): string[] {
  return [...new Intl.Segmenter().segment(text)].map(({ segment }) => segment);
}
