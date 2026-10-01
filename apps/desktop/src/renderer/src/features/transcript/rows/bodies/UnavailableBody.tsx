// A machine-authored turn recorded without content, rendered at its position. The marker name is
// a wire value, so it renders as a wire figure bound to `DeclaredLossKind`.

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";

/** The loss this console names when a turn carries no content. */
const UNAVAILABLE_LOSS_KIND: DeclaredLossKind = "turn_content_unavailable";

/** The turn, at its position, with no content and the sentence saying so. */
export function UnavailableBody(): React.JSX.Element {
  return (
    <div className="meridian-machine-body meridian-machine-body--unavailable">
      {/* Present as an element so the row keeps a turn's height and structure. */}
      <p className="meridian-machine-body__empty" aria-hidden="true" />
      {/* Block placement: the badge form renders `detail` only as a `title` tooltip. */}
      <Nothing
        kind="empty"
        placement="block"
        title="This turn was recorded without content."
        detail="The turn is shown at its position with no content."
        action={<WireFigure value={UNAVAILABLE_LOSS_KIND} title="Declared loss" />}
      />
    </div>
  );
}
