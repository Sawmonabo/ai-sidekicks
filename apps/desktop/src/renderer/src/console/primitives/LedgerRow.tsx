// The ledger row — the console's signature shape.
//
// `Spec-023 §Console Design (Meridian)` rule 1: "Timeline rows are flush-left ledger
// lines: a 2 px attribution edge in the author's hue, author and timestamp in a
// fixed gutter, content in a single measure. No bubbles, no left-and-right
// alternation, no avatars in the flow. The screen reads as a work log because it is
// one."
//
// Three decisions this component makes, each of which the design forces:
//
//   • **The edge is 2 px and it is an edge, not a tint.** A background tint on the
//     row would put the participant hue behind body text, which rule 3 forbids in
//     terms ("the twelve participant hues … are never used as text") and which would
//     also cost every row a contrast argument. A 2 px edge carries identity at a
//     glance without ever sitting behind a glyph. The width is the palette's
//     `--meridian-attribution-edge`, so rule 1's number lives in one place.
//   • **The ring treatment varies the edge along its LENGTH, not its width.** Past
//     twelve participants the wheel wraps and `ParticipantRingTreatment` is what
//     keeps two people on one hue distinguishable. A 2 px strip has no room for a
//     `double` border-style — CSS would collapse it to a solid hairline — so the
//     four treatments are expressed as four fill patterns down the edge: continuous,
//     long dashes, paired ticks, and dots. The spec fixes the width and names the
//     treatments; how they compose is under-determined, and this is the reading that
//     keeps the width honest. (See `primitives.css`.)
//   • **The footer is revealed, never added.** Rule 7: "secondary controls live one
//     click away — a row's hover footer or its context menu — never as a second
//     visible button." Revealing on `:hover` alone would hide the row's affordances
//     from anyone driving by keyboard, so the same reveal fires on `:focus-within`
//     and the footer is only pointer-inert while hidden — Tab still reaches it.
//
// Rows are `<article>` elements so a container can be `role="feed"` without the
// nesting being invalid, and each one is named by its author so a screen reader
// walking the log hears who wrote what.

import { useId } from "react";
import {
  PARTICIPANT_HUE_STEPS,
  type ParticipantRingTreatment,
  participantHueTokenName,
  tokenReference,
} from "../tokens/index.js";
import { WireFigure } from "./Figure.js";
import { formatClockTime } from "./wire-figures.js";

export interface LedgerRowProps {
  /** Wheel step, 0 to 11 — drives the 2 px attribution edge. */
  readonly participantHueStep: number;
  /** How a wrapped step is told apart from the step it repeats. */
  readonly ringTreatment?: ParticipantRingTreatment;
  readonly occurredAtIso: string;
  readonly actorLabel: string;
  /** A wire-true event kind. Rendered mono and verbatim. */
  readonly kindLabel: string;
  /** The row body, in a single measure. */
  readonly children?: React.ReactNode;
  /** Hover-revealed affordances. */
  readonly footer?: React.ReactNode;
  readonly isSuperseded?: boolean;
}

/** Carries the row's participant hue into the edge's fill patterns. */
interface AttributionEdgeStyle extends React.CSSProperties {
  readonly "--meridian-row-hue": string;
}

export function LedgerRow(props: LedgerRowProps): React.JSX.Element {
  const actorId = useId();

  // Fail-closed projection: a step outside the wheel is not clamped into someone
  // else's colour, because that would attribute a row to the wrong participant.
  // The edge falls back to the neutral control boundary and the row says, in its
  // class, that it carries no attribution.
  const isAttributed =
    Number.isInteger(props.participantHueStep) &&
    props.participantHueStep >= 0 &&
    props.participantHueStep < PARTICIPANT_HUE_STEPS;
  const edgeStyle: AttributionEdgeStyle = {
    "--meridian-row-hue": isAttributed
      ? tokenReference(participantHueTokenName(props.participantHueStep))
      : tokenReference("edge-strong"),
  };

  const className = [
    "meridian-ledger-row",
    `meridian-ledger-row--${props.ringTreatment ?? "solid"}`,
    isAttributed ? "" : "meridian-ledger-row--unattributed",
    props.isSuperseded === true ? "meridian-ledger-row--superseded" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <article className={className} aria-labelledby={actorId}>
      <span className="meridian-ledger-row__edge" style={edgeStyle} aria-hidden="true" />
      <div className="meridian-ledger-row__gutter">
        <span className="meridian-ledger-row__actor" id={actorId}>
          {props.actorLabel}
        </span>
        <WireFigure value={formatClockTime(props.occurredAtIso)} title={props.occurredAtIso} />
      </div>
      <div className="meridian-ledger-row__body">
        <div className="meridian-ledger-row__meta">
          <span className="meridian-ledger-row__kind">
            <WireFigure value={props.kindLabel} />
          </span>
          {props.isSuperseded === true ? (
            <span className="meridian-ledger-row__superseded-mark">Superseded</span>
          ) : null}
        </div>
        {props.children}
      </div>
      {props.footer !== undefined ? (
        <div className="meridian-ledger-row__footer">{props.footer}</div>
      ) : null}
    </article>
  );
}
