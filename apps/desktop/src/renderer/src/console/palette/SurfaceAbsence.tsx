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
// IT LIVES IN `palette/` AND NOT IN `frame/`, WHERE IT WAS. Its two inputs are this
// family's open chord and a primitive, and its readers are the frame and a view
// family — and a view family cannot import `frame/index.ts`, whose barrel reaches
// `ConsoleRoot` and through it every family, so that edge closes a cycle. It was
// therefore reached by a deep specifier, which `console-cross-family-deep-import`
// reports and whose remedy is this move: the lowest family that owns the inputs. Its
// class names moved with it — `meridian-surface-absence` rather than
// `meridian-surface-absence` — because a class named for a family that no longer owns
// the component is the drift the stylesheet-ownership rule exists to stop.
//
// ITS OWN MODULE because it has more than one producer and never had only one:
// `RouteSurface.tsx` raises three of these — the unknown address, the session still
// opening, and the slot nobody has claimed — and `legacy-surfaces.ts` raises two
// more, the fixture-source refusal and the address-names-no-session refusal. A
// second centring wrapper in either would be two renderings of one idea, drifting
// apart the first time either measure changed, and only the screenshot tier would
// ever see it.

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
