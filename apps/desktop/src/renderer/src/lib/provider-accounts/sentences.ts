// What an account's state, its one remedy and the account list's read read as on screen, in the
// Providers page's words.
//
// One entry per readiness state and per remedy and no other: the vocabularies are the
// contract's, so a new upstream arm is a compile error here. Each is a fixed string, never
// assembled from a refusal's payload; only the provider's name, as the service's list gives it, is
// put in.

import type {
  BillingMode,
  ProviderReadinessState,
  ProviderRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";

/**
 * What each readiness state reads as, given the name of the provider it is about. An account's
 * stored health state is one of the first four, so its row reads from the same words; no wire
 * spelling reaches the screen.
 */
export const PROVIDER_READINESS_STATE_WORDS: Readonly<
  Record<ProviderReadinessState, (providerName: string) => string>
> = {
  authenticated: () => "Signed in",
  reauthRequired: () => "Login expired · Sign in again",
  homeMissing: () => "No credential in this account's folder",
  indeterminate: () => "Cannot tell right now",
  // These two states each read as one whole sentence, the one their remedy carries.
  noAccount: (providerName) => noAccountsSentence(providerName),
  noCurrent: (providerName) => noDefaultSentence(providerName),
};

/**
 * What the account list reads before its read lands and after one is refused, on the Providers
 * page and on every account picker, which lists accounts as that page does.
 */
export const ACCOUNT_LIST_READ_WORDS = {
  reading: "Loading accounts…",
  refused: "Couldn't load accounts",
} as const;

/** What each billing mode reads as on an account's billing chip. */
export const BILLING_MODE_WORDS: Readonly<Record<BillingMode, string>> = {
  subscription: "Subscription",
  metered: "Metered",
  unknown: "Billing not set",
};

/**
 * Which remedy sentence applies: a remedy kind, with the sign-in split off for an account whose
 * folder holds no credential at all, since that one puts a credential back rather than renewing it.
 */
type AccountPlaneRemedySentenceKind = ProviderRemedy["kind"] | "signInToEmptyFolder";

/** The one sentence for each remedy, given the name of the provider it is about. */
export const ACCOUNT_PLANE_REMEDY_SENTENCES: Readonly<
  Record<AccountPlaneRemedySentenceKind, (providerName: string) => string>
> = {
  register: (providerName) => noAccountsSentence(providerName),
  chooseCurrent: (providerName) => noDefaultSentence(providerName),
  signIn: () =>
    "Sign in again through the provider's own sign-in, against this account's own folder.",
  signInToEmptyFolder: () =>
    "Sign in against this account's own folder to put a credential back in it.",
  pasteToken: () =>
    "This account cannot refresh itself. When the token stops working, mint a new one and " +
    "paste it here. Mint a fresh token at the provider and paste it below.",
  lookAgain: () =>
    "Nothing is wrong that can be seen from here. The next check may settle it; pressing " +
    "Check now asks again.",
};

/** The remedy sentence for a remedy on a readiness state, worded apart for an empty folder. */
export function accountPlaneRemedySentence(
  kind: ProviderRemedy["kind"],
  state: ProviderReadinessState,
  providerName: string,
): string {
  const sentenceKind = kind === "signIn" && state === "homeMissing" ? "signInToEmptyFolder" : kind;
  return ACCOUNT_PLANE_REMEDY_SENTENCES[sentenceKind](providerName);
}

function noAccountsSentence(providerName: string): string {
  return `No accounts for ${providerName}. Sign in to run work on this provider.`;
}

function noDefaultSentence(providerName: string): string {
  return (
    "No account is marked the default, so new work on " +
    `${providerName} will not start. Mark one.`
  );
}
