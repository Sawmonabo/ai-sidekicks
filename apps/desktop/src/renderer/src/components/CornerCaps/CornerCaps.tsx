// Rounded corners drawn over a box rather than cut from it. Chromium cannot hit-test a point
// under a rounded clip on its compositor, so a scroller inside a box that clips its content to
// rounded corners waits for the main thread at the start of every wheel turn and touch. A cap
// instead paints the ground outside the curve, and the edge along it, over whatever the box draws
// there, and takes no pointer, so the compositor's hit test passes through to the scroller.
import "./CornerCaps.css";

/** A corner of the box a cap sits in, block side then inline side: `end-start` is bottom left. */
export type CornerCapCorner = "start-start" | "start-end" | "end-start" | "end-end";

/** Props for `CornerCaps`. */
export interface CornerCapsProps {
  /** The corners to draw, each once. */
  readonly corners: readonly CornerCapCorner[];
}

/**
 * Caps over the given corners of the nearest positioned box. The box sets their radius, the ground
 * they paint and the width of its edge through `--meridian-corner-cap-radius`,
 * `--meridian-corner-cap-ground` and `--meridian-corner-cap-edge`; the edge's color is the box's
 * own border color.
 */
export function CornerCaps(props: CornerCapsProps): React.JSX.Element {
  return (
    <>
      {props.corners.map((corner) => (
        <span
          key={corner}
          className={`meridian-corner-cap meridian-corner-cap--${corner}`}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
