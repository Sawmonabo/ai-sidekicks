// Which app screen closes an account-plane refusal, and which action it offers.
//
// A refusal can arrive anywhere (a run refused at admission, a registry read refused on a
// settings page, a quota reading that never landed). This router decides where and which of
// three actions, and composes no remedy: the remedy's content is the daemon's, travels on
// `providerAccount.list`'s readiness entry, and is display-only here. The action is a navigation
// to the settings section where the act lives; nothing runs a sign-in or re-derives admission.
//
// The table maps into the contract's `ProviderRemedy` union, so a new upstream arm is a compile
// error here. A code with no remedy is a real answer: five of the twelve are refusals no app act
// closes (a session asking for an account verb, a lost set-default race that retries, a
// wrong-class token, a token this machine's keychain refused to seal, a provider binary below
// the floor), so the table's value type admits `null`.

import type { ProviderRemedy } from "@ai-sidekicks/contracts";

import type { SettingsPageId } from "@renderer/routing/settings-page-ids.js";

/**
 * Every refusal code the account plane raises.
 *
 * Declared here because the contracts package declares no union of them; the codes appear there
 * only in tests. This tuple is the one place they are written.
 */
export const ACCOUNT_PLANE_REFUSAL_CODES = [
  "provideraccount.not_registered",
  "provideraccount.no_default",
  "provideraccount.unknown",
  "provideraccount.credential_home_unavailable",
  "provideraccount.not_authenticated",
  "provideraccount.permission_denied",
  "provideraccount.default_conflict",
  "provideraccount.signin_unsupported",
  "provideraccount.signin_in_flight",
  "provideraccount.token_class_refused",
  "provideraccount.credential_seal_refused",
  "provideraccount.provider_version_below_floor",
] as const;

/** One registered account-plane refusal. Derived from the tuple, never restated. */
export type AccountPlaneRefusalCode = (typeof ACCOUNT_PLANE_REFUSAL_CODES)[number];

/** Where the act that closes a refusal lives, and which of the three acts it is. */
export interface AccountPlaneHandoff {
  readonly section: SettingsPageId;
  readonly remedyKind: ProviderRemedy["kind"];
}

/**
 * The router, total over the registered codes.
 *
 * A record rather than a switch, so a new code cannot land in the tuple without someone
 * deciding whether it routes anywhere.
 */
const ACCOUNT_PLANE_HANDOFFS: Readonly<
  Record<AccountPlaneRefusalCode, AccountPlaneHandoff | null>
> = {
  // Nothing is registered for the provider, so the act is registration.
  "provideraccount.not_registered": { section: "providers", remedyKind: "register" },
  // Accounts exist and none is the provider's default; the daemon lists candidates and elects
  // none.
  "provideraccount.no_default": { section: "providers", remedyKind: "choose_default" },
  // The referenced account is not in the registry, so the act is choosing among the accounts
  // that are.
  "provideraccount.unknown": { section: "providers", remedyKind: "choose_default" },
  // An account resolved and its home is unusable; `sign_in` is the arm the readiness projection
  // puts on `home_missing` and the one that names a home.
  "provideraccount.credential_home_unavailable": { section: "providers", remedyKind: "sign_in" },
  // Pre-spawn validation did not report authenticated, including `indeterminate`.
  "provideraccount.not_authenticated": { section: "providers", remedyKind: "sign_in" },
  // A brokered sign-in is already running; the act is on the flow on the same page.
  "provideraccount.signin_in_flight": { section: "providers", remedyKind: "sign_in" },
  // Brokered sign-in is unavailable for this provider; the remedy is the out-of-band sign-in the
  // readiness handoff discloses, display-only on the page that shows it.
  "provideraccount.signin_unsupported": { section: "providers", remedyKind: "sign_in" },
  // No app act closes these five: only this machine's client or a linked device may call an
  // account verb, never a session; a lost set-default race is retried; a wrong-class token is
  // answered only by submitting another; a token the keychain refused to seal needs the
  // keychain fixed; and a provider binary below the floor needs upgrading outside this application.
  // Routing any to a page would offer an act that changes nothing.
  "provideraccount.permission_denied": null,
  "provideraccount.default_conflict": null,
  "provideraccount.token_class_refused": null,
  "provideraccount.credential_seal_refused": null,
  "provideraccount.provider_version_below_floor": null,
};

/** True when a wire string names a refusal this router knows. */
export function isAccountPlaneRefusalCode(code: string): code is AccountPlaneRefusalCode {
  return (ACCOUNT_PLANE_REFUSAL_CODES as readonly string[]).includes(code);
}

/**
 * Where a refusal is answered, or `undefined` when no console act answers it.
 *
 * Takes a bare `string` because a refusal carries a wire value, and a narrowed parameter would
 * push the same `includes` test to every call site.
 */
export function accountPlaneHandoffFor(code: string): AccountPlaneHandoff | undefined {
  return isAccountPlaneRefusalCode(code) ? (ACCOUNT_PLANE_HANDOFFS[code] ?? undefined) : undefined;
}
