// The named members two account-plane refusals carry, read as the refusing method's own types: the
// remedy a refused default move names, and why the keychain would not seal a pasted token. A
// refusal of another code carries neither, and still renders its code and sentence.

import type { ProviderSignInExpiredRemedy } from "@ai-sidekicks/contracts/provider/account/record";
import { PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE } from "@ai-sidekicks/contracts/provider/account/methods";
import type { KeychainRefusalCause } from "@ai-sidekicks/contracts/keychain";
import { PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE } from "@ai-sidekicks/contracts/provider/account/sign-in";

import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";

/**
 * The remedy a refused `provider.account.current.update` names for its account, where it names
 * one.
 */
export function readCarriedLoginRemedy(
  refusal: ExtendedRefusal,
): ProviderSignInExpiredRemedy | undefined {
  return refusal.code === PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE
    ? (refusal.remedy as ProviderSignInExpiredRemedy | undefined)
    : undefined;
}

/** Why the keychain refused to seal a pasted token, where the refusal says so. */
export function readKeychainRefusalCause(
  refusal: ExtendedRefusal,
): KeychainRefusalCause | undefined {
  return refusal.code === PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE
    ? (refusal.cause as KeychainRefusalCause | undefined)
    : undefined;
}
