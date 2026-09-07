// What each remedy kind reads as, in this console's own words.
//
// Three sentences and no fourth: the vocabulary is `ProviderRemedy["kind"]`, so a
// remedy arm added upstream is a compile error here rather than a kind that routes
// to a control with no label.
//
// EACH SENTENCE NAMES THE ACT AND NOT HOW TO PERFORM IT. "Sign in to that account's
// credential home" is the act; which command signs in, and which home it writes into,
// are the daemon's to disclose and travel on the readiness entry. A sentence here
// that named either would be this console composing a remedy — the thing the accounts
// page refuses in terms, and the reason these are three fixed strings rather than
// anything assembled from a refusal's payload.

import type { ProviderRemedy } from "@ai-sidekicks/contracts";

export const ACCOUNT_PLANE_ACT_SENTENCES: Readonly<Record<ProviderRemedy["kind"], string>> = {
  register: "No account is registered for that provider. Registering one closes this.",
  choose_default:
    "Accounts are registered and the request could not resolve to one of them. Choosing which account answers for that provider closes this.",
  sign_in:
    "An account resolved and its credential home is not signed in. The provider's own sign-in, and the home it authenticates into, are shown beside that account \u2014 this window runs neither.",
};
