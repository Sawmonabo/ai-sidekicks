// A machine-authored body that could not be read, rendered at its position.
//
// Its own module for the one-component rule, and the split is where the rule earns
// its keep: this is the half of the honest-body pair that has to be TOTAL over
// `HydratedContentUnavailableReason`, and while it sat private inside `MachineBody`
// the sentence table sat with it — so the six sentences a reader can actually be
// shown were reachable only through a component that mostly renders bodies that ARE
// readable.
//
// THE MARKER NAME IS A WIRE VALUE, so it renders as a wire figure: mono, verbatim,
// exactly the string `DeclaredLossKind` carries, and bound to that union rather than
// typed as a string so a vocabulary rename fails to compile here.

import type { DeclaredLossKind, HydratedContentUnavailableReason } from "@ai-sidekicks/contracts";

import { Nothing, WireFigure } from "../../primitives/index.js";

/** The loss this console names when a stored body could not be read. */
const UNAVAILABLE_LOSS_KIND: DeclaredLossKind = "turn_content_unavailable";

/**
 * A sentence per unavailability reason. Total over the union by construction, so a
 * reason added to the contract fails to compile here rather than reaching a card that
 * renders it as blank space.
 *
 * The sentences say what happened and never what the reader should do about it: three
 * of these six are node-operator conditions and one is a tamper finding, and a card that
 * offered a remedy for any of them would be guessing at a cause it cannot see.
 */
const REASON_SENTENCES: Readonly<Record<HydratedContentUnavailableReason, string>> = {
  absent: "This turn was recorded without a body.",
  compacted: "This turn's body was destroyed when the session was compacted.",
  master_key_unavailable: "This turn's body is sealed and the key could not be obtained.",
  wrapped_key_missing: "This turn's body is sealed and this session holds no key for it.",
  digest_unbound: "This turn's stored body does not match what its signature covers.",
  decrypt_failed: "This turn's body is sealed and did not open.",
};

/**
 * Which reasons are a failure rather than a loss.
 *
 * `digest_unbound` alone: it means the stored bytes disagree with what the row's
 * signature commits to, which is the two-hue rule's red — an integrity finding a reader
 * must not mistake for retention doing its job.
 */
const INTEGRITY_FAILURE_REASONS: ReadonlySet<HydratedContentUnavailableReason> =
  new Set<HydratedContentUnavailableReason>(["digest_unbound"]);

export interface UnavailableBodyProps {
  readonly reason: HydratedContentUnavailableReason;
}

/** The turn, at its position, with an empty body and the reason it is empty. */
export function UnavailableBody(props: UnavailableBodyProps): React.JSX.Element {
  return (
    <div className="meridian-machine-body meridian-machine-body--unavailable">
      {/* The empty body, at its position. Present as an element rather than omitted so
          the row keeps the height and the structure a turn has, which is what "renders
          the turn at its position" means in a list. */}
      <p className="meridian-machine-body__empty" aria-hidden="true" />
      {/* The BLOCK placement, deliberately: the badge form renders `detail` as a
          `title` attribute and nothing else, so both the reason and the disposition
          would be a tooltip — unreachable by touch, by keyboard, and by a reader who
          never hovers. The requirement is that the console SAYS what happened,
          and an absence occupying the body's own region is a surface rather than a
          value-adjacent badge. */}
      <Nothing
        kind={INTEGRITY_FAILURE_REASONS.has(props.reason) ? "error" : "empty"}
        placement="surface"
        title={REASON_SENTENCES[props.reason]}
        detail="The turn is shown at its position with an empty body."
        action={<WireFigure value={UNAVAILABLE_LOSS_KIND} title="Declared loss" />}
      />
    </div>
  );
}
