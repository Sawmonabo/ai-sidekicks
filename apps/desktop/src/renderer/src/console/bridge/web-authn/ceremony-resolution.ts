// The WRITING half of the ceremony seam: an outcome, as the value a ceremony call
// resolves with.
//
// It is four lines and it is not folded into the caller, for the reason
// `apps/desktop/AGENTS.md` gives about two sides of one seam: the fixture composes
// this value and `ceremony-outcome.ts` reads it back, and a hand-written object
// literal at the fixture would be a second spelling of the member name the reader
// keys on. Written this way the two cannot disagree — the key is the reader's own
// constant, and the outcome is the reader's own union.
//
// A SEPARATE MODULE FROM THE READER so the door above publishes a writer to the one
// sibling that writes and a reader to everyone else. Folded into `ceremony-outcome.ts`
// the encoder would ship to every consumer of the union, including the sign-in family,
// which must never compose an outcome of its own: a renderer that can build an
// `authenticated` arm is a renderer that can assert an identity nothing established.

import { CEREMONY_OUTCOME_MEMBER, type ProducedCeremonyOutcome } from "./ceremony-outcome.js";

/**
 * Compose the value a ceremony call resolves with for one outcome.
 *
 * The return type is deliberately `object` rather than the contract's
 * `PublicKeyCredential`: this module has no business naming the preload contract,
 * and that stub is an empty interface every object satisfies, so the assignment at
 * the fixture's own call site is what pins the two together.
 */
export function encodeCeremonyResolution(outcome: ProducedCeremonyOutcome): object {
  return { [CEREMONY_OUTCOME_MEMBER]: outcome };
}
