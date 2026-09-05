// The five kinds of nothing, in the two shapes an absence can take.
//
// `Spec-023 §Console Design (Meridian)` rule 8: "Five absences render differently
// because the operator's next move differs for each … A renderer that collapses two
// of these into one is wrong." The rule is enforced structurally here — the kind set
// is closed, the traits table below is total over it, and each kind supplies copy,
// a glyph, and a tone no other kind supplies:
//
//   • `not-loaded`  — a skeleton in the row's shape. The read is in flight; the
//                     operator waits. It says nothing, because there is nothing yet
//                     to say, and a sentence would be replaced a beat later.
//   • `empty`       — a quiet line with the escape hatch. The read succeeded and
//                     found none. The next move is to create one, so the action
//                     slot is where that control goes.
//   • `error`       — the daemon's own message text under an alert glyph on a red
//                     edge. The read failed; the next move depends on what the
//                     daemon said, so the console does not paraphrase it.
//   • `not-checked` — a dotted boundary. Nobody asked. This is NOT "no" and NOT "we
//                     do not know" — it is "no question was put", and conflating it
//                     with either is how a console starts asserting facts it never
//                     established.
//   • `computing`   — a clock glyph on a filled boundary. The question was put and
//                     the answer is still being worked out.
//
// KIND IS WHAT IS ABSENT; PLACEMENT IS WHERE THE ABSENCE IS MOUNTED. Those are two
// questions and this component used to answer both with one: the kind picked the
// shape, so `not-checked` was a badge everywhere. It is the right shape beside a
// value it qualifies and the wrong one in place of a whole pane — a badge centred
// in a 1440 px window is a strip of text a reader takes for a paint that did not
// finish, and its `detail` reaches nobody, because a badge can only carry its second
// line as a hover tooltip. So the caller names the placement and the placement picks
// the shape:
//
//   • `inline`  — a badge, sitting beside the value it qualifies.
//   • `surface` — a block, standing in for the surface that is not there.
//
// Every kind renders in both. Rule 8 stays exactly as written, because it names the
// treatment each kind carries — dotted for `not-checked`, a clock for `computing` —
// and the kind carries that treatment into either shape. What the placement decides
// is the box it is carried in, which rule 8 does not speak to.
//
// The default reproduces the placement each kind was previously hard-wired to, so a
// call site that names none renders exactly what it rendered before.
//
// Copy is the caller's, and the copy rule is calm authority — sentence case, past
// tense for receipts, no exclamation marks, no blame. This component supplies the
// shape; it never invents a sentence.

import { GLYPH_SIZE_ROW, type GlyphName } from "../tokens/index.js";
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

/**
 * Closed, and closed at two. Declared the same way and for the same reason: the
 * claim is that there are exactly two shapes an absence takes, and a third added to
 * a hand-written union while this list stayed at two is the drift the tuple form
 * makes impossible.
 */
export const NOTHING_PLACEMENTS = ["inline", "surface"] as const;

export type NothingPlacement = (typeof NOTHING_PLACEMENTS)[number];

export interface NothingProps {
  readonly kind: NothingKind;
  /**
   * Where this absence is mounted. Omitted, it is the placement the kind is
   * ordinarily mounted at — a qualifier beside a value is `inline`, an absence
   * standing in for a surface is `surface`. Name it whenever the mount contradicts
   * that: a whole pane of `not-checked` is `surface`, and it is the caller that
   * knows, because the caller is what mounted it.
   */
  readonly placement?: NothingPlacement;
  /** What is absent, in one sentence. For `error`, the refusal's code or headline. */
  readonly title: string;
  /**
   * The second line. For `error` this is the daemon's message text, rendered
   * verbatim — never paraphrased, shortened, or explained (rule 9 puts the code in
   * mono and the message verbatim, and a paragraph set in mono is a paragraph
   * nobody reads). For every other kind it is the console's own prose.
   *
   * A block renders it as prose. A badge has no room for a second line and carries
   * it as the badge's tooltip, which is the honest limit of that shape and the
   * reason a caller with something to say mounts on a surface.
   */
  readonly detail?: string;
  /** The next step, when there is one. A button, a link, a control. */
  readonly action?: React.ReactNode;
}

/** What a kind supplies, and nothing about where it is mounted. */
interface NothingKindTraits {
  /**
   * The placement this kind is mounted at when the caller names none. It is the
   * kind's ordinary mount, not a property of the kind — which is exactly why a
   * caller can override it.
   */
  readonly defaultPlacement: NothingPlacement;
  /**
   * Whether the kind has words. `not-loaded` does not: the shape stands in for copy
   * that would be replaced a beat later, and the title is announced rather than set.
   */
  readonly copy: "prose" | "skeleton";
  /** The kind's glyph, in both shapes. Kinds that carry meaning in copy alone have none. */
  readonly glyph?: GlyphName;
  /**
   * Which class the block form's second line takes. `error` gets its own, because
   * the daemon's text is quoted rather than written and reads at a wider measure.
   */
  readonly detailClassName: string;
  /** The kind's live-region role, in both shapes. Absent where nothing is in progress. */
  readonly role?: "status";
  /** Whether the kind is a read still in flight. */
  readonly busy?: boolean;
}

/**
 * Total over `NothingKind` by construction — a sixth kind fails to compile here
 * before it can reach a call site that renders a nameless absence.
 */
const NOTHING_KIND_TRAITS: Readonly<Record<NothingKind, NothingKindTraits>> = {
  "not-loaded": {
    defaultPlacement: "surface",
    copy: "skeleton",
    detailClassName: "meridian-nothing__detail",
    role: "status",
    busy: true,
  },
  empty: {
    defaultPlacement: "surface",
    copy: "prose",
    detailClassName: "meridian-nothing__detail",
  },
  error: {
    defaultPlacement: "surface",
    copy: "prose",
    glyph: "alert",
    detailClassName: "meridian-nothing__message",
    role: "status",
  },
  "not-checked": {
    defaultPlacement: "inline",
    copy: "prose",
    detailClassName: "meridian-nothing__detail",
  },
  computing: {
    defaultPlacement: "inline",
    copy: "prose",
    glyph: "clock",
    detailClassName: "meridian-nothing__detail",
    role: "status",
  },
};

/** The shape each placement renders as. The other half of the two-question split. */
const SHAPE_MODIFIER_BY_PLACEMENT: Readonly<Record<NothingPlacement, string>> = {
  inline: "meridian-nothing--badge",
  surface: "meridian-nothing--block",
};

/** How wide each skeleton bar is, as a fraction of the measure. Uneven on purpose:
 *  three equal bars read as a table, and the shape being imitated is a ledger row. */
const SKELETON_BAR_WIDTHS: readonly string[] = ["38%", "82%", "61%"];

export function Nothing(props: NothingProps): React.JSX.Element {
  const traits = NOTHING_KIND_TRAITS[props.kind];
  const placement = props.placement ?? traits.defaultPlacement;
  const className = `meridian-nothing ${SHAPE_MODIFIER_BY_PLACEMENT[placement]} meridian-nothing--${props.kind}`;
  return placement === "inline"
    ? renderBadge(props, traits, className)
    : renderBlock(props, traits, className);
}

/**
 * The badge: an absence that qualifies the value it sits beside.
 *
 * A skeleton badge is one bar rather than three, because the three exist to imitate
 * a ledger row's proportions and a badge has no row to imitate. It carries no
 * action for the same reason the block form does not: a read in flight has no next
 * move, so a control offered beside one is a control offered against nothing.
 */
function renderBadge(
  props: NothingProps,
  traits: NothingKindTraits,
  className: string,
): React.JSX.Element {
  if (traits.copy === "skeleton") {
    return (
      <span className={className} role={traits.role} aria-busy={traits.busy}>
        <span className="meridian-visually-hidden">{props.title}</span>
        <span className="meridian-nothing__skeleton-bar" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={className} role={traits.role} aria-busy={traits.busy}>
      {traits.glyph === undefined ? null : <Glyph name={traits.glyph} size={GLYPH_SIZE_ROW} />}
      <span className="meridian-nothing__badge-label" title={props.detail}>
        {props.title}
      </span>
      {props.action === undefined ? null : (
        <span className="meridian-nothing__action">{props.action}</span>
      )}
    </span>
  );
}

/** The block: an absence standing in for the surface that is not there. */
function renderBlock(
  props: NothingProps,
  traits: NothingKindTraits,
  className: string,
): React.JSX.Element {
  if (traits.copy === "skeleton") {
    return (
      <div className={className} role={traits.role} aria-busy={traits.busy}>
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
  }
  return (
    <div className={className} role={traits.role} aria-busy={traits.busy}>
      <p className="meridian-nothing__title">
        {traits.glyph === undefined ? null : <Glyph name={traits.glyph} size={GLYPH_SIZE_ROW} />}
        {props.title}
      </p>
      {props.detail === undefined ? null : <p className={traits.detailClassName}>{props.detail}</p>}
      {props.action === undefined ? null : (
        <div className="meridian-nothing__action">{props.action}</div>
      )}
    </div>
  );
}
