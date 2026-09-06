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
// `RouteSurface.tsx` raises three of these — the unknown address, the session still
// opening, and the slot nobody has claimed — and `legacy-surfaces.ts` raises two
// more, the fixture-source refusal and the address-names-no-session refusal. A
// second centring wrapper in either would be two renderings of one idea, drifting
// apart the first time either measure changed, and only the screenshot tier would
// ever see it.
//
// IT LIVES IN `palette/` AND NOT IN `frame/`, WHERE IT WAS WRITTEN. Both inputs are
// this family's or below it — the palette's own open chord, which it names in its
// hint, and the primitives' chord printer — and a view family that raises a
// surface-scale absence of its own can reach this door and cannot reach the frame's:
// `frame/index.ts` re-exports `ConsoleRoot`, which reaches `families.ts`, which
// composes every view family in, so an import back closes a cycle. The class stem
// moved with it — `meridian-frame__absence` named a family that no longer owns the
// rules — and its sheet is `surface-absence.css` beside this file, entering through
// this family's door like every other console stylesheet.

import { ChordHint } from "../primitives/index.js";
import { COMMAND_PALETTE_OPEN_CHORD } from "./PaletteOverlay.js";

export function SurfaceAbsence(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-surface-absence">
      <div className="meridian-surface-absence-body">{props.children}</div>
      <p className="meridian-surface-absence-hint">
        <ChordHint chord={COMMAND_PALETTE_OPEN_CHORD} /> opens the command palette.
      </p>
    </div>
  );
}
