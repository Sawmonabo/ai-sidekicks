// The composer's input and its one primary action — reserved, not stubbed.
//
// This zone is the send router's: `Spec-023 §Signature Feature Composition
// Sketches` has Send resolve "to the one wire call the addressed target admits",
// which means the control cannot exist before the resolution does. A Send button
// wired to nothing would be the worst of the three outcomes available here — it
// accepts a person's sentence and drops it.
//
// So the zone renders the absence instead, and the composer keeps exactly one
// primary action for the router lane to fill.

import { Nothing } from "../../../console/primitives/index.js";

export function ComposerSendBar(): React.JSX.Element {
  return (
    <div className="meridian-composer__send">
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The message input has not been built yet."
        detail="Send resolves to the one call the addressed target admits, so the input and its action land together with that resolution."
      />
    </div>
  );
}
