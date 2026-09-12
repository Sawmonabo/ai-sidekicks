// The node's health, in the one line the bar has for it.
//
// THE COMPACT FORM OF A BANNER IS NOT A SMALL BANNER. A banner says what the room can
// no longer do and offers the next move; this says only whether anything is wrong and
// how much, and it is here because the cast bar is the one strip a person keeps in
// view while they work. Everything else about the node's health — which component,
// since when, what to do — belongs to the surface that owns the reading.
//
// THREE RENDERINGS AND NO FOURTH, over the four arms of the bar's health verdict.
// Healthy renders NOTHING, because a mark that is always present says nothing by being
// present and trains a reader to stop seeing it; unwell renders a count; and a read
// that did not answer renders the "not checked" kind of nothing, which is the one thing
// a health surface must never dress up as healthy. A read still in flight also renders
// nothing, deliberately — a bar that grew a badge a few hundred milliseconds after it
// drew would move everything beside it.
//
// WHY THE UNWELL MARK IS AMBER. This is the one place the bar reports a measurement,
// and amber is spent on exactly this — a person is needed. It carries the count in
// words as well, so the fact survives a reader who cannot separate the hues.

import { Chip, Nothing } from "../../primitives/index.js";
import { type CastBarHealthVerdict } from "./model/cast-bar-readings.js";

export interface CastBarStatusProps {
  /**
   * The bar's one health verdict, put by the bar above and read by it as well.
   *
   * The same value decides the all-clear line, which is the whole reason it is a
   * verdict: this component and that line are two renderings of one reading, and
   * before they shared it they could contradict each other on the same strip.
   */
  readonly verdict: CastBarHealthVerdict;
}

export function CastBarStatus(props: CastBarStatusProps): React.JSX.Element | null {
  const { verdict } = props;
  if (verdict.kind === "in-flight" || verdict.kind === "clear") {
    return null;
  }
  if (verdict.kind === "unchecked") {
    return (
      <span className="meridian-cast-bar__status">
        <Nothing
          kind="not-checked"
          title="Node health"
          detail={`${verdict.refusal.code}: ${verdict.refusal.detail}`}
        />
      </span>
    );
  }
  return (
    <span className="meridian-cast-bar__status">
      <Chip tone="attention" glyph="alert" label={unwellLabel(verdict.unwellComponentCount)} />
      {/* The names, for a reader who wants them without leaving the bar. Visually
          hidden rather than truncated into the strip: the chip is the whole of what
          this surface claims the room needs to know at a glance, and a list that
          elided its own last entry would be a claim about which component matters. */}
      <span className="meridian-visually-hidden">{verdict.unwellComponentNames.join(", ")}</span>
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
