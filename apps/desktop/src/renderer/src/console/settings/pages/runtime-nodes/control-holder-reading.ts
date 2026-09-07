// Who holds the session's shared terminal, as the roster read answered it.
//
// The registered `runtimenode.roster` reply carries `controlHolder` beside its node
// set — SESSION-level, because one lease exists per session, which is why it is not a
// member of any row. This module turns the seam's three-armed observation into the
// four readings a person can actually be shown, and it does nothing else: no wire, no
// React, no store.
//
// WHY `unheld` IS ITS OWN ARM AND `null` IS NOT SPLIT FURTHER. A `null` holder carries
// two facts at once — the lease is free, or a held lease was read-suppressed while its
// producing node is server-classified offline — and the control plane serves both the
// same way ON PURPOSE: no client should offer write affordances against a holder the
// control plane cannot vouch live. So this reading has one arm for `null` and the
// render says "unheld" without deciding which of the two happened. Splitting it here
// would be the renderer inventing a distinction the wire withholds.
//
// WHAT IS NOT HERE, AND WILL NOT BE. Taking or releasing the lease. Those are the
// terminal deck's controls against the daemon that owns the lease record; this page
// reports the projection and offers nothing.

import type { ParticipantId } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../core/index.js";
import type { NodeRosterObservation } from "../../../seats/index.js";

/**
 * The four readings, one per rendered arm.
 *
 * `unread` and `unheld` are deliberately distinct, for the reason the seam's own
 * `unread` arm exists: before the absorbed roster's effect has fired nothing has been
 * answered, and saying "nobody holds the shell" then is a false statement about the
 * session rather than an honest one about the read.
 */
export type ControlHolderReading =
  | { readonly kind: "unread" }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal }
  | { readonly kind: "unheld" }
  | { readonly kind: "held"; readonly participantId: ParticipantId };

/** The opening arm and the free-lease arm, frozen so their identity does not churn. */
const UNREAD: ControlHolderReading = { kind: "unread" };
const UNHELD: ControlHolderReading = { kind: "unheld" };

/**
 * Read the holder out of what the roster read answered.
 *
 * Total over the observation union, and it consumes the SAME response the node rows
 * beside it are drawn from — the one the absorbed roster already performed. A second
 * `runtimenode.roster` here would be a second answer, and a holder line disagreeing
 * with the rows under it is exactly what the console's read seam exists to prevent.
 */
export function controlHolderReadingOf(observation: NodeRosterObservation): ControlHolderReading {
  if (observation.kind === "unread") {
    return UNREAD;
  }
  if (observation.kind === "unreadable") {
    return { kind: "unreadable", refusal: observation.refusal };
  }
  const { controlHolder } = observation.response;
  return controlHolder === null ? UNHELD : { kind: "held", participantId: controlHolder };
}
