// What each remedy kind reads as, in this console's own words.
//
// One sentence per remedy kind and no other: the vocabulary is `ProviderRemedy["kind"]`, so a
// new upstream arm is a compile error here. Each names the act, not how to perform it: which
// command signs in and which home it writes into are the daemon's to disclose on the readiness
// entry, so these are fixed strings and not assembled from a refusal's payload.

import type { ProviderRemedy } from "@ai-sidekicks/contracts/provider-account";

/** The fixed sentence the handoff shows for each remedy kind. */
export const ACCOUNT_PLANE_HANDOFF_SENTENCES: Readonly<Record<ProviderRemedy["kind"], string>> = {
  register: "No account is registered for that provider. Registering one closes this.",
  choose_default:
    "Accounts are registered and the request could not resolve to " +
    "one of them. Choosing which account answers for that provider " +
    "closes this.",
  sign_in:
    "An account resolved and its credential home is not signed in. " +
    "The provider's own sign-in, and the home it authenticates into, " +
    "are shown beside that account \u2014 this window runs neither.",
  paste_token:
    "This account cannot refresh itself. Mint a fresh token at the provider and paste it.",
  look_again: "Nothing is wrong that can be seen from here. The next check may settle it.",
};
