// A whole-screen absence, composed rather than left in flow. `Nothing`'s `empty` arm is a quiet
// line for a list with no rows; the same line pinned top-left in a full window reads as unfinished
// paint. This wrapper centers the copy on a measure and pairs it with the one control that always
// works, the command palette chord.
//
// Shared because `app/AppRouter.tsx` and `registries/screens/PendingScreenBody.tsx` both draw
// through it; a feature cannot import `app/`, so it sits with `Nothing` and `InlineRefusal`.

import "./ScreenNotice.css";

import { ChordHint } from "../ChordHint/ChordHint.js";
import { COMMAND_PALETTE_OPEN_CHORD } from "@renderer/lib/chord-format.js";

/** Centers `children` on a measure with the command palette hint beneath. */
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
