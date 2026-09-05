// A whole-surface absence, composed rather than left in flow.
//
// The `Nothing` primitive's `empty` arm is a quiet line, which is right where it
// belongs — inside a list that came back with no rows. A route that resolves to no
// surface is a different scale of absence: the same quiet line pinned to the
// top-left of a 1440 px window reads as a page that failed to finish painting. So
// the frame centres it on a measure and pairs it with the one control that
// definitely works, which keeps "there is nothing here" from also meaning "and
// there is nothing you can do".
//
// ITS OWN MODULE because it has more than one producer and never had only one:
// `RouteSurface.tsx` raises three of these — the unknown address, the session still
// opening, and the slot nobody has claimed — and `legacy-surfaces.ts` raises two
// more, the fixture-source refusal and the address-names-no-session refusal. A
// second centring wrapper in either would be two renderings of one idea, drifting
// apart the first time either measure changed, and only the screenshot tier would
// ever see it.

import { COMMAND_PALETTE_OPEN_CHORD } from "../palette/index.js";
import { ChordHint } from "../primitives/index.js";

export function SurfaceAbsence(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-frame__absence">
      <div className="meridian-frame__absence-body">{props.children}</div>
      <p className="meridian-frame__absence-hint">
        <ChordHint chord={COMMAND_PALETTE_OPEN_CHORD} /> opens the command palette.
      </p>
    </div>
  );
}
