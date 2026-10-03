// One fact in one word with at most one color; `mono` marks a label the wire supplied.

import "./Chip.css";

import { GLYPH_SIZE_ROW, type GlyphName } from "@renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { formatWireString } from "@renderer/lib/wire-figures.js";

/**
 * The closed tone set: `neutral` (no color, the default), `attention` (amber, a person is
 * needed), `failure` (red, something failed) and `accent` (cyan, an interactive affordance or a
 * running state).
 */
export const CHIP_TONES = ["neutral", "attention", "failure", "accent"] as const;

/** One of `CHIP_TONES`. */
export type ChipTone = (typeof CHIP_TONES)[number];

/** Props for `Chip`. */
export interface ChipProps {
  readonly tone?: ChipTone;
  readonly label: string;
  /** True when `label` is a string the wire supplied, rendered verbatim in mono. */
  readonly mono?: boolean;
  /** A decorative glyph before the label. */
  readonly glyph?: GlyphName;
}

/** A single-fact chip; `mono` renders `label` verbatim as a wire string. */
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
