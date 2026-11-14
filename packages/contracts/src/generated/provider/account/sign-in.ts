// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The sign-in side of `provider.account.*`: registering an account, rebuilding an account's credential home, and the brokered interactive sign-in with its code and its cancel.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { KeychainRefusalCause } from "../../keychain.js";
import type { ProviderId } from "../id.js";
import type {
  BillingMode,
  CredentialGeneration,
  ProviderAccount,
  ProviderAccountHealthState,
  ProviderAccountId,
} from "./record.js";

/** The longest provider verification address, carried verbatim. */
export const PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN = 2048 as const;

/** The longest device code the person types at the verification address. */
export const PROVIDER_SIGN_IN_USER_CODE_MAX_LEN = 64 as const;

/** The longest code a sign-in page shows for the person to paste back. */
export const PROVIDER_SIGN_IN_CODE_MAX_LEN = 1024 as const;

/**
 * The longest pasted token: generous, since the vendor mints it, and bounded so no unbounded
 * body rides in through the one member whose value is never logged.
 */
export const PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN = 8192 as const;

/** A pasted token could not be sealed in this machine's keychain, so nothing was stored. */
export const PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE =
  "provider.account.credentialSealRefused" as const;

/**
 * The provider's status output, run on a pasted token, reported no signed-in mode, so
 * nothing is registered, sealed or replaced.
 */
export const PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE =
  "provider.account.tokenNotAccepted" as const;

/**
 * The name given to a token or API-key account repeats another of that provider's account
 * names; a rename refuses on the same code.
 */
export const PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE =
  "provider.account.displayLabelTaken" as const;

/** Every way a cancel ends, in declaration order. */
export const PROVIDER_SIGN_IN_CANCEL_STATUSES = ["canceled", "notFound"] as const;

/** Every way a code submit ends, in declaration order. */
export const PROVIDER_SIGN_IN_CODE_SUBMIT_STATUSES = ["submitted", "notFound"] as const;

/**
 * Wire members a request-logging transport redacts before writing a record, listed once so
 * no transport derives the list again: the pasted token and the sign-in page's code.
 */
export const PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS = ["nonInteractiveToken", "code"] as const;

/**
 * Registers an account, or re-supplies the token of an existing one. Its name follows the
 * token: a pasted token's new account must be named, a signed-in one is named by its provider,
 * and an `accountId` with nothing to supply is refused.
 */
export type ProviderAccountRegisterRequest =
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * Only an account added from a pasted token carries a name.
       */
      displayLabel?: never;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * Makes it the provider's default.
       */
      makeDefault?: boolean;
      /**
       * A re-supply carries a token.
       */
      accountId?: never;
      /**
       * A sign-in registration carries no token.
       */
      nonInteractiveToken?: never;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The name the person gives the account.
       */
      displayLabel: string;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * Makes it the provider's default.
       */
      makeDefault?: boolean;
      /**
       * A new registration names no account; the daemon mints its id.
       */
      accountId?: never;
      /**
       * The pasted token or API key.
       */
      nonInteractiveToken: string;
    }
  | {
      /**
       * The provider, which must match the stored account's.
       */
      provider: ProviderId;
      /**
       * A new name for the account.
       */
      displayLabel?: string;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * Makes it the provider's default.
       */
      makeDefault?: boolean;
      /**
       * The account whose sealed token is replaced; a selector, not an identity assertion.
       */
      accountId: ProviderAccountId;
      /**
       * The fresh token or API key.
       */
      nonInteractiveToken: string;
    };
/**
 * Which of a provider's sign-in flows runs: the one that calls back to a browser on this machine,
 * or the device-code flow a browser on any device finishes.
 */
export type ProviderSignInArm = "browser" | "deviceCode";
/**
 * Starts the provider's own interactive sign-in, for a registered account or a new one.
 */
export type ProviderAccountSignInRequest =
  | {
      /**
       * The account.
       */
      accountId: ProviderAccountId;
      /**
       * The arm to run. Absent, it is the browser arm at this machine and device code from another
       * device, where `browser` is refused.
       */
      arm?: ProviderSignInArm;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The arm to run. Absent, it is the browser arm at this machine and device code from another
       * device, where `browser` is refused.
       */
      arm?: ProviderSignInArm;
    };
/**
 * How a cancel ended. `notFound` covers an attempt that already ended or never existed; it is
 * no error, so a client racing a completion sees no refusal for losing.
 */
export type ProviderSignInCancelStatus = "canceled" | "notFound";
/**
 * How a code submit ended. `notFound` covers an attempt that is not waiting for a code; it is
 * no error, as a cancel's is not.
 */
export type ProviderSignInCodeSubmitStatus = "submitted" | "notFound";

/**
 * The registered, or token-replaced, account.
 */
export interface ProviderAccountRegisterResponse {
  /**
   * The account.
   */
  account: ProviderAccount;
}
/**
 * The details of a seal refusal.
 */
export interface ProviderAccountCredentialSealRefusedDetails {
  /**
   * Why the keychain could not be used.
   */
  cause: KeychainRefusalCause;
}
/**
 * Rebuilds an account's credential home from empty so the person can sign in again. It raises
 * the credential generation; the identity and stored quota readings survive, and the stored
 * health is dropped, so the reply carries the new one.
 */
export interface ProviderAccountCredentialHomeResetRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * The account's new credential generation and health after the rebuild.
 */
export interface ProviderAccountCredentialHomeResetResponse {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * The generation after the rebuild, greater than the one before.
   */
  credentialGeneration: CredentialGeneration;
  /**
   * `reauthRequired` until the person signs in.
   */
  healthState: ProviderAccountHealthState;
}
/**
 * What the person needs to finish the sign-in, and the key to cancel it.
 */
export interface ProviderAccountSignInResponse {
  /**
   * Opaque, daemon-minted and single-use: the key for cancel and for completion.
   */
  attemptId: string;
  /**
   * Where the person finishes the flow: the provider's own `https:` address, verbatim, since
   * the person opens it.
   */
  verificationUri: string;
  /**
   * The device code the person types at the address, on a device-code flow.
   */
  userCode?: string;
  /**
   * Where the provider bounds the attempt; absent when it published no bound or the value
   * failed the daemon's check.
   */
  expiresAt?: WireInstant;
  /**
   * Whether the provider opened the address in a browser itself: the client then opens
   * nothing, and still draws `Open the sign-in page` with the address.
   */
  isBrowserOpenedByProvider: boolean;
}
/**
 * The sign-in a `provider.account.signInInFlight` refusal names: the open attempt and the account
 * it signs in.
 */
export interface ProviderAccountSignInInFlightDetails {
  /**
   * The account the open attempt signs in.
   */
  accountId: ProviderAccountId;
  /**
   * The open attempt, which `provider.account.signInAttempt.cancel` cancels.
   */
  attemptId: string;
}
/**
 * Cancels one sign-in attempt by the id its `provider.account.signIn` reply returned.
 */
export interface ProviderAccountSignInAttemptCancelRequest {
  /**
   * The attempt.
   */
  attemptId: string;
}
/**
 * How the cancel ended.
 */
export interface ProviderAccountSignInAttemptCancelResponse {
  /**
   * The outcome.
   */
  status: ProviderSignInCancelStatus;
}
/**
 * Sends the code a Claude Code sign-in page shows to the sign-in waiting for it, after
 * `signInCodeRequested`. The code goes to that sign-in's input and nowhere else; `Debug` prints
 * only a marker in its place.
 */
export interface ProviderAccountSignInCodeSubmitRequest {
  /**
   * The attempt.
   */
  attemptId: string;
  /**
   * The code, as the person pasted it.
   */
  code: string;
}
/**
 * How the code submit ended.
 */
export interface ProviderAccountSignInCodeSubmitResponse {
  /**
   * The outcome.
   */
  status: ProviderSignInCodeSubmitStatus;
}

export { validateProviderAccountSignInResponse } from "../../checks/provider/account/sign-in.js";
