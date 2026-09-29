// The transcript row — the console's signature shape.
//
// Transcript rows are flush-left lines — a 2 px
// attribution edge in the author's hue, author and timestamp in a fixed gutter, content
// in a single measure. No bubbles, no left-and-right alternation, no avatars in the
// flow. The screen reads as a work log because it is one.
//
// Two decisions this component makes, each of which the design forces:
//
//   • **The edge is 2 px and it is an edge, not a tint.** A background tint on the
//     row would put the user hue behind body text, where an actor hue never goes,
//     and would also cost every row a contrast argument. A 2 px edge carries identity at a
//     glance without ever sitting behind a glyph. The width is the palette's
//     `--meridian-leading-edge`, so the edge's width lives in one place.
//   • **The footer is revealed, never added.** A row's secondary controls live one
//     click away — its hover footer or its context menu — never as a second
//     visible button. Revealing on `:hover` alone would hide the row's affordances
//     from anyone driving by keyboard, so the same reveal fires on `:focus-within`
//     and the footer is only pointer-inert while hidden — Tab still reaches it.
//
// Rows are `<article>` elements so a container can be `role="feed"` without the
// nesting being invalid, and each one is named by its author so a screen reader
// walking the log hears who wrote what.

import { useId, useMemo } from "react";

import "./TranscriptRowLayout.css";
import { HUE_WHEEL_STEPS } from "@renderer/styles/palette.js";
import { formatHueWheelTokenName, tokenReference } from "@renderer/styles/tokens.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatClockTime } from "@renderer/lib/wire-figures.js";

export interface TranscriptRowLayoutProps {
  /** Wheel step, 0 to 11 — drives the 2 px attribution edge. */
  readonly agentHueStep: number;
  readonly occurredAtIso: string;
  readonly authorLabel: string;
  /** A wire-true event kind. Rendered mono and verbatim. */
  readonly kindLabel: string;
  /** The row body, in a single measure. */
  readonly children?: React.ReactNode;
  /** Hover-revealed affordances. */
  readonly footer?: React.ReactNode;
  readonly isSuperseded?: boolean;
}

export function TranscriptRowLayout(props: TranscriptRowLayoutProps): React.JSX.Element {
  const actorId = useId();

  // FORMATTED ONCE PER INSTANT, not once per paint.
  //
  // `formatClockTime` builds a fresh `Intl.DateTimeFormat` on every call, and this is
  // the row every transcript view in the console is made of — a streaming window
  // re-renders its mounted rows on a lease write, a hover and a reveal tick, and none
  // of those move the instant a row is stamped with.
  //
  // A MEMO RATHER THAN A FORMATTED STRING ON THE ROW MODEL, which is the other way to
  // pay once, because this component is a PRIMITIVE and the instant reaches it as a
  // prop from callers that share no model: the transcript feed builds its rows by folding
  // admitted events, and the lease and run ledgers build theirs from a wire
  // read that no fold ever sees. Putting the string on one of those models would leave
  // the others formatting per paint, and putting it on all of them would be three
  // copies of one formatting rule. Keyed on the instant itself, which is the only
  // member the string is a function of.
  const occurredAtClockTime = useMemo(
    () => formatClockTime(props.occurredAtIso),
    [props.occurredAtIso],
  );

  // Fail-closed projection: a step outside the wheel is not clamped into someone
  // else's color, because that would attribute a row to the wrong user.
  // The edge falls back to the neutral control boundary and the row says, in its
  // class, that it carries no attribution.
  const isAttributed =
    Number.isInteger(props.agentHueStep) &&
    props.agentHueStep >= 0 &&
    props.agentHueStep < HUE_WHEEL_STEPS;
  const edgeStyle: AttributionEdgeStyle = {
    "--meridian-row-hue": isAttributed
      ? tokenReference(formatHueWheelTokenName(props.agentHueStep))
      : tokenReference("edge-strong"),
  };

  const className = [
    "meridian-transcript-row-layout",
    isAttributed ? "" : "meridian-transcript-row-layout--unattributed",
    props.isSuperseded === true ? "meridian-transcript-row-layout--superseded" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <article className={className} aria-labelledby={actorId}>
      <span className="meridian-transcript-row-layout__edge" style={edgeStyle} aria-hidden="true" />
      <div className="meridian-transcript-row-layout__gutter">
        <span className="meridian-transcript-row-layout__actor" id={actorId}>
          {props.authorLabel}
        </span>
        <WireFigure value={occurredAtClockTime} title={props.occurredAtIso} />
      </div>
      <div className="meridian-transcript-row-layout__body">
        <div className="meridian-transcript-row-layout__meta">
          <span className="meridian-transcript-row-layout__kind">
            <WireFigure value={props.kindLabel} />
          </span>
          {props.isSuperseded === true ? (
            <span className="meridian-transcript-row-layout__superseded-mark">Superseded</span>
          ) : null}
        </div>
        {props.children}
      </div>
      {props.footer !== undefined ? (
        <div className="meridian-transcript-row-layout__footer">{props.footer}</div>
      ) : null}
    </article>
  );
}

/** Carries the row's user hue into the edge's fill patterns. */
interface AttributionEdgeStyle extends React.CSSProperties {
  readonly "--meridian-row-hue": string;
}
