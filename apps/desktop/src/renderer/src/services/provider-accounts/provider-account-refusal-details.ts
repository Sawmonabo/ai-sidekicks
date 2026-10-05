// The named members two account-plane refusals carry, parsed at the wire boundary against each
// method's details schema: the remedy a refused default move names, and why the keychain would
// not seal a pasted token. A refusal whose members do not parse carries neither, and still renders
// its code and sentence.

import type { ProviderLoginExpiredRemedy } from "@ai-sidekicks/contracts/provider-account";
import {
  PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE,
  ProviderAccountNotAuthenticatedDetailsSchema,
} from "@ai-sidekicks/contracts/provider-account-methods";
import {
  PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE,
  ProviderAccountCredentialSealRefusedDetailsSchema,
  type KeychainRefusalCause,
} from "@ai-sidekicks/contracts/provider-account-sign-in";

import type { WireRefusal } from "@renderer/lib/wire-rejection.js";

/** The remedy a refused `providerAccount.setCurrent` names for its account, where it names one. */
export function readCarriedLoginRemedy(
  refusal: WireRefusal,
): ProviderLoginExpiredRemedy | undefined {
  if (refusal.code !== PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE) {
    return undefined;
  }
  const details = ProviderAccountNotAuthenticatedDetailsSchema.safeParse({
    remedy: refusal.remedy,
  });
  return details.success ? details.data.remedy : undefined;
}

/** Why the keychain refused to seal a pasted token, where the refusal says so. */
export function readKeychainRefusalCause(refusal: WireRefusal): KeychainRefusalCause | undefined {
  if (refusal.code !== PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE) {
    return undefined;
  }
  const details = ProviderAccountCredentialSealRefusedDetailsSchema.safeParse({
    cause: refusal.cause,
  });
  return details.success ? details.data.cause : undefined;
}
