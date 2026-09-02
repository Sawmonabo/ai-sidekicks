// The math block — the console's ONE `dangerouslySetInnerHTML` site.
//
// `Spec-023 §Console Test Tiers` names, among the architecture tier's static tripwires,
// "no `dangerouslySetInnerHTML` outside the math-owned node". This is that node, and the
// tripwire is what keeps the count at one:
// `test/console/architecture/ledger-card-chokepoints.test.ts` reads the console tree and
// fails on a second occurrence.
//
// WHY THE EXCEPTION IS HERE AND NOWHERE ELSE. KaTeX's whole interface is a string of
// markup; there is no token stream to build spans from, and re-implementing a TeX
// typesetter to avoid one `innerHTML` would be a far larger surface than the one it
// removed. Everything else the console renders — markdown, code, ANSI — arrives as data,
// which is why those paths need no exception and are forbidden one.
//
// FOUR CONSTRAINTS, EACH FROM `Spec-023 §Console Libraries`' math row —
// "ADOPT-with-constraints KaTeX (lazy, settled blocks only, `trust: false`, MathML output
// first)" — and each of them load-bearing rather than cautious:
//
//   • **`trust: false`** is KaTeX's own default and is passed explicitly anyway. It is
//     what disables `\href`, `\url`, `\includegraphics`, and `\htmlClass`, the commands
//     that let TeX source emit a link or a class into the document. The source here is
//     model output, so the one thing it must not be able to do is reach outside the
//     formula.
//   • **`output: "mathml"`** means the markup is a MathML subtree — elements the browser
//     lays out, not styled HTML — which is both the accessible rendering and the
//     narrowest one. The row's "MathML output first" is the instruction, and taking
//     `htmlAndMathml` would double the markup for a visual result MathML already gives.
//   • **`strict: false`** so a formula with a warning renders rather than refusing; a
//     participant's mistake in a formula is not the console's error to raise.
//   • **Settled blocks only.** `markdown-rules.ts` defers math until the block settles,
//     so this component never sees a prefix. Half a formula is not a formula, and KaTeX
//     asked to render one throws or renders something the next frame contradicts.
//
// AND ONE MORE THAT IS NOT NEGOTIABLE: `throwOnError: false`, with KaTeX's own error
// rendering off. An unparseable formula renders as its SOURCE, in mono, beside a named
// absence — never as KaTeX's red error text, which is a stranger's voice in the ledger,
// and never as nothing, which would read as the author having written nothing.

import { useEffect, useState } from "react";

import { Nothing } from "../../../primitives/index.js";

/** What one render attempt produced. Closed — a nameless failure is one a card cannot explain. */
type MathRenderState =
  | { readonly status: "pending" }
  | { readonly status: "rendered"; readonly mathMarkup: string }
  | { readonly status: "unrenderable" };

export interface MathBlockProps {
  /** The TeX source, wire-verbatim. */
  readonly source: string;
  /** Whether it is a display block or an inline formula. */
  readonly isDisplayMode: boolean;
}

export function MathBlock(props: MathBlockProps): React.JSX.Element {
  const state = useKatexMarkup(props.source, props.isDisplayMode);

  if (state.status === "rendered") {
    return (
      <span
        className={props.isDisplayMode ? "meridian-math meridian-math--display" : "meridian-math"}
        // THE ONE SITE. The markup is KaTeX's MathML output over `trust: false`, and the
        // architecture tier fails the build on a second occurrence anywhere under
        // `console/`.
        dangerouslySetInnerHTML={{ __html: state.mathMarkup }}
      />
    );
  }

  return (
    <span className="meridian-math meridian-math--source">
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

/**
 * KaTeX's markup for this source, loaded on first use.
 *
 * The import is dynamic because the row says lazy, and the measurement in
 * `Spec-023 §References` D.2 is why it matters: KaTeX is 261 KB of JavaScript and 28 KB
 * of CSS, which alone would be more than half the renderer's whole initial budget for a
 * capability most sessions never reach.
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
          throwOnError: false,
          errorColor: "transparent",
        });
        if (isMounted) {
          setState({ status: "rendered", mathMarkup });
        }
      })
      .catch(() => {
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
