// The sign-in side of `providerAccount.*`: registering an account, which
// carries the one request member that may hold a credential; rebuilding an
// account's credential home; and the brokered interactive sign-in with its
// cancel. The member a request-logging transport must redact sits here beside
// the input it concerns.
//
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

// --------------------------------------------------------------------------
// Length caps
// --------------------------------------------------------------------------

/** The provider's verification URL, carried verbatim. */
export const PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN = 2048;
/** Device-code arm: the code the operator types at the verification URI. */
export const PROVIDER_LOGIN_USER_CODE_MAX_LEN = 64;
/**
 * Bound on D2 non-interactive token. Generous because the class is
 * vendor-minted and its encoding is not this layer's to predict; the bound
 * exists so an unbounded body cannot be smuggled through the one member whose
 * value is never logged and so never observable in a diagnostic.
 */
export const PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN = 8192;

// --------------------------------------------------------------------------
// providerAccount.register
// --------------------------------------------------------------------------

export interface ProviderAccountRegisterRequest {
  provider: ProviderName;
  displayLabel: string;
  billingMode: BillingMode;
  makeDefault?: boolean | undefined;
  /**
   * RE-SUPPLY SELECTOR, not an identity assertion. Supplied, this means
   * "replace the sealed token on THIS account" and `provider` must match the
   * stored row; omitted, this is an ordinary registration and the daemon mints
   * a new identity.
   *
   * It exists because the terminal `reauth_required` remedy is to mint a fresh
   * token and re-supply it, and deregister-then-register would daemon-mint a
   * NEW immutable identity — discarding the spend, quota, and attention history
   * keyed to the account the operator is trying to repair.
   *
   * A supplied id that names no registered account is REFUSED, never created,
   * so this member cannot be used to assert an identity of the caller's
   * choosing.
   *
   * NEVER ADMITTED ALONE. A re-supply with nothing to supply is not a request
   * this verb can serve: it is not a registration (an identity already exists)
   * and not a replacement (no token accompanies it). Admitting it would leave
   * the caller's intent to be guessed downstream, and the cheapest guess is the
   * wrong one — a silent no-op reported as a successful registration. This
   * member's presence therefore REQUIRES `nonInteractiveToken`, refused at the
   * parse boundary rather than in a handler. The converse is deliberately
   * unconstrained: a token with no `accountId` is the ordinary token-mode
   * registration of a new account.
   */
  accountId?: ProviderAccountId | undefined;
  /**
   * THE ONE CREDENTIAL-ACCEPTING INPUT ON THIS WIRE (D2).
   *
   * WRITE-ONLY. This value is on no provider-account response, is never logged,
   * never echoed to a terminal, never rendered, never placed in an error
   * message or a diagnostic dump, and never carried in an argument vector (an
   * argv is readable by any process running as the same user). A transport that
   * logs request bodies MUST redact this member by name — see
   * `PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS`, which exists so that redaction is
   * driven by a declaration rather than by each transport re-deriving the list.
   *
   * Admitted only under the four conjunctive conditions and sealed through
   * ladder; it is never written into the credential home, because daemon-owned
   * bytes in provider-owned space are indistinguishable to every later reader.
   */
  nonInteractiveToken?: string | undefined;
}

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
    // `wireFreeFormString` rather than a bare `z.string()`: the NUL-byte guard
    // is load-bearing on a value bound for a child process's environment, where
    // an embedded NUL truncates rather than errors. `.strict()` on the object is
    // what keeps a caller from smuggling `credentialGeneration` or any other
    // daemon-owned member alongside it.
    nonInteractiveToken: wireFreeFormString(
      PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN,
      "ProviderAccountRegisterRequest.nonInteractiveToken",
    ).optional(),
  })
  .strict()
  // `accountId` is the RE-SUPPLY selector, so it is meaningless without the
  // value being re-supplied. The two members stay independently optional at the
  // field level because either may legitimately be absent on its own; only the
  // combination is constrained, which is a cross-field rule and therefore lives
  // here rather than on either member. Refused against `nonInteractiveToken`:
  // that is the member the caller must add, and the id it names is not the
  // mistake.
  .superRefine((request, ctx) => {
    if (request.accountId !== undefined && request.nonInteractiveToken === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["nonInteractiveToken"],
        message:
          "accountId selects an account whose sealed token is to be replaced, so a request carrying it must also carry nonInteractiveToken; omit accountId to register a new account instead.",
      });
    }
  });

export interface ProviderAccountRegisterResponse {
  account: ProviderAccount;
}

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
export const KEYCHAIN_REFUSAL_CAUSES: readonly KeychainRefusalCause[] =
  KEYCHAIN_REFUSAL_CAUSE_VALUES;
export const KeychainRefusalCauseSchema: z.ZodType<KeychainRefusalCause, KeychainRefusalCause> =
  z.enum(KEYCHAIN_REFUSAL_CAUSE_VALUES);

/** A pasted token could not be sealed in this machine's keychain, so nothing was stored. */
export const PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE =
  "provideraccount.credential_seal_refused" as const;
export type ProviderAccountCredentialSealRefusedCode =
  typeof PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE;

// An object type alias rather than an interface: a refusal's details are handed
// to the daemon's domain error as a `Record<string, unknown>`, which an interface
// is not assignable to.
export type ProviderAccountCredentialSealRefusedDetails = { cause: KeychainRefusalCause };
export const ProviderAccountCredentialSealRefusedDetailsSchema: z.ZodType<ProviderAccountCredentialSealRefusedDetails> =
  z.object({ cause: KeychainRefusalCauseSchema }).strict();

/**
 * The name given to a token or API-key account repeats one of that provider's
 * other account names, compared without case or surrounding spaces. `Rename`
 * refuses on the same code.
 */
export const PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE =
  "provideraccount.display_label_taken" as const;
export type ProviderAccountDisplayLabelTakenCode = typeof PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE;

// --------------------------------------------------------------------------
// providerAccount.resetCredentialHome
// --------------------------------------------------------------------------
//
// Rebuilds an account's credential home from empty so the operator can
// authenticate into it again. It is a credential-home lifecycle transition, so
// it BUMPS `credentialGeneration` and never resets it — which is what lets a
// stale consumer still order two readings across the rebuild. Identity survives
// untouched, so the account keeps its spend history, and its stored quota
// readings are kept for the same reason: the provider-side allowance kept
// running while the home was empty. The stored health pair is the opposite
// case — the bump invalidates it, which is why `healthState` is returned here.

export interface ProviderAccountResetCredentialHomeRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountResetCredentialHomeRequestSchema: z.ZodType<
  ProviderAccountResetCredentialHomeRequest,
  ProviderAccountResetCredentialHomeRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountResetCredentialHomeResponse {
  accountId: ProviderAccountId;
  /** The post-reset generation; strictly greater than the pre-reset value. */
  credentialGeneration: CredentialGeneration;
  /** Expected `reauth_required` until the operator authenticates. */
  healthState: ProviderAccountHealthState;
}

export const ProviderAccountResetCredentialHomeResponseSchema: z.ZodType<ProviderAccountResetCredentialHomeResponse> =
  z
    .object({
      accountId: ProviderAccountIdSchema,
      credentialGeneration: CredentialGenerationSchema,
      healthState: ProviderAccountHealthStateSchema,
    })
    .strict();

// --------------------------------------------------------------------------
// providerAccount.login / providerAccount.loginCancel
// --------------------------------------------------------------------------
//
// Brokered interactive sign-in (D1). The daemon constructs the invocation,
// spawns the provider's UNMODIFIED binary with this account's home pinned, and
// reads nothing the flow writes. What returns is what the provider emits for
// the OPERATOR to act on, plus an opaque daemon-minted attempt id.
//
// The shape MIRRORS THE PROVIDER'S OWN, deliberately: one pinned login-start
// returns either an authorization URL or a device code with its verification
// URL, and the other prints a URL and accepts a pasted code. A provider arm
// emitting neither cannot be brokered and is refused rather than spawning a
// flow the operator cannot finish.

export interface ProviderAccountLoginRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountLoginRequestSchema: z.ZodType<
  ProviderAccountLoginRequest,
  ProviderAccountLoginRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountLoginResponse {
  /** Opaque, daemon-minted, single-use; the correlation key for cancel and for completion. */
  attemptId: string;
  /** Where the operator completes the flow — the provider's own URL, verbatim. */
  verificationUri: string;
  /** Present on a device-code arm; the operator types it at `verificationUri`. */
  userCode?: string | undefined;
  /**
   * RFC 3339 UTC, where the provider bounds the attempt. Absent = the provider
   * published no bound, or the value failed the daemon's parse-and-validate
   * step and was OMITTED rather than surfaced. It bounds an attempt and is not
   * provider state: it carries no OAuth, PKCE, or credential field.
   */
  expiresAt?: string | undefined;
}

export const ProviderAccountLoginResponseSchema: z.ZodType<ProviderAccountLoginResponse> = z
  .object({
    attemptId: wireFreeFormString(
      PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
      "ProviderAccountLoginResponse.attemptId",
    ),
    // `z.url()` and not a free-form string: this value is handed to an operator
    // to open, so a non-URL here is a composition defect that must fail at the
    // seam rather than reach a browser. The length cap stays as
    // defense-in-depth against a pathological query string.
    verificationUri: z.url().max(PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN),
    userCode: wireFreeFormString(
      PROVIDER_LOGIN_USER_CODE_MAX_LEN,
      "ProviderAccountLoginResponse.userCode",
    ).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export interface ProviderAccountLoginCancelRequest {
  attemptId: string;
}

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
 * Cancellation is a FIRST-CLASS OUTCOME, not an abandonment: a broker that
 * could only be abandoned would leave a provider-side login slot occupied until
 * it timed out. `notFound` is the honest arm for an attempt that already
 * completed, already canceled, or never existed — it is NOT an error, because
 * a client racing a completion should not see a refusal for losing the race.
 */
export type ProviderLoginCancelStatus = (typeof PROVIDER_LOGIN_CANCEL_STATUS_VALUES)[number];
export const PROVIDER_LOGIN_CANCEL_STATUSES: readonly ProviderLoginCancelStatus[] =
  PROVIDER_LOGIN_CANCEL_STATUS_VALUES;

export interface ProviderAccountLoginCancelResponse {
  status: ProviderLoginCancelStatus;
}

export const ProviderAccountLoginCancelResponseSchema: z.ZodType<ProviderAccountLoginCancelResponse> =
  z.object({ status: z.enum(PROVIDER_LOGIN_CANCEL_STATUS_VALUES) }).strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

/**
 * Wire member names a request-logging transport MUST redact before emitting a
 * record. Declared here rather than re-derived at each transport, so adding a
 * credential-accepting member and forgetting to redact it is one omission
 * instead of N.
 *
 * The census suite asserts this list has exactly one entry, that the entry is a
 * member of exactly one provider-account REQUEST shape, and that no response or
 * notification shape declares a member of that name.
 */
export const PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS: readonly string[] = ["nonInteractiveToken"];
