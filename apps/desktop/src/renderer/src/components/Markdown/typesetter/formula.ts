// KaTeX's lazy chunk: the typesetter, its sheet and its fonts. The sheet is imported here so it
// rides this chunk. Each window loads the faces into its own document before a formula is drawn
// there, so a formula is first laid out in its own fonts and its block's height never changes when
// they arrive. A formula's markup is kept once typeset, so a formula drawn again is not typeset
// again. The first formula costs work no later one does: the platform's font fallback starting up,
// then opening each system face the MathML KaTeX draws beside its glyphs falls back to, and
// KaTeX's own code compiling. All of it is paid once, in idle tasks a slice at a time, before any
// formula is drawn, rather than inside the frame that draws the first one. A warm-up that fails is
// recorded and given up: formulas then draw at once and pay that cost themselves.

import "./sheet.scss";

import { ParseError, renderToString } from "katex";

import { describeFailure } from "#shared/failure-message.js";
import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { queueIdleTaskIn } from "#renderer/lib/idle-task.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";
import { startSlice } from "#renderer/lib/work-slices.js";

/**
 * Bytes of typeset markup kept across every formula, charged against the source and the markup.
 * A display formula's markup runs to tens of kilobytes, so this holds the formulas of a long
 * conversation, not every one a session ever drew.
 */
const TYPESET_MARKUP_CACHE_BYTE_CAP = 2_097_152;

/**
 * What joins a formula's mode to its source in the cache key. NUL, which no formula a person can
 * read holds, so two different pairs never join to one key.
 */
const TYPESET_KEY_SEPARATOR = "\u0000";

const typesetMarkupCache = new ByteBoundedCache<string>(
  TYPESET_MARKUP_CACHE_BYTE_CAP,
  measureUtf8ByteLength,
);

/**
 * KaTeX's markup for one formula: its HTML, with its MathML beside it for assistive technology and
 * copying; `undefined` when the source does not parse. Any other KaTeX failure is thrown.
 */
export function typesetFormula(source: string, isDisplayMode: boolean): string | undefined {
  const key = `${isDisplayMode ? "display" : "inline"}${TYPESET_KEY_SEPARATOR}${source}`;
  const kept = typesetMarkupCache.get(key);
  if (kept !== undefined) {
    return kept;
  }
  try {
    const markup = renderMarkup(source, isDisplayMode);
    typesetMarkupCache.set(key, markup);
    return markup;
  } catch (error) {
    if (error instanceof ParseError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Make `windowDocument` ready to draw formulas in: every KaTeX face it declares loaded, then, once
 * for the app, the first-formula work done in idle tasks of that window. A window lays its formulas
 * out in its own document, whose faces load only when asked or first used, and a face first used
 * mid-layout lays the formula out in fallback fonts and moves it when the face arrives.
 */
export async function prepareMathDrawing(windowDocument: Document): Promise<void> {
  await Promise.all(
    [...windowDocument.fonts]
      .filter((face) => face.family.includes("KaTeX_"))
      .map((face) => face.load()),
  );
  const view = windowDocument.defaultView;
  if (view === null) {
    throw new Error("A formula was readied in a document with no window.");
  }
  await mathWarmUp.warm(view);
}

/**
 * The first-formula work, done once for the app: starting the platform's font fallback, opening
 * each system face it picks for KaTeX's symbols, then compiling KaTeX's code, in idle tasks of the
 * window that first draws a formula. A failure is recorded in the window's diagnostics and the
 * warm-up counts as done, so no formula waits on it again.
 */
class MathWarmUp {
  #warmed: Promise<void> | undefined;

  public warm(view: Window): Promise<void> {
    this.#warmed ??= this.#warmIn(view).catch((failure: unknown) => {
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(new RealClock()),
        severity: "warning",
        source: MATH_WARM_UP_SOURCE,
        kind: "math-warm-up-failed",
        detail: `Warm up the formula typesetter: ${describeFailure(failure)}`,
      });
    });
    return this.#warmed;
  }

  async #warmIn(view: Window): Promise<void> {
    // The MathML beside the glyphs is drawn in the platform's math face, which lacks most of
    // KaTeX's symbols, so laying them out asks the platform's fallback for another face. Its first
    // answer starts the fallback up, measured at 5 to 7 ms once per app, and each face it answers
    // with costs up to 2 ms the first time it is opened. Measuring a symbol pays for its face.
    const context = await runInIdleTask(view, () => {
      const created = new OffscreenCanvas(1, 1).getContext("2d");
      if (created === null) {
        throw new Error("An offscreen canvas gave no 2D context.");
      }
      created.font = FALLBACK_WARM_UP_FONT;
      created.measureText(MATH_FACE_WARM_UP_TEXT);
      return created;
    });
    let measuredCount = 0;
    while (measuredCount < FALLBACK_WARM_UP_SYMBOLS.length) {
      const from = measuredCount;
      measuredCount = await runInIdleTask(view, () => measureSymbolsFrom(context, from));
    }
    // KaTeX compiles each part of its code on first use; a formula touching the common parts
    // compiles them here, so the first real formula typesets at a warm formula's cost.
    await runInIdleTask(view, () => renderMarkup(KATEX_WARM_UP_FORMULA, true));
  }
}

const mathWarmUp = new MathWarmUp();

/** Where a failed warm-up is recorded from. */
const MATH_WARM_UP_SOURCE = "components/Markdown/typesetter";

/** The face the warm-up measures in: the platform's math face, which MathML is drawn in. */
const FALLBACK_WARM_UP_FONT = "16px math";

/** A letter the platform's math face draws itself, so its own opening is a step of its own. */
const MATH_FACE_WARM_UP_TEXT = "x";

/**
 * One symbol from each Unicode block KaTeX defines symbols in, the first it defines there, so
 * whatever face a platform falls back to for a block is opened, on any platform. The first, a
 * mathematical italic small x, is how the MathML draws a single-letter variable.
 */
const FALLBACK_WARM_UP_SYMBOLS: readonly string[] = [
  "\u{1D465}",
  "\u00A7",
  "\u0131",
  "\u02CA",
  "\u03DD",
  "\u2020",
  "\u20D7",
  "\u2135",
  "\u21D0",
  "\u2261",
  "\u2323",
  "\u24C8",
  "\u2571",
  "\u25EF",
  "\u266D",
  "\u2713",
  "\u27EF",
  "\u27F5",
  "\u29EB",
  "\u2AAF",
  "\uE010",
];

/** A formula touching KaTeX's common parts: scripts, a sum, a fraction, a root, delimiters. */
const KATEX_WARM_UP_FORMULA = String.raw`\sum_{i=1}^{n} \frac{x_i}{\sqrt{y}} \le \left\lceil \alpha \right\rceil`;

/** KaTeX's markup for one formula, or a thrown `ParseError` when the source does not parse. */
function renderMarkup(source: string, isDisplayMode: boolean): string {
  return renderToString(source, {
    displayMode: isDisplayMode,
    output: "htmlAndMathml",
    trust: false,
    strict: false,
    // With `throwOnError: false` KaTeX resolves with its own error rendering, which would make the
    // caller's unrenderable arm unreachable; throwing is the only signal of a parse failure.
    throwOnError: true,
  });
}

/**
 * Measures the warm-up symbols from `from` on for one slice, at least one, and answers how many
 * are measured in all. A face opening runs past the slice by its own cost at most.
 */
function measureSymbolsFrom(context: OffscreenCanvasRenderingContext2D, from: number): number {
  const hasTime = startSlice();
  let measuredCount = from;
  for (const symbol of FALLBACK_WARM_UP_SYMBOLS.slice(from)) {
    context.measureText(symbol);
    measuredCount += 1;
    if (!hasTime()) {
      break;
    }
  }
  return measuredCount;
}

/** Run `step` alone in an idle task of `view`; rejects with what it throws. */
function runInIdleTask<TResult>(view: Window, step: () => TResult): Promise<TResult> {
  return new Promise((resolve, reject) => {
    queueIdleTaskIn(view, () => {
      try {
        resolve(step());
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}
