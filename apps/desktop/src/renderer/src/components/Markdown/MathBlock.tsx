// Renders TeX with KaTeX: the renderer's one `dangerouslySetInnerHTML` site, because KaTeX only
// produces a markup string. KaTeX loads lazily, settled blocks only, with `trust: false` (model
// output must not emit `\href`, `\url` or a class), its HTML output with its MathML beside it, and
// `strict: false`. A formula waits for KaTeX's faces in the window it is drawn in, so it is first
// laid out in them. A display formula measures its widest unbreakable piece once, so its sheet can
// shrink it to the column, and checks the fit again when its size changes. An unparseable formula,
// or one whose chunk failed to load, shows its source beside an error state, never KaTeX's red
// error text.

import "./MathBlock.css";

import { getWindow } from "@floating-ui/utils/dom";
import { useLayoutEffect, useMemo, useRef } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useChunkLoad } from "#renderer/hooks/useChunkLoad.js";
import { RealClock, type ScheduledHandle } from "#renderer/lib/clock.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { typesetterLoadFor } from "./typesetter/load.js";

/** What one formula is drawn from. */
export interface MathBlockProps {
  /** The TeX source, wire-verbatim. */
  readonly source: string;
  /** Whether it is a display block or an inline formula. */
  readonly isDisplayMode: boolean;
}

/** A formula typeset by KaTeX, or its source beside an error state when it cannot be. */
export function MathBlock(props: MathBlockProps): React.JSX.Element {
  const state = useKatexMarkup(props.source, props.isDisplayMode);
  const displayRef = useMeasureNaturalWidth(
    state.status === "rendered" && props.isDisplayMode ? state.mathMarkup : undefined,
  );

  if (state.status === "rendered") {
    return (
      <span
        ref={displayRef}
        className={props.isDisplayMode ? "meridian-math--display" : "meridian-math--inline"}
        data-math=""
        // KaTeX's HTML and MathML output over `trust: false`.
        dangerouslySetInnerHTML={{ __html: state.mathMarkup }}
      />
    );
  }

  return (
    <span className="meridian-math--source" data-math="">
      <code>{props.source}</code>
      {state.status === "unrenderable" ? (
        <Nothing
          kind="error"
          placement="inline"
          title="This formula could not be typeset."
          detail="The source is shown exactly as it was written."
        />
      ) : null}
    </span>
  );
}

/** What one render attempt produced. */
type MathRenderState =
  | { readonly status: "pending" }
  | { readonly status: "rendered"; readonly mathMarkup: string }
  | { readonly status: "unrenderable" };

const PENDING_FORMULA: MathRenderState = { status: "pending" };
const UNRENDERABLE_FORMULA: MathRenderState = { status: "unrenderable" };

/**
 * KaTeX's markup for this source. Once the chunk is in for this window, the loader's kept value
 * typesets on the first render, so a remounted formula is never drawn as its source first. A chunk
 * that failed to load is recorded by the chunk load, and the formula shows its source.
 */
function useKatexMarkup(source: string, isDisplayMode: boolean): MathRenderState {
  const typesetterLoader = typesetterLoadFor(useOwnerWindow().document);
  const { state: chunk } = useChunkLoad(typesetterLoader, "math-typesetter-chunk");
  const typeset = chunk.status === "loaded" ? chunk.module : typesetterLoader.loadedValue;
  const hasFailed = chunk.status === "failed";

  return useMemo(() => {
    if (hasFailed) {
      return UNRENDERABLE_FORMULA;
    }
    if (typeset === undefined) {
      return PENDING_FORMULA;
    }
    const mathMarkup = typeset(source, isDisplayMode);
    return mathMarkup === undefined ? UNRENDERABLE_FORMULA : { status: "rendered", mathMarkup };
  }, [hasFailed, typeset, source, isDisplayMode]);
}

/**
 * A ref for a display formula's span, on which `--math-natural-width` is written when the span
 * first has a width; the sheet does the fitting from it. Where glyph widths round to whole pixels,
 * as on Linux, a piece's width does not scale exactly with its font size, so each later resize
 * checks the fit and raises the width where the drawn piece overran its column. A write resizes
 * the span it watches, so the watch stops right after it, in the same report, and starts again on
 * the next frame: a report of the size the write made would otherwise land in the same pass, which
 * the browser refuses with a window error.
 */
function useMeasureNaturalWidth(
  displayMarkup: string | undefined,
): React.RefObject<HTMLSpanElement | null> {
  const displayRef = useRef<HTMLSpanElement>(null);

  // Armed before the first paint, so the observer's first report lands in that same frame and the
  // formula is never drawn at its unshrunk size first.
  useLayoutEffect(() => {
    const span = displayRef.current;
    if (displayMarkup === undefined || span === null) {
      return undefined;
    }
    // The span's own window paces the rewatch, not the app's clock: it is layout, not time, and
    // the fixture's frozen clock runs no frame until told to, which would leave the formula unfit.
    const clock = new RealClock(getWindow(span));
    let hasNaturalWidth = false;
    let rewatch: ScheduledHandle | undefined;
    const watch = (): (() => void) =>
      observeElementResize(span, () => {
        const hasWritten = hasNaturalWidth ? raiseNaturalWidthToFit(span) : writeNaturalWidth(span);
        hasNaturalWidth = hasNaturalWidth || hasWritten;
        if (hasWritten) {
          stopWatching();
          rewatch = clock.scheduleFrame(() => {
            rewatch = undefined;
            stopWatching = watch();
          });
        }
      });
    let stopWatching = watch();
    return () => {
      stopWatching();
      if (rewatch !== undefined) {
        clock.cancel(rewatch);
      }
    };
  }, [displayMarkup]);

  return displayRef;
}

/**
 * Write the width the widest unbreakable piece needs, its equation number's room included, over
 * the formula's font size: a unitless ratio that reads right at whatever size the formula is
 * drawn. Says whether it wrote: not while the span is not laid out yet or the formula is empty.
 */
function writeNaturalWidth(span: HTMLSpanElement): boolean {
  const formula = span.querySelector(".katex-display");
  if (formula === null || span.getBoundingClientRect().width === 0) {
    return false;
  }
  // Rounded up to whole pixels, so a fraction of a pixel never leaves a piece over the edge.
  const widestPiece = Math.ceil(widestWidthOf(span, ".katex-base"));
  // The line is centered and its number pinned right, so the number needs room on both sides.
  const naturalWidth = widestPiece + 2 * Math.ceil(widestWidthOf(span, ".katex-tag"));
  // An empty formula has nothing to fit, and a zero ratio would void the sheet's division. A
  // formula that is only its number has no piece, and still fits by the number's room.
  if (naturalWidth === 0) {
    return false;
  }
  const fontSize = Number.parseFloat(getComputedStyle(formula).fontSize);
  span.style.setProperty("--math-natural-width", String(naturalWidth / fontSize));
  return true;
}

/**
 * Raise `--math-natural-width` by the share the widest piece overran the column at its drawn size,
 * which the sheet then shrinks the formula by, and say whether it was raised. The width only
 * grows, to at most the widest the piece draws per em at any size, so a formula that fits is left
 * alone. A span whose width was taken away is left alone too.
 */
function raiseNaturalWidthToFit(span: HTMLSpanElement): boolean {
  const naturalWidth = Number.parseFloat(span.style.getPropertyValue("--math-natural-width"));
  const columnWidth = span.getBoundingClientRect().width;
  if (Number.isNaN(naturalWidth) || columnWidth === 0) {
    return false;
  }
  // Both widths as drawn, unrounded, so a piece that fits by a fraction of a pixel is not shrunk.
  const drawnWidth = widestWidthOf(span, ".katex-base") + 2 * widestWidthOf(span, ".katex-tag");
  if (drawnWidth <= columnWidth) {
    return false;
  }
  span.style.setProperty("--math-natural-width", String((naturalWidth * drawnWidth) / columnWidth));
  return true;
}

/** The width of the widest element under `span` that matches `selector`, in pixels. */
function widestWidthOf(span: HTMLSpanElement, selector: string): number {
  return Math.max(
    0,
    ...Array.from(
      span.querySelectorAll(selector),
      (element) => element.getBoundingClientRect().width,
    ),
  );
}
