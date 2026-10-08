// What every surface names a provider account by, and what a step's spent account carries: the
// identity its provider reported, or for a pasted token or API key the name the person gave it
// beside the credential's kind. Never the account's id.
import { PROVIDER_LABELS, type ProviderName } from "../name.js";
import {
  PROVIDER_ACCOUNT_EMAIL_MAX_LEN,
  PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN,
  PROVIDER_ACCOUNT_PLAN_MAX_LEN,
  type ProviderAccount,
  type ProviderAuthMode,
} from "./record.js";

/**
 * Longest label an account is named by: the provider-reported email, plan and organization with
 * the two ` · ` separators between them, which outruns a typed name beside its credential's kind.
 */
export const PROVIDER_ACCOUNT_LABEL_MAX_LEN: number =
  PROVIDER_ACCOUNT_EMAIL_MAX_LEN +
  PROVIDER_ACCOUNT_PLAN_MAX_LEN +
  PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN +
  2 * " · ".length;

/** The name Codex's own app gives each plan id it sends. */
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

/** Each provider's own words for the plan ids it sends; Claude Code's plans read as their ids. */
const PLAN_WORDS: Readonly<Record<ProviderName, Readonly<Record<string, string>>>> = {
  claude: {},
  codex: CODEX_PLAN_WORDS,
};

/** The plan id a provider sends when it cannot say which plan the account is on. */
const UNKNOWN_PLAN = "unknown";

/**
 * The kind of credential a token or API-key account holds, drawn beside the name the person gave
 * it. Every other sign-in mode draws no kind: the account reads the identity its provider reports.
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

/** The members of a provider account its label is drawn from. */
export type AccountLabelFields = Pick<
  ProviderAccount,
  | "provider"
  | "displayLabel"
  | "observedAuthMode"
  | "observedAccountEmail"
  | "observedAccountPlan"
  | "observedAccountOrgName"
>;

/**
 * The label every surface names `account` by, or `undefined` for an account still signing in that
 * its provider has not named yet. A token or API-key account reads its typed name beside the
 * credential's kind (`Work · Codex API key`); every other account reads the email, the plan in
 * its provider's own word, then the organization (`sam@example.org · Business · Example Inc`).
 */
export function accountLabel(account: AccountLabelFields): string | undefined {
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

// A plan id the table does not name reads as its own words in sentence case, `edu_max` as
// `Edu max`, so a plan a provider adds is still drawn.
function planWord(provider: ProviderName, plan: string | undefined): string | undefined {
  if (plan === undefined || plan === UNKNOWN_PLAN) {
    return undefined;
  }
  const named = PLAN_WORDS[provider][plan];
  if (named !== undefined) {
    return named;
  }
  const words = plan.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
