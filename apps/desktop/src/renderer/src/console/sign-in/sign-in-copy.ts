// What each closed arm of the ceremony vocabulary MEANS, in one place.
//
// Every table here is TOTAL over a tuple `bridge/web-authn/ceremony-outcome.ts`
// declares, so an arm added there is a compile error here rather than a state that
// renders as a blank line. That is the same discipline the provider-accounts page
// applies to the contract's own closed sets, applied to this console's.
//
// COPY RULES, from `Spec-023 §Console Design (Meridian)` rule 6: sentence case, past
// tense for receipts, no exclamation marks, no celebration, and no sentence that
// claims a capability the code does not implement. A probe result says what the host
// reported and what happens next; it never blames the machine or the person.
//
// ONE ARM IS SAID TWICE, ON PURPOSE. The same refusal reason means something
// different on the way in and during an enrolment — the first ends with nobody
// signed in and the second leaves the session untouched — so the two readings are
// two tables over one closed tuple rather than one table read in two places. The
// selector at the foot of this file is where an enrolment picks between them, and it
// is here rather than in the card because which sentence a state carries is copy.

import type {
  WebAuthnCustody,
  WebAuthnProbeResult,
  WebAuthnRefusalReason,
} from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import type { EnrolmentRefusal } from "./sign-in-flow.js";

/** What a probe found, and why the browser hand-off follows from it. */
export const PROBE_RESULT_NOTES: Readonly<Record<WebAuthnProbeResult, string>> = {
  "no-authenticator": "This machine reported no authenticator it could use for a passkey.",
  "no-prf":
    "The authenticator that answered does not support the extension this app derives its key from.",
  "binding-unavailable": "The passkey support for this platform did not load on this machine.",
};

/** Why a ceremony ended without signing in, on a host that was capable. */
export const REFUSAL_REASON_NOTES: Readonly<Record<WebAuthnRefusalReason, string>> = {
  cancelled: "The passkey prompt was dismissed, so nothing was signed in.",
  "verification-failed": "The server did not accept the passkey this machine offered.",
  "origin-mismatch":
    "The sign-in options did not match the address this install is paired to, so no passkey was asked for.",
};

/** Where what this session mints is kept, stated at the moment it is minted. */
export const CUSTODY_NOTES: Readonly<Record<WebAuthnCustody, string>> = {
  durable: "Signed in. This machine's keystore is holding the credential.",
  "memory-only":
    "Signed in for this run only. The keystore is unavailable, so nothing was written to disk and signing in again will be needed after a restart.",
};

/**
 * The note the signed-out card carries under its one action.
 *
 * It is a standing product fact rather than a state: nothing in `Spec-023` or
 * `Spec-007` makes a control-plane identity a precondition for a local session, and
 * `Spec-026 §Trigger` deliberately does not gate first launch — so a person reading
 * this card is being offered something, never stopped.
 */
export const LOCAL_SESSION_NOTE =
  "A session on this machine needs no account. Signing in is what lets other people join one.";

/** What the browser hand-off is, said before the browser opens. */
export const DEVICE_GRANT_NOTE =
  "Signing in continues in a browser. This window keeps the code below and finishes on its own once the browser is done.";

/**
 * Why an ENROLMENT ended without adding a passkey, on a host that was capable.
 *
 * A table of its own beside {@link REFUSAL_REASON_NOTES} rather than a reuse of it,
 * and the `cancelled` row is why: that one ends "so nothing was signed in", which is
 * false of an enrolment — the session it ran from is untouched, and a card carrying
 * that sentence would be telling a signed-in person they are not. Total over the
 * same tuple, so a fourth reason is a compile error in both places at once.
 */
const ENROLMENT_REFUSAL_NOTES: Readonly<Record<WebAuthnRefusalReason, string>> = {
  cancelled: "The passkey prompt was dismissed, so no passkey was added.",
  "verification-failed":
    "The server did not accept the passkey this machine offered, so no passkey was added.",
  "origin-mismatch":
    "The enrolment options did not match the address this install is paired to, so no passkey was asked for.",
};

/**
 * The code and the sentence one refused enrolment is rendered under.
 *
 * TOTAL over the three arms an enrolment settles into without adding a passkey, so a
 * fourth outcome arm is a compile error here rather than a state that renders as a
 * blank line. Each arm's code is the wire vocabulary its producer actually sent, and
 * the `unavailable` arm's sentence is that producer's own text rather than this
 * console's — the refusal grammar's rule, kept where there is a message to quote.
 *
 * The probe notes are reused unchanged: what a probe found is a fact about the host
 * and reads the same whichever ceremony asked, which is exactly the case the
 * enrolment table above is NOT.
 */
export function describeEnrolmentRefusal(
  refusal: EnrolmentRefusal,
): Pick<ConsoleRefusal, "code" | "detail"> {
  switch (refusal.kind) {
    case "refused":
      return { code: refusal.reason, detail: ENROLMENT_REFUSAL_NOTES[refusal.reason] };
    case "fallback-required":
      return { code: refusal.probeResult, detail: PROBE_RESULT_NOTES[refusal.probeResult] };
    case "unavailable":
      return { code: refusal.refusal.code, detail: refusal.refusal.detail };
  }
}
