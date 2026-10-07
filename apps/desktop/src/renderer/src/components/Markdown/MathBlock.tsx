// Renders TeX with KaTeX: the renderer's one `dangerouslySetInnerHTML` site, because KaTeX only
// produces a markup string. KaTeX loads lazily, settled blocks only, with `trust: false` (model
// output must not emit `\href`, `\url` or a class), its HTML output with its MathML beside it,
// and `strict: false`. A display formula measures its widest unbreakable piece once, so its sheet
// can shrink it to the column. An unparseable formula shows its source beside an error state,
// never KaTeX's red error text.

import "./MathBlock.css";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";

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

/**
 * KaTeX's markup for this source, loaded on first use: KaTeX's code, its sheet and its fonts are
 * a large download most sessions never need, so they arrive on their own chunk, which settles
 * only once the fonts are in.
 */
function useKatexMarkup(source: string, isDisplayMode: boolean): MathRenderState {
  const [state, setState] = useState<MathRenderState>({ status: "pending" });

  useEffect(() => {
    let isMounted = true;
    void import("./typesetter.js")
      .then((typesetter) => {
        const mathMarkup = typesetter.typesetFormula(source, isDisplayMode);
        if (isMounted) {
          setState({ status: "rendered", mathMarkup });
        }
      })
      .catch(() => {
        // One arm for both causes (KaTeX failed to load, or would not parse this formula): the
        // reader is in the same position either way.
        if (isMounted) {
          setState({ status: "unrenderable" });
        }
      });
    return () => {
      isMounted = false;
    };
  }, [source, isDisplayMode]);

  return state;
}

/**
 * A ref for a display formula's span, on which `--math-natural-width` is written once per markup,
 * when the span first has a width: no measuring on resize, since the sheet does the fitting.
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
    const stopObserving = observeElementResize(span, () => {
      if (writeNaturalWidth(span)) {
        stopObserving();
      }
    });
    return stopObserving;
  }, [displayMarkup]);

  return displayRef;
}

/**
 * Write the widest unbreakable piece's width over the formula's font size, a unitless ratio that
 * reads right at whatever size the formula is drawn; false while the span is not laid out yet.
 */
function writeNaturalWidth(span: HTMLSpanElement): boolean {
  const formula = span.querySelector(".katex-display");
  if (formula === null || span.getBoundingClientRect().width === 0) {
    return false;
  }
  const widestPiece = Math.max(
    0,
    ...Array.from(span.querySelectorAll(".katex-base"), (piece) =>
      Math.ceil(piece.getBoundingClientRect().width),
    ),
  );
  // An empty formula has nothing to fit, and a zero ratio would void the sheet's division.
  if (widestPiece > 0) {
    const fontSize = Number.parseFloat(getComputedStyle(formula).fontSize);
    span.style.setProperty("--math-natural-width", String(widestPiece / fontSize));
  }
  return true;
}
