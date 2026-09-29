// A whole-screen absence, composed rather than left in flow.
//
// The `Nothing` primitive's `empty` arm is a quiet line, which is right where it
// belongs — inside a list that came back with no rows. A route that resolves to no
// screen is a different scale of absence: the same quiet line pinned to the
// top-left of a 1440 px window reads as a page that failed to finish painting. So
// this wrapper centers the copy on a measure and pairs it with the one control that
// definitely works, which keeps "there is nothing here" from also meaning "and
// there is nothing you can do".
//
// ITS OWN MODULE because it has more than one producer:
// `app/router.tsx` raises two of these — the unknown address and
// the session still opening — and the transcript and `registries/screens/PendingScreenBody.tsx`
// draw through it too. A second centering wrapper in any of them would be two
// renderings of one idea, drifting apart the first time either measure changed, and
// only the screenshot tier would ever see it.
//
// A SHARED COMPONENT RATHER THAN A FEATURE'S OR `app/`'s. A feature cannot import `app/`,
// which composes every feature, and this is a presentational wrapper that knows no
// feature: a centered measure, a body region, and the one hint that is true on every screen. That is the same class as
// `Nothing`, `InlineRefusal`, and `PartialRead` beside it, so it sits with them and
// every producer reaches DOWN.
//
// Its class names carry its own prefix rather than the frame's: a stylesheet in one
// component carrying another's prefix is the drift that one owning sheet per class
// exists to prevent.

import "./ScreenNotice.css";

import { ChordHint } from "../ChordHint/ChordHint.js";
import { COMMAND_PALETTE_OPEN_CHORD } from "@renderer/lib/chord-format.js";

export function ScreenNotice(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-screen-notice">
      <div className="meridian-screen-notice__body">{props.children}</div>
      <p className="meridian-screen-notice__hint">
        <ChordHint chord={COMMAND_PALETTE_OPEN_CHORD} /> opens the command palette.
      </p>
    </div>
  );
}
