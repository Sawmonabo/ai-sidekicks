// What each readiness state and each remedy kind MEANS, in one place.
//
// Both tables are TOTAL over closed unions `packages/contracts` declares, so an arm
// added upstream is a compile error here rather than a row that renders with a blank
// line where its account's state goes. That is the discipline the provider-accounts
// page already applies to this same plane's vocabularies.
//
// A STATE SENTENCE SAYS WHAT IS TRUE, NEVER WHAT TO DO. The remedy is the daemon's
// and it arrives on the entry; a state sentence that also proposed an action would be
// this console composing a second remedy beside the one it was handed.
//
// AND `authenticated` IS THE ONLY ARM THAT REPORTS A PROVIDER AS SET UP. A plan
// label, a billing mode, an observed email, or a credential home that exists on disk
// is not evidence — `Spec-026 §Provider Authentication (Group B)` says so, and the
// five other sentences below each say plainly that the provider cannot run yet.
//
// WHY THIS IS THE SECOND TABLE OVER THIS UNION, AND NOT A DUPLICATE. The
// provider-accounts settings page carries its own sentences for the same six arms,
// and the two are kept apart on REGISTER rather than merged: that page is a registry
// operator's reference and states what run admission WOULD do about each arm; this is
// a first-run walkthrough and states what is true of this provider RIGHT NOW, in the
// second person, for somebody who has not met the registry yet. The closed set has
// one home — `packages/contracts` — so an arm added upstream is a compile error in
// both places; what differs is the voice, and hoisting one table would put an
// operator's reference into a setup step or a setup step's reassurance into a
// reference. The neighbour is named here so a later reader finds both.

import type { ProviderReadinessState, ProviderRemedy } from "@ai-sidekicks/contracts";

/** What the daemon's stored observation means for this provider, per arm. */
export const READINESS_STATE_NOTES: Readonly<Record<ProviderReadinessState, string>> = {
  authenticated: "Ready. A run can start against this provider now.",
  reauth_required:
    "Signed out. The account this provider resolves to needs to be signed in again before a run can start.",
  home_missing:
    "The credential home this provider's account signs into is missing or unreadable, so a run cannot start.",
  indeterminate:
    "The last observation could not decide whether this provider is signed in, which counts as not signed in.",
  no_account: "No account is registered for this provider, so there is nothing for a run to use.",
  no_default:
    "Accounts exist for this provider and none is marked as the one to use, so a run has nothing to resolve to.",
};

/** The short label a row leads with. Sentence case, no punctuation. */
export const READINESS_STATE_LABELS: Readonly<Record<ProviderReadinessState, string>> = {
  authenticated: "Ready",
  reauth_required: "Signed out",
  home_missing: "Credential home missing",
  indeterminate: "Undetermined",
  no_account: "No account",
  no_default: "No default account",
};

/** The remedy as display text — the daemon composed it; this names what it is. */
export function remedyHeadline(remedy: ProviderRemedy): string {
  switch (remedy.kind) {
    case "register":
      return "Register an account for this provider.";
    case "choose_default":
      return `Mark one of the ${String(remedy.candidateAccountIds.length)} registered accounts as the one to use.`;
    case "sign_in":
      return "Sign in to this provider's own account, in its own first-party flow.";
  }
}

/** How long ago is deliberately not computed — the reading is shown as it arrived. */
export const OBSERVED_AT_UNSET_NOTE =
  "No observation has been recorded for this provider on this node.";

/** What onboarding finishing with nothing registered actually means. */
export const ZERO_ACCOUNTS_NOTE =
  "Finishing here with no provider ready is a finished setup, not a failure. What it costs is that the first run against one of these providers is refused, and the refusal names the same remedy this step does.";
