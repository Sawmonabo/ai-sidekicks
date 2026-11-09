// What every surface names a provider account by, and what a step's spent account carries: the
// identity its provider reported, or for a pasted token or API key the name the person gave it
// beside the credential's kind. Never the account's id.
import type { ProviderAccount, ProviderAuthMode } from "../../generated/provider/account/record.js";
import type { ProviderPlanWord } from "../../generated/provider/settings.js";

/** The plan id a provider sends when it cannot say which plan the account is on. */
const UNKNOWN_PLAN = "unknown";

/** The members of a provider account its label is drawn from. */
export type AccountLabelFields = Pick<
  ProviderAccount,
  | "displayLabel"
  | "observedAuthMode"
  | "observedAccountEmail"
  | "observedAccountPlan"
  | "observedAccountOrgName"
>;

/**
 * The kind of credential a token or API-key account holds, drawn beside its typed name after the
 * provider's name; every other sign-in mode draws none.
 */
function credentialKind(providerName: string, mode: ProviderAuthMode): string | undefined {
  switch (mode) {
    case "oauthToken":
      return `${providerName} token`;
    case "apiKey":
      return `${providerName} API key`;
    case "oauthSubscription":
    case "external":
    case "none":
    case "unknown":
      return undefined;
  }
}

/**
 * The plan in its provider's own word from `planWords`; a plan the list names no word for reads as
 * its own words in sentence case (`edu_max` as `Edu max`), so a plan a provider adds is still
 * drawn.
 */
function planWord(planWords: readonly ProviderPlanWord[], plan: string): string | undefined {
  if (plan === UNKNOWN_PLAN) {
    return undefined;
  }
  const named = planWords.find((candidate) => candidate.plan === plan);
  if (named !== undefined) {
    return named.word;
  }
  const words = plan.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The label every surface names an account by, drawn from its `fields`, its provider's name as a
 * person reads it and its provider's `planWords`, both from the provider read; `undefined` for an
 * account still signing in that its provider has not named yet. A token or API-key account reads
 * its typed name beside the credential's kind (`Work · Codex API key`); every other account reads
 * the email, the plan in its provider's own word, then the organization
 * (`sam@example.org · Business · Example Inc`).
 */
export function accountLabel(
  fields: AccountLabelFields,
  providerName: string,
  planWords: readonly ProviderPlanWord[],
): string | undefined {
  if (fields.displayLabel !== undefined) {
    const kind =
      fields.observedAuthMode === null
        ? undefined
        : credentialKind(providerName, fields.observedAuthMode);
    return kind === undefined ? fields.displayLabel : `${fields.displayLabel} · ${kind}`;
  }
  const plan =
    fields.observedAccountPlan === undefined
      ? undefined
      : planWord(planWords, fields.observedAccountPlan);
  const identity = [fields.observedAccountEmail, plan, fields.observedAccountOrgName].filter(
    (part) => part !== undefined,
  );
  return identity.length === 0 ? undefined : identity.join(" · ");
}
