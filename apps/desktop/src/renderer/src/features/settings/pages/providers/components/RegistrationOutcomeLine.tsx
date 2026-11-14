import type { KeychainRefusalCause } from "@ai-sidekicks/contracts/keychain";
import { PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE } from "@ai-sidekicks/contracts/provider/account/sign-in";
import type { ReactNode } from "react";

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { readKeychainRefusalCause } from "#renderer/services/provider-accounts/refusal-details.js";
import { TOKEN_KEPT_WORDS, TOKEN_SAVED_WORDS, type SecretsPlace } from "../secrets-place.js";
import type { TokenRegistrationOutcome } from "../sign-in/flow.js";

/** The title over every keychain refusal's line. */
const KEYCHAIN_REFUSAL_TITLE = "Token not saved";

/** What each keychain refusal reads as under its title, the same on every system. */
const KEYCHAIN_REFUSAL_LINES: Readonly<Record<KeychainRefusalCause, string>> = {
  locked: "Unlock the keychain, then try again.",
  unavailable: "Secrets cannot be used right now. See Settings › Runtime.",
};

/** What a token the provider refused reads as. */
const TOKEN_NOT_ACCEPTED_LINE = "The provider did not accept that token.";

/**
 * What a pasted token came to, in the slot under the field it was pasted into: saved, in the
 * words for where the service keeps it, refused by the keychain under one title with one line per
 * cause, not accepted by the provider, or refused for another reason in the service's or the
 * form's own words.
 */
export function RegistrationOutcomeLine(props: {
  readonly outcome: TokenRegistrationOutcome;
  /** Where the service keeps a saved token, which the saved line names when it is known. */
  readonly secretsPlace: SecretsPlace | undefined;
}): ReactNode {
  const { outcome } = props;
  // While the call is out, `Register` is disabled and the slot stays empty.
  if (outcome.kind === "idle" || outcome.kind === "submitting") {
    return null;
  }
  if (outcome.kind === "refused") {
    const keychainCause = readKeychainRefusalCause(outcome.refusal);
    if (keychainCause !== undefined) {
      const line = KEYCHAIN_REFUSAL_LINES[keychainCause];
      return (
        <AnnouncedLine
          element="div"
          className="meridian-settings-page__state meridian-settings-page__state--failed"
          words={`${KEYCHAIN_REFUSAL_TITLE}. ${line}`}
          politeness="assertive"
        >
          <p>{KEYCHAIN_REFUSAL_TITLE}</p>
          <p className="meridian-settings-page__aside">{line}</p>
        </AnnouncedLine>
      );
    }
    if (outcome.refusal.code === PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE) {
      return (
        <AnnouncedLine
          element="p"
          className="meridian-settings-page__state meridian-settings-page__state--failed"
          words={TOKEN_NOT_ACCEPTED_LINE}
          politeness="assertive"
        />
      );
    }
    // No live role: the refusal announces itself through the app's announcer.
    return (
      <p className="meridian-settings-page__state meridian-settings-page__state--failed">
        <InlineRefusal {...outcome.refusal} />
      </p>
    );
  }
  return (
    <AnnouncedLine
      element="p"
      className="meridian-settings-page__state"
      words={
        props.secretsPlace === undefined
          ? TOKEN_SAVED_WORDS
          : TOKEN_KEPT_WORDS[props.secretsPlace].saved
      }
      politeness="polite"
    />
  );
}
