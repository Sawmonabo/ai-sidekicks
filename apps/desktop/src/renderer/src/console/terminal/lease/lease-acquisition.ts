// Whether this window may take the shell, and what stands where the control does not.
//
// A FOLD RATHER THAN A CONDITION IN THE LINE, on `lease-claim.ts`'s rule: the lease
// line RENDERS, and the moment it acquires a rule that rule belongs somewhere it can
// be driven without mounting React.
//
// THERE IS NO ENTITLEMENT AXIS, and its absence is the design. The shell belongs to the
// one person using this machine, so nothing here asks what they are allowed to do —
// every window that can say which window it is may take the shell. What the fold still
// needs is the IDENTITY, because it is how `held-by-you` is told from a hold this window
// does not have: a control offered without it would be one whose outcome the surface
// cannot report, since a take would come back as a hold it could not recognise as its
// own, the button would still read Claim, and there would be no way to release.
//
// RELEASE IS NOT GATED AT ALL. A window that holds the shell holds it until a transition
// says otherwise, and the only way back is this control.

import type { ConsoleRefusal } from "../../core/index.js";
import type { TerminalLeaseHolding } from "./lease-model.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";

/** Why no acquisition control is offered. Each arm is a different sentence. */
export type TerminalClaimWithholding =
  /** The identity read is still out. Nothing has been established yet. */
  | { readonly reason: "identity-not-read" }
  | { readonly reason: "identity-refused"; readonly refusal: ConsoleRefusal };

/** Which control the lease line offers, or the reason it offers none. */
export type TerminalClaimAffordance =
  | { readonly control: "release" }
  | { readonly control: "acquire" }
  | { readonly control: "none"; readonly withheld: TerminalClaimWithholding };

/**
 * Resolve the one control this surface allows, from the holding and the identity read.
 *
 * Release comes FIRST and unconditionally, so a window holding the shell is never left
 * without the control that hands it back.
 */
export function resolveTerminalClaimAffordance(input: {
  readonly holding: TerminalLeaseHolding;
  readonly viewerIdentity: TerminalViewerIdentity;
}): TerminalClaimAffordance {
  if (input.holding === "held-by-you") {
    return { control: "release" };
  }
  if (input.viewerIdentity.status === "not-loaded") {
    return { control: "none", withheld: { reason: "identity-not-read" } };
  }
  if (input.viewerIdentity.status === "refused") {
    return {
      control: "none",
      withheld: { reason: "identity-refused", refusal: input.viewerIdentity.refusal },
    };
  }
  return { control: "acquire" };
}
