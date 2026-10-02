// The transcript row: a flush-left line with a 2 px leading edge in the author's hue, the
// author and timestamp in a fixed gutter, and content in a single measure. The hue is only ever
// on the edge, never a tint behind body text, and the footer is revealed on hover and focus.
// Rows are `<article>` elements, named by their author where they have one, so a container can be
// `role="feed"`.

import { useId, useMemo } from "react";

import "./TranscriptRowLayout.css";
import { HUE_WHEEL_STEPS } from "@renderer/styles/palette.js";
import { formatHueWheelTokenName, tokenReference } from "@renderer/styles/tokens.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatClockTime } from "@renderer/lib/wire-figures.js";
import { type AgentHueAssignment } from "@renderer/styles/agent-hue.js";

/** What one transcript row lays out. */
export interface TranscriptRowLayoutProps {
  /** Wheel step, 0 to 11 — drives the 2 px leading edge. */
  readonly agentHueStep: number;
  readonly occurredAtIso: string;
  /** Who wrote the row; absent on a system message, which names the act and never the actor. */
  readonly authorLabel?: string;
  /** The row body, in a single measure. */
  readonly children?: React.ReactNode;
  /** Hover-revealed affordances. */
  readonly footer?: React.ReactNode;
  readonly isSuperseded?: boolean;
}

/** One transcript row: leading edge, actor and time gutter, body, and a revealed footer. */
export function TranscriptRowLayout(props: TranscriptRowLayoutProps): React.JSX.Element {
  const actorId = useId();

  // Formatted once per instant: `formatClockTime` builds a new `Intl.DateTimeFormat` per call.
  // A memo here, not a string on a row model, because callers of this primitive share no model.
  const occurredAtClockTime = useMemo(
    () => formatClockTime(props.occurredAtIso),
    [props.occurredAtIso],
  );

  // Fail closed: a step outside the wheel is not clamped into another author's color. The edge
  // falls back to the neutral boundary and the class says the row carries no attribution.
  const isAttributed =
    Number.isInteger(props.agentHueStep) &&
    props.agentHueStep >= 0 &&
    props.agentHueStep < HUE_WHEEL_STEPS;
  const edgeStyle: LeadingEdgeStyle = {
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
    <article
      className={className}
      {...(props.authorLabel === undefined ? {} : { "aria-labelledby": actorId })}
    >
      <span className="meridian-transcript-row-layout__edge" style={edgeStyle} aria-hidden="true" />
      <div className="meridian-transcript-row-layout__gutter">
        {props.authorLabel === undefined ? null : (
          <span className="meridian-transcript-row-layout__actor" id={actorId}>
            {props.authorLabel}
          </span>
        )}
        <WireFigure value={occurredAtClockTime} title={props.occurredAtIso} />
      </div>
      <div className="meridian-transcript-row-layout__body">
        {props.isSuperseded === true ? (
          <div className="meridian-transcript-row-layout__meta">
            <span className="meridian-transcript-row-layout__superseded-mark">Superseded</span>
          </div>
        ) : null}
        {props.children}
      </div>
      {props.footer !== undefined ? (
        <div className="meridian-transcript-row-layout__footer">{props.footer}</div>
      ) : null}
    </article>
  );
}

/**
 * A row's step on the hue wheel, or `-1`, which `TranscriptRowLayout` treats as unattributed
 * (neutral boundary). Not `0`: step zero belongs to somebody.
 */
export function hueStepOf(agentHue: AgentHueAssignment | undefined): number {
  return agentHue?.step ?? -1;
}

/** Carries the row's agent hue into the edge's fill patterns. */
interface LeadingEdgeStyle extends React.CSSProperties {
  readonly "--meridian-row-hue": string;
}
