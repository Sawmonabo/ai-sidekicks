// A machine-authored turn recorded without content, rendered at its position.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";

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
        title="This turn was recorded without content."
        detail="The turn is shown at its position with no content."
      />
    </div>
  );
}
