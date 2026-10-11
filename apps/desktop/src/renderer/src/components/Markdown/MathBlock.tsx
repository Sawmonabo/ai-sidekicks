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
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { displayFormulaFitsFor } from "./display-formula-fit.js";
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
 * A ref for a display formula's span, which its window's `DisplayFormulaFits` fits to its column
 * from the span's first width on.
 */
function useMeasureNaturalWidth(
  displayMarkup: string | undefined,
): React.RefObject<HTMLSpanElement | null> {
  const displayRef = useRef<HTMLSpanElement>(null);

  // Armed before the first paint, so the watch's first report lands in that same frame and the
  // formula is never drawn at its unshrunk size first.
  useLayoutEffect(() => {
    const span = displayRef.current;
    if (displayMarkup === undefined || span === null) {
      return undefined;
    }
    return displayFormulaFitsFor(getWindow(span)).fit(span);
  }, [displayMarkup]);

  return displayRef;
}
