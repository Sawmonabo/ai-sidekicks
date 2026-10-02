// The sign-in side of `providerAccount.*`: registering an account, which carries the one request
// member that may hold a credential; rebuilding an account's credential home; and the brokered
// interactive sign-in with its cancel. The member a request-logging transport must redact sits
// here beside the input it concerns.
import { z } from "zod";

import {
  BillingModeSchema,
  CredentialGenerationSchema,
  PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
  PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
  ProviderAccountHealthStateSchema,
  ProviderAccountIdSchema,
  ProviderAccountSchema,
  ProviderNameSchema,
  type BillingMode,
  type CredentialGeneration,
  type ProviderAccount,
  type ProviderAccountHealthState,
  type ProviderAccountId,
  type ProviderName,
} from "./provider-account.js";
import { wireFreeFormString } from "./session.js";
import { isoDateTimeSchema } from "./internal/wire-scalars.js";

/** The longest provider verification URL, carried verbatim. */
export const PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN = 2048;
/** The longest device-code the person types at the verification URI. */
export const PROVIDER_LOGIN_USER_CODE_MAX_LEN = 64;
/**
 * The longest non-interactive token. Generous because the token is vendor-minted and its
 * encoding is not this layer's to predict; the bound keeps an unbounded body from being smuggled
 * through the one member whose value is never logged.
 */
export const PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN = 8192;

/** Registers an account, or re-supplies the token of an existing one. */
export interface ProviderAccountRegisterRequest {
  provider: ProviderName;
  displayLabel: string;
  billingMode: BillingMode;
  makeDefault?: boolean | undefined;
  /**
   * Re-supply selector, not an identity assertion. Supplied, it means "replace the sealed token on
   * this account" and `provider` must match the stored row; omitted, this is an ordinary
   * registration and the daemon mints a new identity. Re-supplying exists because the remedy for
   * `reauth_required` is a fresh token, and deregister-then-register would mint a new immutable
   * identity and discard the spend, quota and attention history of the account being repaired.
   *
   * An id that names no registered account is refused, never created. Its presence requires
   * `nonInteractiveToken`, refused at the parse boundary: a re-supply with nothing to supply is
   * neither a registration nor a replacement, and a silent no-op reported as a registration is
   * the cheapest wrong guess. A token with no `accountId` registers a new account.
   */
  accountId?: ProviderAccountId | undefined;
  /**
   * The one credential-accepting input on this wire, write-only. The value is on no
   * provider-account response and is never logged, echoed to a terminal, rendered, placed in an
   * error message or diagnostic dump, or carried in an argument vector (readable by any process of
   * the same user). A transport that logs request bodies must redact this member by name; see
   * `PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS`. It is sealed in the keychain and never written into
   * the credential home, because daemon-owned bytes in provider-owned space are indistinguishable
   * to every later reader.
   */
  nonInteractiveToken?: string | undefined;
}

/**
 * Parses a {@link ProviderAccountRegisterRequest}; `accountId` without `nonInteractiveToken` is
 * refused.
 */
export const ProviderAccountRegisterRequestSchema: z.ZodType<
  ProviderAccountRegisterRequest,
  ProviderAccountRegisterRequest
> = z
  .object({
    provider: ProviderNameSchema,
    displayLabel: wireFreeFormString(
      PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
      "ProviderAccountRegisterRequest.displayLabel",
    ),
    billingMode: BillingModeSchema,
    makeDefault: z.boolean().optional(),
    accountId: ProviderAccountIdSchema.optional(),
    // `wireFreeFormString` refuses NUL bytes, which truncate rather than error in a child
    // process's environment. `.strict()` keeps a caller from adding `credentialGeneration` or any
    // other daemon-owned member alongside it.
    nonInteractiveToken: wireFreeFormString(
      PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN,
      "ProviderAccountRegisterRequest.nonInteractiveToken",
    ).optional(),
  })
  .strict()
  // Only the combination is constrained, so the rule lives here rather than on either member. The
  // issue is reported on `nonInteractiveToken`, the member the caller must add.
  .superRefine((request, context) => {
    if (request.accountId !== undefined && request.nonInteractiveToken === undefined) {
      context.addIssue({
        code: "custom",
        path: ["nonInteractiveToken"],
        message:
          "accountId selects an account whose sealed token is to be replaced, so a request carrying it must also carry nonInteractiveToken; omit accountId to register a new account instead.",
      });
    }
  });

/** The registered, or token-replaced, account. */
export interface ProviderAccountRegisterResponse {
  account: ProviderAccount;
}

/** Parses a {@link ProviderAccountRegisterResponse}. */
export const ProviderAccountRegisterResponseSchema: z.ZodType<ProviderAccountRegisterResponse> = z
  .object({ account: ProviderAccountSchema })
  .strict();

const KEYCHAIN_REFUSAL_CAUSE_VALUES = ["locked", "unavailable"] as const;

/**
 * Why this machine's keychain could not store a secret: it is `locked`, or there
 * is no keychain the app can use (`unavailable`). A secret that cannot be sealed
 * is refused and stored nowhere else. Every refusal to seal a secret in the
 * keychain carries this one pair.
 */
export type KeychainRefusalCause = (typeof KEYCHAIN_REFUSAL_CAUSE_VALUES)[number];
/** Every {@link KeychainRefusalCause}. */
export const KEYCHAIN_REFUSAL_CAUSES: readonly KeychainRefusalCause[] =
  KEYCHAIN_REFUSAL_CAUSE_VALUES;
/** Parses a {@link KeychainRefusalCause}. */
export const KeychainRefusalCauseSchema: z.ZodType<KeychainRefusalCause, KeychainRefusalCause> =
  z.enum(KEYCHAIN_REFUSAL_CAUSE_VALUES);

/** A pasted token could not be sealed in this machine's keychain, so nothing was stored. */
export const PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE =
  "provideraccount.credential_seal_refused" as const;
/** The type of {@link PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE}. */
export type ProviderAccountCredentialSealRefusedCode =
  typeof PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE;

/**
 * The details of a seal refusal. An object type alias, not an interface, because the daemon's
 * domain error takes details as a `Record<string, unknown>`, which an interface is not
 * assignable to.
 */
export type ProviderAccountCredentialSealRefusedDetails = { cause: KeychainRefusalCause };
/** Parses {@link ProviderAccountCredentialSealRefusedDetails}. */
export const ProviderAccountCredentialSealRefusedDetailsSchema: z.ZodType<ProviderAccountCredentialSealRefusedDetails> =
  z.object({ cause: KeychainRefusalCauseSchema }).strict();

/**
 * The name given to a token or API-key account repeats one of that provider's
 * other account names, compared without case or surrounding spaces. `Rename`
 * refuses on the same code.
 */
export const PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE =
  "provideraccount.display_label_taken" as const;
/** The type of {@link PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE}. */
export type ProviderAccountDisplayLabelTakenCode = typeof PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE;

/**
 * Rebuilds an account's credential home from empty so the person can sign in again. It bumps
 * `credentialGeneration`; identity and stored quota readings survive, and the stored health is
 * invalidated, so the reply carries the new one.
 */
export interface ProviderAccountResetCredentialHomeRequest {
  accountId: ProviderAccountId;
}

/** Parses a {@link ProviderAccountResetCredentialHomeRequest}. */
export const ProviderAccountResetCredentialHomeRequestSchema: z.ZodType<
  ProviderAccountResetCredentialHomeRequest,
  ProviderAccountResetCredentialHomeRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

/** The account's new credential generation and health after the rebuild. */
export interface ProviderAccountResetCredentialHomeResponse {
  accountId: ProviderAccountId;
  /** The post-reset generation; strictly greater than the pre-reset value. */
  credentialGeneration: CredentialGeneration;
  /** Expected `reauth_required` until the person authenticates. */
  healthState: ProviderAccountHealthState;
}

/** Parses a {@link ProviderAccountResetCredentialHomeResponse}. */
export const ProviderAccountResetCredentialHomeResponseSchema: z.ZodType<ProviderAccountResetCredentialHomeResponse> =
  z
    .object({
      accountId: ProviderAccountIdSchema,
      credentialGeneration: CredentialGenerationSchema,
      healthState: ProviderAccountHealthStateSchema,
    })
    .strict();

/**
 * Starts the provider's own interactive sign-in into this account's home. The reply is what the
 * provider emits for the person to act on (an authorization URL or a device code) and an attempt
 * id.
 */
export interface ProviderAccountLoginRequest {
  accountId: ProviderAccountId;
}

/** Parses a {@link ProviderAccountLoginRequest}. */
export const ProviderAccountLoginRequestSchema: z.ZodType<
  ProviderAccountLoginRequest,
  ProviderAccountLoginRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

/** What the person needs to finish the sign-in, and the key to cancel it. */
export interface ProviderAccountLoginResponse {
  /** Opaque, daemon-minted, single-use; the correlation key for cancel and for completion. */
  attemptId: string;
  /** Where the person completes the flow: the provider's own URL, verbatim. */
  verificationUri: string;
  /** Present on a device-code arm; the person types it at `verificationUri`. */
  userCode?: string | undefined;
  /**
   * RFC 3339 UTC, where the provider bounds the attempt. Absent when the provider published no
   * bound, or the value failed the daemon's validation and was omitted rather than surfaced.
   */
  expiresAt?: string | undefined;
}

/** Parses a {@link ProviderAccountLoginResponse}. */
export const ProviderAccountLoginResponseSchema: z.ZodType<ProviderAccountLoginResponse> = z
  .object({
    attemptId: wireFreeFormString(
      PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
      "ProviderAccountLoginResponse.attemptId",
    ),
    // An https URL, not a free-form string: the person opens this value, so anything else must
    // fail here rather than reach a browser.
    verificationUri: z.url({ protocol: /^https$/u }).max(PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN),
    userCode: wireFreeFormString(
      PROVIDER_LOGIN_USER_CODE_MAX_LEN,
      "ProviderAccountLoginResponse.userCode",
    ).optional(),
    expiresAt: isoDateTimeSchema.optional(),
  })
  .strict();

/** Cancels one sign-in attempt by the id its login reply returned. */
export interface ProviderAccountLoginCancelRequest {
  attemptId: string;
}

/** Parses a {@link ProviderAccountLoginCancelRequest}. */
export const ProviderAccountLoginCancelRequestSchema: z.ZodType<
  ProviderAccountLoginCancelRequest,
  ProviderAccountLoginCancelRequest
> = z
  .object({
    attemptId: wireFreeFormString(
      PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
      "ProviderAccountLoginCancelRequest.attemptId",
    ),
  })
  .strict();

const PROVIDER_LOGIN_CANCEL_STATUS_VALUES = ["canceled", "notFound"] as const;

/**
 * How a cancel ended. Cancellation is an outcome, not an abandonment, so no provider-side login
 * stays open until it times out. `notFound` is for an attempt that already completed,
 * was already canceled, or never existed; it is not an error, so a client racing a completion
 * sees no refusal for losing.
 */
export type ProviderLoginCancelStatus = (typeof PROVIDER_LOGIN_CANCEL_STATUS_VALUES)[number];
/** Every {@link ProviderLoginCancelStatus}. */
export const PROVIDER_LOGIN_CANCEL_STATUSES: readonly ProviderLoginCancelStatus[] =
  PROVIDER_LOGIN_CANCEL_STATUS_VALUES;

/** How the cancel ended. */
export interface ProviderAccountLoginCancelResponse {
  status: ProviderLoginCancelStatus;
}

/** Parses a {@link ProviderAccountLoginCancelResponse}. */
export const ProviderAccountLoginCancelResponseSchema: z.ZodType<ProviderAccountLoginCancelResponse> =
  z.object({ status: z.enum(PROVIDER_LOGIN_CANCEL_STATUS_VALUES) }).strict();

/**
 * Wire member names a request-logging transport must redact before emitting a record. Declared
 * once here so a transport does not re-derive the list, and adding a credential-accepting member
 * without redacting it is one omission instead of one per transport.
 */
export const PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS: readonly string[] = ["nonInteractiveToken"];
