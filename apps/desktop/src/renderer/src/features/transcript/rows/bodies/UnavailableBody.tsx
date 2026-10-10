// A machine-authored turn recorded without content, rendered at its position.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";

/** The sentence a turn recorded without content draws, and a copy of it carries. */
export const UNAVAILABLE_BODY_TITLE = "This turn was recorded without content.";

/** The turn, at its position, with no content and the sentence saying so. */
export function UnavailableBody(): React.JSX.Element {
  return (
    <div className="meridian-machine-body">
      {/* Present as an element so the row keeps a turn's height and structure. */}
      <p className="meridian-machine-body__empty" aria-hidden="true" />
      {/* Block placement: the badge form shows `detail` only in its hover label. */}
      <Nothing
        kind="empty"
        placement="block"
        title={UNAVAILABLE_BODY_TITLE}
        detail="The turn is shown at its position with no content."
      />
    </div>
  );
}
