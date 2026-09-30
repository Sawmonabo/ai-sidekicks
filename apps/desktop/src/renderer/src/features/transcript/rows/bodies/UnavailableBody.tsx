// A machine-authored body that could not be read, rendered at its position. The sentence table
// is total over `HydratedContentUnavailableReason`, and the marker name is a wire value, so it
// renders as a wire figure bound to `DeclaredLossKind`.

import type { DeclaredLossKind, HydratedContentUnavailableReason } from "@ai-sidekicks/contracts";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";

/** The loss this console names when a stored body could not be read. */
const UNAVAILABLE_LOSS_KIND: DeclaredLossKind = "turn_content_unavailable";

/**
 * A sentence per unavailability reason, total over the union so a reason added to the contract
 * fails to compile here. The sentences say what happened, never what to do: several are
 * node-operator conditions the card cannot diagnose.
 */
const REASON_SENTENCES: Readonly<Record<HydratedContentUnavailableReason, string>> = {
  absent: "This turn was recorded without a body.",
  purged: "This turn's content was deleted with its session.",
  master_key_unavailable: "This turn's body is sealed and the key could not be obtained.",
  wrapped_key_missing: "This turn's body is sealed and this session holds no key for it.",
  decrypt_failed: "This turn's body is sealed and did not open.",
};

/** The reason a stored body could not be read. */
export interface UnavailableBodyProps {
  readonly reason: HydratedContentUnavailableReason;
}

/** The turn, at its position, with an empty body and the reason it is empty. */
export function UnavailableBody(props: UnavailableBodyProps): React.JSX.Element {
  return (
    <div className="meridian-machine-body meridian-machine-body--unavailable">
      {/* Present as an element so the row keeps a turn's height and structure. */}
      <p className="meridian-machine-body__empty" aria-hidden="true" />
      {/* Block placement: the badge form renders `detail` only as a `title` tooltip. */}
      <Nothing
        kind="empty"
        placement="block"
        title={REASON_SENTENCES[props.reason]}
        detail="The turn is shown at its position with an empty body."
        action={<WireFigure value={UNAVAILABLE_LOSS_KIND} title="Declared loss" />}
      />
    </div>
  );
}
