import {
  PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE,
  type KeychainRefusalCause,
} from "@ai-sidekicks/contracts/provider/account/sign-in";
import type { ReactNode } from "react";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { readKeychainRefusalCause } from "#renderer/services/provider-accounts/refusal-details.js";
import type { TokenRegistrationOutcome } from "../provider-sign-in-flow.js";

/** What each keychain refusal reads as, in the slot a refused token's line takes. */
const KEYCHAIN_REFUSAL_LINES: Readonly<Record<KeychainRefusalCause, string>> = {
  locked:
    "This machine's keychain is locked, so the token was not stored. Unlock it, then paste the " +
    "token again.",
  unavailable:
    "This machine has no keychain the app can store a token in, so the token was not stored. " +
    "Use Sign in instead.",
};

/**
 * What a pasted token came to, in the slot under the field it was pasted into: stored, refused
 * by the keychain with one line per cause, not accepted by the provider, or refused for another
 * reason in the service's or the form's own words.
 */
export function RegistrationOutcomeLine(props: {
  readonly outcome: TokenRegistrationOutcome;
}): ReactNode {
  const { outcome } = props;
  // While the call is out, `Register` is disabled and the slot stays empty.
  if (outcome.kind === "idle" || outcome.kind === "submitting") {
    return null;
  }
  if (outcome.kind === "refused") {
    const keychainCause = readKeychainRefusalCause(outcome.refusal);
    return (
      <p
        className="meridian-settings-page__state meridian-settings-page__state--failed"
        role="alert"
      >
        {keychainCause !== undefined ? (
          KEYCHAIN_REFUSAL_LINES[keychainCause]
        ) : outcome.refusal.code === PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE ? (
          "The provider did not accept that token."
        ) : (
          <InlineRefusal {...outcome.refusal} />
        )}
      </p>
    );
  }
  return (
    <p className="meridian-settings-page__state" role="status">
      The token was stored in this machine&rsquo;s keychain. It is never shown here again.
    </p>
  );
}
