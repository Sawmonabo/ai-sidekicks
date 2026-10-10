// KaTeX's lazy chunk: the typesetter, its sheet and its fonts. The sheet is imported here so it
// rides this chunk. Each window loads the faces into its own document before a formula is drawn
// there, so a formula is first laid out in its own fonts and its block's height never changes when
// they arrive. A formula's markup is kept once typeset, so a formula drawn again is not typeset
// again. The first formula costs work no later one does: the platform's font fallback starting up,
// then opening each system face the MathML KaTeX draws beside its glyphs falls back to, and
// KaTeX's own code compiling. All of it is paid once, a step per idle task, before any formula is
// drawn, rather than inside the frame that draws the first one.

import "./sheet.scss";

import { ParseError, renderToString } from "katex";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";

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
 * each system face it picks for KaTeX's symbols, then compiling KaTeX's code, each step alone in an
 * idle task of the window that first draws a formula.
 */
class MathWarmUp {
  #warmed: Promise<void> | undefined;

  public warm(view: Window): Promise<void> {
    if (this.#warmed === undefined) {
      const warmed = this.#warmIn(view);
      this.#warmed = warmed;
      // A failed warm-up is not kept, so the chunk load's retry warms again.
      warmed.catch(() => {
        if (this.#warmed === warmed) {
          this.#warmed = undefined;
        }
      });
    }
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
    for (const symbol of FALLBACK_WARM_UP_SYMBOLS) {
      await runInIdleTask(view, () => context.measureText(symbol));
    }
    // KaTeX compiles each part of its code on first use; a formula touching the common parts
    // compiles them here, so the first real formula typesets at a warm formula's cost.
    await runInIdleTask(view, () => renderMarkup(KATEX_WARM_UP_FORMULA, true));
  }
}

const mathWarmUp = new MathWarmUp();

/** The face the warm-up measures in: the platform's math face, which MathML is drawn in. */
const FALLBACK_WARM_UP_FONT = "16px math";

/** A letter the platform's math face draws itself, so its own opening is a step of its own. */
const MATH_FACE_WARM_UP_TEXT = "x";

/**
 * One symbol for each system face macOS falls back to for the MathML KaTeX draws, found by laying
 * out every symbol KaTeX defines; the first, a mathematical italic small x, starts the fallback.
 * The rest are a dot operator, maps-to, a macron, a double right arrow, alef, a frown, a midline
 * ellipsis and a check mark.
 */
const FALLBACK_WARM_UP_SYMBOLS = [
  "\u{1D465}",
  "\u22C5",
  "\u21A6",
  "\u02C9",
  "\u21D2",
  "\u2135",
  "\u2322",
  "\u22EF",
  "\u2713",
] as const;

/** A formula touching KaTeX's common parts: scripts, a sum, a fraction, a root, delimiters. */
const KATEX_WARM_UP_FORMULA = String.raw`\sum_{i=1}^{n} \frac{x_i}{\sqrt{y}} \le \left\lceil \alpha \right\rceil`;

/**
 * How long a warm-up step waits for the window to idle before it runs anyway, in milliseconds: a
 * window drawing frame after frame may grant no idle time at all.
 */
const IDLE_WAIT_MS = 50;

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

/** Run `step` alone in an idle task of `view`, waiting at most `IDLE_WAIT_MS` for one. */
function runInIdleTask<TResult>(view: Window, step: () => TResult): Promise<TResult> {
  return new Promise((resolve, reject) => {
    view.requestIdleCallback(
      () => {
        try {
          resolve(step());
        } catch (error) {
          reject(error as Error);
        }
      },
      { timeout: IDLE_WAIT_MS },
    );
  });
}
