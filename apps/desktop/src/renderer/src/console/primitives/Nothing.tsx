// The five kinds of nothing.
//
// `Spec-023 §Console Design (Meridian)` rule 8: "Five absences render differently
// because the operator's next move differs for each … A renderer that collapses two
// of these into one is wrong." The rule is enforced structurally here — the kind set
// is closed, the switch below is exhaustive, and each arm produces a visibly
// different shape rather than the same box with different copy:
//
//   • `not-loaded`  — a skeleton in the row's shape. The read is in flight; the
//                     operator waits. It says nothing, because there is nothing yet
//                     to say, and a sentence would be replaced a beat later.
//   • `empty`       — a quiet line with the escape hatch. The read succeeded and
//                     found none. The next move is to create one, so the action
//                     slot is where that control goes.
//   • `error`       — a red-edged row carrying the daemon's own message text. The
//                     read failed; the next move depends on what the daemon said,
//                     so the console does not paraphrase it.
//   • `not-checked` — a dotted badge. Nobody asked. This is NOT "no" and NOT "we do
//                     not know" — it is "no question was put", and conflating it
//                     with either is how a console starts asserting facts it never
//                     established.
//   • `computing`   — a badge with a clock glyph. The question was put and the
//                     answer is still being worked out.
//
// Two of the five are badges and three are blocks, which is deliberate: `not-checked`
// and `computing` qualify a value that is present beside them, while the other three
// stand in place of a surface that is not there.
//
// Copy is the caller's, and the copy rule is calm authority — sentence case, past
// tense for receipts, no exclamation marks, no blame. This component supplies the
// shape; it never invents a sentence.

import { Glyph } from "./Glyph.js";

/**
 * Closed. Adding a sixth kind is a deliberate edit here and in rule 8.
 *
 * The tuple is the declaration and the union is derived from it: rule 8's claim is
 * that FIVE absences render differently, and a claim about a count has to be
 * countable at runtime for a test to hold it.
 */
export const NOTHING_KINDS = ["not-loaded", "empty", "error", "not-checked", "computing"] as const;

export type NothingKind = (typeof NOTHING_KINDS)[number];

export interface NothingProps {
  readonly kind: NothingKind;
  /** What is absent, in one sentence. For `error`, the refusal's code or headline. */
  readonly title: string;
  /**
   * The second line. For `error` this is the daemon's message text, rendered
   * verbatim — never paraphrased, shortened, or explained (rule 9 puts the code in
   * mono and the message verbatim, and a paragraph set in mono is a paragraph
   * nobody reads). For every other kind it is the console's own prose.
   */
  readonly detail?: string;
  /** The next step, when there is one. A button, a link, a control. */
  readonly action?: React.ReactNode;
}

const BADGE_GLYPH_SIZE = 12;

/** How wide each skeleton bar is, as a fraction of the measure. Uneven on purpose:
 *  three equal bars read as a table, and the shape being imitated is a ledger row. */
const SKELETON_BAR_WIDTHS: readonly string[] = ["38%", "82%", "61%"];

export function Nothing(props: NothingProps): React.JSX.Element {
  switch (props.kind) {
    case "not-loaded":
      return (
        <div
          className="meridian-nothing meridian-nothing--not-loaded"
          role="status"
          aria-busy="true"
        >
          <span className="meridian-visually-hidden">{props.title}</span>
          {SKELETON_BAR_WIDTHS.map((width) => (
            <span
              key={width}
              className="meridian-nothing__skeleton-bar"
              style={{ width }}
              aria-hidden="true"
            />
          ))}
        </div>
      );

    case "empty":
      return (
        <div className="meridian-nothing meridian-nothing--empty">
          <p className="meridian-nothing__title">{props.title}</p>
          {props.detail !== undefined ? (
            <p className="meridian-nothing__detail">{props.detail}</p>
          ) : null}
          {props.action !== undefined ? (
            <div className="meridian-nothing__action">{props.action}</div>
          ) : null}
        </div>
      );

    case "error":
      return (
        <div className="meridian-nothing meridian-nothing--error" role="status">
          <p className="meridian-nothing__title">
            <Glyph name="alert" size={BADGE_GLYPH_SIZE} />
            {props.title}
          </p>
          {props.detail !== undefined ? (
            <p className="meridian-nothing__message">{props.detail}</p>
          ) : null}
          {props.action !== undefined ? (
            <div className="meridian-nothing__action">{props.action}</div>
          ) : null}
        </div>
      );

    case "not-checked":
      return (
        <span className="meridian-nothing meridian-nothing--badge meridian-nothing--not-checked">
          <span className="meridian-nothing__badge-label" title={props.detail}>
            {props.title}
          </span>
          {props.action !== undefined ? (
            <span className="meridian-nothing__action">{props.action}</span>
          ) : null}
        </span>
      );

    case "computing":
      return (
        <span
          className="meridian-nothing meridian-nothing--badge meridian-nothing--computing"
          role="status"
        >
          <Glyph name="clock" size={BADGE_GLYPH_SIZE} />
          <span className="meridian-nothing__badge-label" title={props.detail}>
            {props.title}
          </span>
          {props.action !== undefined ? (
            <span className="meridian-nothing__action">{props.action}</span>
          ) : null}
        </span>
      );
  }
}
