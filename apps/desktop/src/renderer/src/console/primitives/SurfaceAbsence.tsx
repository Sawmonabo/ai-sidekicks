// A whole-surface absence, composed rather than left in flow.
//
// The `Nothing` primitive's `empty` arm is a quiet line, which is right where it
// belongs — inside a list that came back with no rows. A route that resolves to no
// surface is a different scale of absence: the same quiet line pinned to the
// top-left of a 1440 px window reads as a page that failed to finish painting. So
// this wrapper centres the copy on a measure and pairs it with the one control that
// definitely works, which keeps "there is nothing here" from also meaning "and
// there is nothing you can do".
//
// ITS OWN MODULE because it has more than one producer and never had only one:
// `frame/RouteSurface.tsx` raises three of these — the unknown address, the session
// still opening, and the slot nobody has claimed — and `seats/absorbed-surfaces.ts`
// raises three more, the fixture-source refusal, the address-names-no-session
// refusal, and the roster mount that was handed no bridge. A second centring wrapper
// in either would be two renderings of one idea, drifting apart the first time either
// measure changed, and only the screenshot tier would ever see it.
//
// IN `primitives/` RATHER THAN IN `frame/`, WHICH IS WHERE ITS FIRST PRODUCER PUT IT.
// It was authored beside the route surface because that was its only caller, and the
// absorbed Tier-1 mounts then had to reach it from below — an upward edge no
// arrangement of those mounts could write legally, since a view family cannot reach
// into `frame/` and cannot reach `frame/index.ts` either: that door re-exports
// `ConsoleRoot`, which composes every view family through `families.ts`, so the edge
// back closes a cycle. It is a presentational wrapper that knows no family: a centred
// measure, a body slot, and the one hint that is true on every surface. That is the
// same class as `Nothing`, `InlineRefusal`, and `PartialRead` beside it, so it sits
// with them and every producer reaches DOWN.
//
// Its class names moved with it, from the frame's prefix to its own. A stylesheet in
// one family carrying another family's prefix is the drift the per-family sheet rule
// exists to prevent, and the frame no longer owns this.

import { ChordHint } from "./ChordHint.js";
import { COMMAND_PALETTE_OPEN_CHORD } from "./chord-format.js";

export function SurfaceAbsence(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-surface-absence">
      <div className="meridian-surface-absence__body">{props.children}</div>
      <p className="meridian-surface-absence__hint">
        <ChordHint chord={COMMAND_PALETTE_OPEN_CHORD} /> opens the command palette.
      </p>
    </div>
  );
}
