// Which app screen closes an account-plane refusal, and which action it offers.
//
// A refusal can arrive anywhere (a run refused at admission, a registry read refused on a
// settings page, a quota reading that never landed). This router decides where and which
// action, and composes no remedy: the remedy's content is the daemon's, travels on
// `providerAccount.list`'s readiness entry or, for a refused account move, on the refusal itself,
// and is display-only here. The action is a navigation to the settings section where the act
// lives; nothing runs a sign-in or re-derives admission.
//
// The table maps into the contract's `ProviderRemedy` union, so a new upstream arm is a compile
// error here. A code with no remedy is a real answer: seven of the thirteen are refusals no
// Providers act closes (a pinned account the registry no longer carries, a session asking for an
// account verb, a lost set-default race that retries, a token this machine's keychain refused to
// seal, a token the provider did not accept, a name another account of the provider has, an
// account a live run holds), so the table's value type admits `null`.

import {
  PROVIDER_ACCOUNT_IN_USE_CODE,
  PROVIDER_ACCOUNT_NO_DEFAULT_CODE,
  PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE,
  PROVIDER_ACCOUNT_NOT_REGISTERED_CODE,
} from "@ai-sidekicks/contracts/provider/account/methods";
import type {
  ProviderLoginExpiredRemedy,
  ProviderRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";
import {
  PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE,
  PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE,
  PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE,
} from "@ai-sidekicks/contracts/provider/account/sign-in";

import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/**
 * Every refusal code the account plane raises. The codes the contracts export are named through
 * their constants; the router below is keyed by every one, so it is total.
 */
export type AccountPlaneRefusalCode =
  | typeof PROVIDER_ACCOUNT_NOT_REGISTERED_CODE
  | typeof PROVIDER_ACCOUNT_NO_DEFAULT_CODE
  | "provideraccount.unknown"
  | "provideraccount.credential_home_unavailable"
  | typeof PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE
  | "provideraccount.permission_denied"
  | "provideraccount.default_conflict"
  | "provideraccount.signin_unsupported"
  | "provideraccount.signin_in_flight"
  | typeof PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE
  | typeof PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE
  | typeof PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE
  | typeof PROVIDER_ACCOUNT_IN_USE_CODE;

/** Where the act that closes a refusal lives, and which act it is. */
export interface AccountPlaneHandoff {
  readonly section: SettingsPageId;
  readonly remedyKind: ProviderRemedy["kind"];
}

/** A route whose act is the one the refusal's own data names, since only that account knows it. */
const CARRIED_BY_REFUSAL = "carried_by_refusal";

/** One row of the router: a fixed act, or the act the refusal carries. */
interface AccountPlaneHandoffRoute {
  readonly section: SettingsPageId;
  readonly remedyKind: ProviderRemedy["kind"] | typeof CARRIED_BY_REFUSAL;
}

/**
 * The router, total over the registered codes.
 *
 * A record rather than a switch, so a new code cannot land in the union without someone
 * deciding whether it routes anywhere.
 */
const ACCOUNT_PLANE_HANDOFFS: Readonly<
  Record<AccountPlaneRefusalCode, AccountPlaneHandoffRoute | null>
> = {
  // Nothing is registered for the provider, so the act is registration.
  [PROVIDER_ACCOUNT_NOT_REGISTERED_CODE]: { section: "providers", remedyKind: "register" },
  // Accounts exist and none is the provider's default; the daemon lists candidates and elects
  // none.
  [PROVIDER_ACCOUNT_NO_DEFAULT_CODE]: { section: "providers", remedyKind: "choose_default" },
  // An account resolved and its home is unusable; `sign_in` is the arm the readiness projection
  // puts on `home_missing` and the one that names a home.
  "provideraccount.credential_home_unavailable": { section: "providers", remedyKind: "sign_in" },
  // A current-account move named an account whose login is gone; an undecided read never
  // raises it. The refusal carries that account's own remedy: the provider's sign-in, or a fresh
  // token on a token or API-key account.
  [PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE]: {
    section: "providers",
    remedyKind: CARRIED_BY_REFUSAL,
  },
  // A brokered sign-in is already running; the act is on the flow on the same page.
  "provideraccount.signin_in_flight": { section: "providers", remedyKind: "sign_in" },
  // Brokered sign-in is unavailable for this provider; the remedy is the out-of-band sign-in the
  // readiness handoff discloses, display-only on the page that shows it.
  "provideraccount.signin_unsupported": { section: "providers", remedyKind: "sign_in" },
  // No Providers act closes these seven: an account reference the registry no longer carries is
  // answered where it was pinned, and no default stands in for it; only this machine's client or
  // a linked device may call an account verb, never a session; a lost set-default race is
  // retried; a token the keychain refused to seal needs the keychain fixed; a token the provider
  // did not accept is answered under the field it was pasted into, with another token; a name
  // another account of the provider has is answered under the `Name` field, with another name;
  // and `Remove` on an account a live run holds is refused on its own row, naming the sessions to
  // move first, while `Sign out` stays open because it forgets nothing.
  // Routing any to a page would offer an act that changes nothing.
  "provideraccount.unknown": null,
  "provideraccount.permission_denied": null,
  "provideraccount.default_conflict": null,
  [PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE]: null,
  [PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE]: null,
  [PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE]: null,
  [PROVIDER_ACCOUNT_IN_USE_CODE]: null,
};

/** True when a wire string names a refusal this router knows. */
export function isAccountPlaneRefusalCode(code: string): code is AccountPlaneRefusalCode {
  return Object.hasOwn(ACCOUNT_PLANE_HANDOFFS, code);
}

/**
 * Where a refusal is answered, or `undefined` when no console act answers it.
 *
 * Takes a bare `string` because a refusal carries a wire value, and a narrowed parameter would
 * push the same membership test to every call site. `carriedRemedy` is the remedy the refusal's
 * own data named; a code routed by it answers `undefined` without one.
 */
export function accountPlaneHandoffFor(
  code: string,
  carriedRemedy?: ProviderLoginExpiredRemedy,
): AccountPlaneHandoff | undefined {
  const route = isAccountPlaneRefusalCode(code) ? ACCOUNT_PLANE_HANDOFFS[code] : null;
  if (route === null) {
    return undefined;
  }
  if (route.remedyKind !== CARRIED_BY_REFUSAL) {
    return { section: route.section, remedyKind: route.remedyKind };
  }
  return carriedRemedy === undefined
    ? undefined
    : { section: route.section, remedyKind: carriedRemedy.kind };
}
