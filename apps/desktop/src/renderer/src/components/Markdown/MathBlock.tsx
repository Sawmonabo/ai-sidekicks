// Renders TeX with KaTeX: the renderer's one `dangerouslySetInnerHTML` site, because KaTeX only
// produces a markup string. KaTeX loads lazily, settled blocks only, with `trust: false` (model
// output must not emit `\href`, `\url` or a class), MathML output and `strict: false`. An
// unparseable formula shows its source beside an error state, never KaTeX's red error text.

import "./MathBlock.css";

import { useEffect, useState } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";

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

  if (state.status === "rendered") {
    return (
      <span
        className={props.isDisplayMode ? "meridian-math--display" : undefined}
        data-math=""
        // KaTeX's MathML output over `trust: false`.
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
 * KaTeX's markup for this source, loaded on first use: KaTeX is 261 KB of JavaScript plus 28 KB
 * of CSS, more than half the renderer's initial budget, and most sessions never render math.
 */
function useKatexMarkup(source: string, isDisplayMode: boolean): MathRenderState {
  const [state, setState] = useState<MathRenderState>({ status: "pending" });

  useEffect(() => {
    let isMounted = true;
    void import("katex")
      .then((katex) => {
        const mathMarkup = katex.default.renderToString(source, {
          displayMode: isDisplayMode,
          output: "mathml",
          trust: false,
          strict: false,
          // With `throwOnError: false` KaTeX resolves with its own error rendering, which would
          // make the unrenderable arm unreachable; throwing is the only signal of a parse failure.
          throwOnError: true,
        });
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
