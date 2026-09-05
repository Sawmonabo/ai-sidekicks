// The chip: one fact, in one word, with at most one colour.
//
// Chips are where the two-hue rule is most easily broken, so the tone set is closed
// at four and each one is spent on exactly the meaning
// `Spec-023 §Console Design (Meridian)` rule 3 assigns it:
//
//   • `neutral`   — the common case, and the default. A chip that carries no
//                   urgency carries no colour. Most chips in a healthy session are
//                   this one; a screen of neutral chips is a screen that needs
//                   nobody, which is the property rule 3 exists to make visible.
//   • `attention` — amber. A person is needed. Nothing else earns amber.
//   • `failure`   — red. Something failed. Nothing else earns red.
//   • `accent`    — the one desaturated cyan, and only on something interactive.
//
// `mono` is not styling. It marks the label as a wire-true string, so a chip
// carrying a `SessionState` or a provider name reads with the same provenance
// signature as every other figure the daemon sent (rule 4). A chip whose label the
// console composed leaves it off.

import { GLYPH_SIZE_ROW, type GlyphName } from "../tokens/index.js";
import { Glyph } from "./Glyph.js";
import { formatWireString } from "./wire-figures.js";

/**
 * The closed tone set. Widening it is how the two-hue rule dies.
 *
 * Declared once as a tuple with the union derived from it, so a fifth tone cannot
 * be added to a hand-written union while the list a gallery iterates stays at four.
 */
export const CHIP_TONES = ["neutral", "attention", "failure", "accent"] as const;

export type ChipTone = (typeof CHIP_TONES)[number];

export interface ChipProps {
  readonly tone?: ChipTone;
  readonly label: string;
  /** True when `label` is a string the wire supplied, rendered verbatim in mono. */
  readonly mono?: boolean;
  /** A glyph before the label. Decorative — the label carries the meaning. */
  readonly glyph?: GlyphName;
}

export function Chip(props: ChipProps): React.JSX.Element {
  const tone = props.tone ?? "neutral";
  const isMono = props.mono === true;
  const className = ["meridian-chip", `meridian-chip--${tone}`, isMono ? "meridian-chip--mono" : ""]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <span className={className}>
      {props.glyph !== undefined ? <Glyph name={props.glyph} size={GLYPH_SIZE_ROW} /> : null}
      <span className="meridian-chip__label">
        {isMono ? formatWireString(props.label) : props.label}
      </span>
    </span>
  );
}
