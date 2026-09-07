// Which console surface closes an account-plane refusal, and which action it offers.
//
// An account-plane refusal can arrive anywhere — a run refused at admission, a
// registry read refused on a settings page, a quota reading that never landed — and
// until this module the console rendered the daemon's sentence and stopped there,
// with the page that could actually fix it one rail press away and unnamed.
//
// WHAT THIS ROUTER DECIDES, AND WHAT IT REFUSES TO
//
// It decides WHERE, and it decides WHICH OF THREE ACTIONS. It does not compose a
// remedy: the remedy's content — the credential home a sign-in authenticates into,
// the provider's own first-party invocation, the candidate accounts a default is
// chosen from — is the daemon's, travels on `providerAccount.list`'s readiness
// entry, and is display-only when it gets here. `ProviderAccountsPage.tsx` states
// that rule in terms, and this module is inside it rather than an exception to it:
// a refusal code is a fact about which act is missing, and naming the act is not
// naming how to perform it.
//
// AND IT NEVER PERFORMS ONE. The action this router names is a navigation — open
// the settings section where the act lives. No sign-in command is run, no path is
// rendered, and nothing here re-derives whether a run would now be admitted.
//
// THE KIND VOCABULARY IS THE CONTRACT'S, NOT THIS CONSOLE'S. `ProviderRemedy` is a
// registered three-arm union and a client "renders off `kind`" in its own words, so
// this table maps into that union rather than beside it — a fourth remedy arm added
// upstream is a compile error in this file rather than a code that quietly routes
// nowhere.
//
// A CODE WITH NO REMEDY IS A REAL ANSWER. Five of the twelve are refusals no console
// act closes: a caller without operator authority, a lost set-default race that
// simply retries, a token of the wrong class, a host whose custody ladder refused,
// and a provider binary below the floor. Each renders the refusal alone, which is
// the honest outcome and is why the table's value type admits `null` rather than
// reaching for the nearest plausible section.

import type { ProviderRemedy } from "@ai-sidekicks/contracts";

import type { SettingsSectionId } from "../../settings-sections.js";

/**
 * Every refusal code the account plane raises.
 *
 * Declared here because the corpus declares no union of them: they are registered in
 * the error-contract table and appear in the contract package only as test data, so
 * this tuple is the console's own declaration and the one place it is written. The
 * count is a property of the tuple rather than a number in a comment.
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
  readonly section: SettingsSectionId;
  readonly remedyKind: ProviderRemedy["kind"];
}

/**
 * The router, TOTAL over the registered codes.
 *
 * A record rather than a switch, so a thirteenth code cannot land in the tuple above
 * without somebody deciding whether it routes anywhere — the hole a `switch` with a
 * `default` would have swallowed.
 */
export const ACCOUNT_PLANE_HANDOFFS: Readonly<
  Record<AccountPlaneRefusalCode, AccountPlaneHandoff | null>
> = {
  // Nothing is registered for the provider, so the act is registration.
  "provideraccount.not_registered": { section: "accounts", remedyKind: "register" },
  // Accounts exist and none is the provider's default; the daemon lists candidates
  // and elects none, which is exactly the `choose_default` arm.
  "provideraccount.no_default": { section: "accounts", remedyKind: "choose_default" },
  // The referenced account is not in the registry — removed, or never there. The act
  // is choosing among the accounts that ARE, which is the same candidate list.
  "provideraccount.unknown": { section: "accounts", remedyKind: "choose_default" },
  // An account resolved and its home is unusable. `sign_in` is the arm the readiness
  // projection puts on `home_missing`, and it is the arm that names a home at all.
  "provideraccount.credential_home_unavailable": { section: "accounts", remedyKind: "sign_in" },
  // Pre-spawn validation did not report authenticated, including `indeterminate`.
  "provideraccount.not_authenticated": { section: "accounts", remedyKind: "sign_in" },
  // A brokered sign-in is already running; the act is on the flow, which lives on the
  // same page, and the daemon's own sentence names cancelling it.
  "provideraccount.signin_in_flight": { section: "accounts", remedyKind: "sign_in" },
  // Brokered sign-in is not available for this provider, and the remedy the daemon's
  // own sentence names is the out-of-band sign-in the readiness handoff discloses —
  // which is the `sign_in` arm, display-only, on the page that shows it.
  "provideraccount.signin_unsupported": { section: "accounts", remedyKind: "sign_in" },
  // No console act closes these five.
  //
  // Authority is the caller's and cannot be granted from this window; a lost
  // set-default race is retried rather than remedied; a host whose custody ladder
  // refused needs the host fixed; and a provider binary below the floor needs
  // upgrading outside this application. Routing any of them to a page would offer an
  // act that changes nothing — the failure mode this `null` exists to refuse.
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
 * Takes a bare `string` because that is what a refusal carries: the code is a wire
 * value and every caller has one, so a signature demanding the narrowed type would
 * push the same `includes` test out to every call site.
 */
export function accountPlaneHandoffFor(code: string): AccountPlaneHandoff | undefined {
  return isAccountPlaneRefusalCode(code) ? (ACCOUNT_PLANE_HANDOFFS[code] ?? undefined) : undefined;
}
