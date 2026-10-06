// What an account is called, and what its state and its one remedy read as on screen, in the
// Providers page's words.
//
// One entry per readiness state and per remedy and no other: the vocabularies are the
// contract's, so a new upstream arm is a compile error here. Each is a fixed string, never
// assembled from a refusal's payload; only the provider's on-screen name is put in. An account's
// name is the one thing assembled, from what its provider reported or the name the person gave.

import type {
  BillingMode,
  ProviderAccount,
  ProviderAuthMode,
  ProviderReadinessState,
  ProviderRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { codeWords } from "./code-words.js";
import { PROVIDER_LABELS } from "./provider-labels.js";

/**
 * The name Codex's own app gives each plan id it sends. A Claude Code plan id has no table: its
 * own word is drawn capitalized.
 */
const CODEX_PLAN_WORDS: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  prolite: "Pro",
  pro: "Pro (More)",
  promax: "Pro (Max)",
  team: "Business",
  self_serve_business_usage_based: "Business",
  self_serve_business_prolite: "Business Premium",
  business: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

/** The plan id a provider sends when it cannot say which plan the account is on. */
const UNKNOWN_PLAN = "unknown";

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
 * The kind of credential a token or API-key account holds, drawn beside the name the person gave
 * it, since the provider reports no identity for it. Every other sign-in mode draws no kind: the
 * account reads the identity the provider reports instead.
 */
const CREDENTIAL_KIND_WORDS: Readonly<
  Record<ProviderAuthMode, ((provider: ProviderName) => string) | null>
> = {
  oauth_token: (provider) => `${PROVIDER_LABELS[provider]} token`,
  api_key: (provider) => `${PROVIDER_LABELS[provider]} API key`,
  oauth_subscription: null,
  external: null,
  none: null,
  unknown: null,
};

/** A provider account as a surface lists it, with the label every surface names it by. */
export type ListedProviderAccount = ProviderAccount & { readonly label: string };

/**
 * `account` as every surface lists it, or `undefined` for an account still signing in that its
 * provider has not reported yet: such an account has no name, so it has no row until its sign-in
 * ends. The label is never the account's id. A token or API-key account reads the name the person
 * gave it beside the credential's kind (`Work · Codex API key`); every other account reads the
 * identity its provider reported: the email, the plan in the provider's own word, then the
 * organization (`sam@example.org · Team · Example Inc`).
 */
export function listedAccount(account: ProviderAccount): ListedProviderAccount | undefined {
  const label = labelOf(account);
  return label === undefined ? undefined : { ...account, label };
}

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

function planWord(provider: ProviderName, plan: string | undefined): string | undefined {
  if (plan === undefined || plan === UNKNOWN_PLAN) {
    return undefined;
  }
  return codeWords(plan, provider === "codex" ? CODEX_PLAN_WORDS : {});
}

function labelOf(account: ProviderAccount): string | undefined {
  if (account.displayLabel !== undefined) {
    const credentialKind =
      account.observedAuthMode === null ? null : CREDENTIAL_KIND_WORDS[account.observedAuthMode];
    return credentialKind === null
      ? account.displayLabel
      : `${account.displayLabel} · ${credentialKind(account.provider)}`;
  }
  const identity = [
    account.observedAccountEmail,
    planWord(account.provider, account.observedAccountPlan),
    account.observedAccountOrgName,
  ].filter((part) => part !== undefined);
  return identity.length === 0 ? undefined : identity.join(" · ");
}
