// What an account's state and its one remedy read as on screen, in the Providers page's words.
//
// One entry per readiness state and per remedy and no other: the vocabularies are the
// contract's, so a new upstream arm is a compile error here. Each is a fixed string, never
// assembled from a refusal's payload; only the provider's on-screen name is put in.

import type {
  BillingMode,
  ProviderReadinessState,
  ProviderRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";
import { PROVIDER_LABELS, type ProviderName } from "@ai-sidekicks/contracts/provider/name";

/**
 * What each readiness state reads as, given the provider it is about. An account's stored health
 * state is one of the first four, so its row reads from the same words; no wire spelling reaches
 * the screen.
 */
export const PROVIDER_READINESS_STATE_WORDS: Readonly<
  Record<ProviderReadinessState, (provider: ProviderName) => string>
> = {
  authenticated: () => "Signed in",
  reauth_required: () => "Login expired · Sign in again",
  home_missing: () => "No credential in this account's folder",
  indeterminate: () => "Cannot tell right now",
  // These two states each read as one whole sentence, the one their remedy carries.
  no_account: (provider) => noAccountsSentence(provider),
  no_default: (provider) => noDefaultSentence(provider),
};

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
type AccountPlaneRemedySentenceKind = ProviderRemedy["kind"] | "sign_in_to_empty_folder";

/** The one sentence for each remedy, given the provider it is about. */
export const ACCOUNT_PLANE_REMEDY_SENTENCES: Readonly<
  Record<AccountPlaneRemedySentenceKind, (provider: ProviderName) => string>
> = {
  register: (provider) => noAccountsSentence(provider),
  choose_default: (provider) => noDefaultSentence(provider),
  sign_in: () =>
    "Sign in again through the provider's own sign-in, against this account's own folder.",
  sign_in_to_empty_folder: () =>
    "Sign in against this account's own folder to put a credential back in it.",
  paste_token: () =>
    "This account cannot refresh itself. When the token stops working, mint a new one and " +
    "paste it here. Mint a fresh token at the provider and paste it below.",
  look_again: () =>
    "Nothing is wrong that can be seen from here. The next check may settle it; pressing " +
    "Check now asks again.",
};

/** The remedy sentence for a remedy on a readiness state, worded apart for an empty folder. */
export function accountPlaneRemedySentence(
  kind: ProviderRemedy["kind"],
  state: ProviderReadinessState,
  provider: ProviderName,
): string {
  const sentenceKind =
    kind === "sign_in" && state === "home_missing" ? "sign_in_to_empty_folder" : kind;
  return ACCOUNT_PLANE_REMEDY_SENTENCES[sentenceKind](provider);
}

function noAccountsSentence(provider: ProviderName): string {
  return `No accounts for ${PROVIDER_LABELS[provider]}. Sign in to run work on this provider.`;
}

function noDefaultSentence(provider: ProviderName): string {
  return (
    "No account is marked the default, so new work on " +
    `${PROVIDER_LABELS[provider]} will not start. Mark one.`
  );
}
