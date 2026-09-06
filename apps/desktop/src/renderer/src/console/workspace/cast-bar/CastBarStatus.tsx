// The node's health, in the one line the bar has for it.
//
// THE COMPACT FORM OF A BANNER IS NOT A SMALL BANNER. A banner says what the room can
// no longer do and offers the next move; this says only whether anything is wrong and
// how much, and it is here because the cast bar is the one strip a person keeps in
// view while they work. Everything else about the node's health — which component,
// since when, what to do — belongs to the surface that owns the reading.
//
// THREE STATES AND NO FOURTH. Healthy renders NOTHING, because a mark that is always
// present says nothing by being present and trains a reader to stop seeing it; unwell
// renders a count; and a read that did not answer renders the "not checked" kind of
// nothing, which is the one thing a health surface must never dress up as healthy. A
// read still in flight also renders nothing, deliberately — a bar that grew a badge a
// few hundred milliseconds after it drew would move every chip beside it.
//
// WHY THE UNWELL MARK IS AMBER AND THIS IS NOT A CONTRADICTION. The chip's amber
// ground was removed by this same lane on the rule that a chip is never coloured for
// attention: hue on a CHIP is identity, because chips are how a person tells one
// participant from another. This is not a chip about a participant, it is the one
// place the bar reports a measurement, and rule 3 spends amber on exactly this — a
// person is needed. It carries the count in words as well, so the fact survives a
// reader who cannot separate the hues.

import { Chip, Nothing } from "../../primitives/index.js";
import { type CastBarHealthReading } from "./cast-bar-readings.js";
import { type CastBarReadState } from "./cast-bar-reads.js";

export interface CastBarStatusProps {
  readonly health: CastBarReadState<CastBarHealthReading>;
}

export function CastBarStatus(props: CastBarStatusProps): React.JSX.Element | null {
  const { health } = props;
  if (health.status === "reading") {
    return null;
  }
  if (health.status === "unavailable") {
    return (
      <span className="meridian-cast-bar__status">
        <Nothing
          kind="not-checked"
          title="Node health"
          detail={`${health.refusal.code}: ${health.refusal.detail}`}
        />
      </span>
    );
  }
  if (health.value.unwellComponentCount === 0) {
    return null;
  }
  return (
    <span className="meridian-cast-bar__status">
      <Chip tone="attention" glyph="alert" label={unwellLabel(health.value.unwellComponentCount)} />
      {/* The names, for a reader who wants them without leaving the bar. Visually
          hidden rather than truncated into the strip: the chip is the whole of what
          this surface claims the room needs to know at a glance, and a list that
          elided its own last entry would be a claim about which component matters. */}
      <span className="meridian-visually-hidden">
        {health.value.unwellComponentNames.join(", ")}
      </span>
    </span>
  );
}

/**
 * How the count reads.
 *
 * "Not healthy" and never "degraded" or "failing": the wire's own component states
 * are a set this console does not enumerate, and picking a severity word for a count
 * that spans them would be the renderer grading a measurement it only counted.
 */
function unwellLabel(unwellComponentCount: number): string {
  return unwellComponentCount === 1
    ? "1 component not healthy"
    : `${String(unwellComponentCount)} components not healthy`;
}
