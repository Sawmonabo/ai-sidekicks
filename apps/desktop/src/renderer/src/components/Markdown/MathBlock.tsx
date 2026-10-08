// Renders TeX with KaTeX: the renderer's one `dangerouslySetInnerHTML` site, because KaTeX only
// produces a markup string. KaTeX loads lazily, settled blocks only, with `trust: false` (model
// output must not emit `\href`, `\url` or a class), its HTML output with its MathML beside it,
// and `strict: false`. A display formula measures its widest unbreakable piece once, so its sheet
// can shrink it to the column, and checks the fit again when its size changes. An unparseable formula, or one whose chunk failed to load, shows
// its source beside an error state, never KaTeX's red error text.

import "./MathBlock.css";

import { useLayoutEffect, useMemo, useRef } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useChunkLoad } from "#renderer/hooks/useChunkLoad.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { MemoizedLoad } from "#renderer/lib/memoized-load.js";

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
        className={props.isDisplayMode ? "meridian-math--display" : undefined}
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
 * KaTeX's chunk. KaTeX's code, its sheet and its fonts are a large download most sessions never
 * need, so they arrive on their own chunk, which settles only once the fonts are in.
 */
const typesetterLoader = new MemoizedLoad(
  async () => (await import("./typesetter.js")).typesetFormula,
);

/**
 * KaTeX's markup for this source. Once the chunk is in, the loader's kept value typesets on the
 * first render, so a remounted formula is never drawn as its source first. A chunk that failed to
 * load is recorded by the chunk load, and the formula shows its source.
 */
function useKatexMarkup(source: string, isDisplayMode: boolean): MathRenderState {
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
 * A ref for a display formula's span, on which `--math-natural-width` is written once per markup,
 * when the span first has a width; the sheet does the fitting from it. Where glyph widths round to
 * whole pixels, as on Linux, a piece's width does not scale exactly with its font size, so each
 * later resize checks the fit and raises the width where the drawn piece overran its column.
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
    let isMeasured = false;
    return observeElementResize(span, () => {
      if (isMeasured) {
        raiseNaturalWidthToFit(span);
      } else {
        isMeasured = writeNaturalWidth(span);
      }
    });
  }, [displayMarkup]);

  return displayRef;
}

/**
 * Write the width the widest unbreakable piece needs, its equation number's room included, over
 * the formula's font size: a unitless ratio that reads right at whatever size the formula is
 * drawn; false while the span is not laid out yet.
 */
function writeNaturalWidth(span: HTMLSpanElement): boolean {
  const formula = span.querySelector(".katex-display");
  if (formula === null || span.getBoundingClientRect().width === 0) {
    return false;
  }
  const widestPiece = widestWidthOf(span, ".katex-base");
  // The line is centered and its number pinned right, so the number needs room on both sides.
  const naturalWidth = widestPiece + 2 * widestWidthOf(span, ".katex-tag");
  // An empty formula has nothing to fit, and a zero ratio would void the sheet's division.
  if (widestPiece > 0) {
    const fontSize = Number.parseFloat(getComputedStyle(formula).fontSize);
    span.style.setProperty("--math-natural-width", String(naturalWidth / fontSize));
  }
  return true;
}

/**
 * Raise `--math-natural-width` by the share the widest piece overran the column at its drawn size,
 * which the sheet then shrinks the formula by. The width only grows, to at most the widest the
 * piece draws per em at any size, so a formula that fits is left alone. A span whose width was
 * taken away is left alone too.
 */
function raiseNaturalWidthToFit(span: HTMLSpanElement): void {
  const naturalWidth = Number.parseFloat(span.style.getPropertyValue("--math-natural-width"));
  const columnWidth = span.getBoundingClientRect().width;
  if (Number.isNaN(naturalWidth) || columnWidth === 0) {
    return;
  }
  const drawnWidth = widestWidthOf(span, ".katex-base") + 2 * widestWidthOf(span, ".katex-tag");
  if (drawnWidth > columnWidth) {
    span.style.setProperty(
      "--math-natural-width",
      String((naturalWidth * drawnWidth) / columnWidth),
    );
  }
}

/** The width of the widest element under `span` that matches `selector`, in whole pixels. */
function widestWidthOf(span: HTMLSpanElement, selector: string): number {
  return Math.max(
    0,
    ...Array.from(span.querySelectorAll(selector), (element) =>
      Math.ceil(element.getBoundingClientRect().width),
    ),
  );
}
