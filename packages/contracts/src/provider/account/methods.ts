// The `providerAccount.*` methods not in `provider/account/sign-in.ts` (update, remove,
// set-current, probe, memory import, usage read) and the namespace's method table. The account
// record and its reads are in `provider/account/record.ts`.
//
// Credential material crosses these methods on exactly one input,
// `ProviderAccountRegisterRequest.nonInteractiveToken`, and on no output: no response or
// notification shape in the three provider-account modules carries a token-shaped member under
// any name.
//
// A `provideraccount.*` refusal travels as `JsonRpcErrorData`, whose `fields` is untyped. The
// guarantee that matters there is that a refusal of a supplied token names which condition failed
// and never quotes, echoes or excerpts the supplied value.
//
// `credentialGeneration` is daemon-owned and on no request: a caller that could assert a
// generation could assert that a stale quota reading or a superseded attention epoch is current.
//
// `accountId` never mints an identity from a request; it always names an account the daemon
// already minted. It is the required selector on update, remove, set-current, home-reset, probe
// and login, the optional read scope on `ProviderAccountListRequest.accountId`, and the optional
// token re-supply selector on `ProviderAccountRegisterRequest.accountId` (the one create-shaped
// verb, where a supplied id could be mistaken for an assertion). An id that names no registered
// account is refused rather than created.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../../jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "../../method-descriptor.js";
import {
  BillingModeSchema,
  CredentialGenerationSchema,
  PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
  ProviderAccountHealthStateSchema,
  ProviderAccountIdSchema,
  ProviderAccountListRequestSchema,
  ProviderAccountListResponseSchema,
  ProviderAccountMemoryImportOutcomeSchema,
  ProviderAccountNotificationSchema,
  ProviderAccountSchema,
  ProviderAccountSubscribeRequestSchema,
  ProviderLoginExpiredRemedySchema,
  type BillingMode,
  type CredentialGeneration,
  type ProviderAccount,
  type ProviderAccountHealthState,
  type ProviderAccountId,
  type ProviderAccountListRequest,
  type ProviderAccountListResponse,
  type ProviderAccountMemoryImportOutcome,
  type ProviderAccountNotification,
  type ProviderAccountSubscribeRequest,
  type ProviderLoginExpiredRemedy,
} from "./record.js";
import { ProviderNameSchema, type ProviderName } from "../name.js";
import {
  ProviderAccountLoginCancelRequestSchema,
  ProviderAccountLoginCancelResponseSchema,
  ProviderAccountLoginRequestSchema,
  ProviderAccountLoginResponseSchema,
  ProviderAccountRegisterRequestSchema,
  ProviderAccountRegisterResponseSchema,
  ProviderAccountResetCredentialHomeRequestSchema,
  ProviderAccountResetCredentialHomeResponseSchema,
  type ProviderAccountLoginCancelRequest,
  type ProviderAccountLoginCancelResponse,
  type ProviderAccountLoginRequest,
  type ProviderAccountLoginResponse,
  type ProviderAccountRegisterRequest,
  type ProviderAccountRegisterResponse,
  type ProviderAccountResetCredentialHomeRequest,
  type ProviderAccountResetCredentialHomeResponse,
} from "./sign-in.js";
import { UsdMicrosSchema } from "../../session/cost.js";
import { wireFreeFormString } from "../../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../../session/id.js";
import { isoDateTimeSchema } from "../../internal/wire-scalars.js";

/** A model id on a usage row, as the provider names it. */
export const PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN = 128;
/** Why the wake helper did not install, in the installer's own words. */
export const PROVIDER_WAKE_HELPER_REASON_MAX_LEN = 1024;

/**
 * Edits an account's descriptive settings; an omitted member is unchanged. The provider, the
 * credential home, the credential generation and the default flag cannot be changed here.
 */
export interface ProviderAccountUpdateRequest {
  accountId: ProviderAccountId;
  /** Renames an account added from a pasted token or API key; no other account carries a name. */
  displayLabel?: string | undefined;
  /** How `unknown` is resolved to a declared mode. */
  billingMode?: BillingMode | undefined;
  /** The durable per-account opt-out for the background observer; on by default. */
  probeEnabled?: boolean | undefined;
  /**
   * Start each usage window as soon as it opens, with one small turn on the smallest model; on by
   * default. It does nothing while `probeEnabled` is off, and turning it on then is kept rather
   * than refused.
   */
  windowStartEnabled?: boolean | undefined;
  /**
   * Wake this computer for a window that resets while it sleeps. The first
   * account turned on installs the wake helper and the last one turned off
   * removes it; the reply says whether the helper is installed.
   */
  wakeForWindowStartEnabled?: boolean | undefined;
}

/** Parses a {@link ProviderAccountUpdateRequest}. */
export const ProviderAccountUpdateRequestSchema: z.ZodType<
  ProviderAccountUpdateRequest,
  ProviderAccountUpdateRequest
> = z
  .object({
    accountId: ProviderAccountIdSchema,
    displayLabel: wireFreeFormString(
      PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
      "ProviderAccountUpdateRequest.displayLabel",
    ).optional(),
    billingMode: BillingModeSchema.optional(),
    probeEnabled: z.boolean().optional(),
    windowStartEnabled: z.boolean().optional(),
    wakeForWindowStartEnabled: z.boolean().optional(),
  })
  .strict();

/**
 * Whether the helper that wakes this computer for a window start is installed.
 * A helper that did not install leaves the switch off and gives its reason.
 */
export type ProviderWakeHelperState =
  | { state: "installed" }
  | { state: "notInstalled"; reason: string };

/** The updated account. */
export interface ProviderAccountUpdateResponse {
  account: ProviderAccount;
  /** Present when the request changed `wakeForWindowStartEnabled` on a machine using the helper. */
  wakeHelper?: ProviderWakeHelperState | undefined;
}

/** Parses a {@link ProviderAccountUpdateResponse}. */
export const ProviderAccountUpdateResponseSchema: z.ZodType<ProviderAccountUpdateResponse> = z
  .object({
    account: ProviderAccountSchema,
    wakeHelper: z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("installed") }).strict(),
        z
          .object({
            state: z.literal("notInstalled"),
            reason: wireFreeFormString(
              PROVIDER_WAKE_HELPER_REASON_MAX_LEN,
              "ProviderAccountUpdateResponse.wakeHelper.reason",
            ),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

/** Removes one account. */
export interface ProviderAccountRemoveRequest {
  accountId: ProviderAccountId;
}

/** Parses a {@link ProviderAccountRemoveRequest}. */
export const ProviderAccountRemoveRequestSchema: z.ZodType<
  ProviderAccountRemoveRequest,
  ProviderAccountRemoveRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

/** The removed account's id. */
export interface ProviderAccountRemoveResponse {
  accountId: ProviderAccountId;
  /** Always `true`: removal has no partial success, and every refusal is a typed error. */
  removed: true;
}

/** Parses a {@link ProviderAccountRemoveResponse}. */
export const ProviderAccountRemoveResponseSchema: z.ZodType<ProviderAccountRemoveResponse> = z
  .object({ accountId: ProviderAccountIdSchema, removed: z.literal(true) })
  .strict();

/** A run bound to the account is live, so it is not removed; the refusal names those sessions. */
export const PROVIDER_ACCOUNT_IN_USE_CODE = "provideraccount.account_in_use" as const;
/**
 * The type of {@link PROVIDER_ACCOUNT_IN_USE_CODE}.
 *
 * @consumedBy the handler that returns the `provideraccount.account_in_use` error
 */
export type ProviderAccountInUseCode = typeof PROVIDER_ACCOUNT_IN_USE_CODE;

/** The sessions whose live runs block a removal. */
export type ProviderAccountInUseDetails = { sessionIds: SessionId[] };
/**
 * Parses {@link ProviderAccountInUseDetails}; at least one session is named.
 *
 * @consumedBy the handler that returns the `provideraccount.account_in_use` error
 */
export const ProviderAccountInUseDetailsSchema: z.ZodType<ProviderAccountInUseDetails> = z
  .object({ sessionIds: z.array(SessionIdSchema).min(1) })
  .strict();

/**
 * Makes this account its provider's current account, the one the `Default` mark sits on. New
 * sessions on that provider start on it, and every running session there that is not pinned to
 * an account moves to it; a saved agent or workflow step pinned to an account stays. No
 * credential is touched.
 */
export interface ProviderAccountSetCurrentRequest {
  accountId: ProviderAccountId;
}

/** Parses a {@link ProviderAccountSetCurrentRequest}. */
export const ProviderAccountSetCurrentRequestSchema: z.ZodType<
  ProviderAccountSetCurrentRequest,
  ProviderAccountSetCurrentRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

/**
 * One running session the switch is moving. The move is in place and takes effect at the
 * session's next provider request; it settles on that session's own transcript.
 */
export interface ProviderAccountMovingSession {
  sessionId: SessionId;
}

/** The account now current and the sessions the switch is moving. */
export interface ProviderAccountSetCurrentResponse {
  /**
   * The account now current for its provider, so `isDefault` on it is `true`. Checked at run
   * time rather than narrowed in the type, because the account projection is shared with every
   * other reply.
   */
  account: ProviderAccount;
  /**
   * The sessions the switch is moving, so the caller knows the press reached
   * live work. An empty list says nothing was running on that provider, or that
   * the account was already current.
   */
  movingSessions: ProviderAccountMovingSession[];
}

/** Parses a {@link ProviderAccountSetCurrentResponse}; a non-default account is refused. */
export const ProviderAccountSetCurrentResponseSchema: z.ZodType<ProviderAccountSetCurrentResponse> =
  z
    .object({
      account: ProviderAccountSchema,
      movingSessions: z.array(z.object({ sessionId: SessionIdSchema }).strict()),
    })
    .strict()
    .superRefine((response, context) => {
      if (!response.account.isDefault) {
        context.addIssue({
          code: "custom",
          path: ["account", "isDefault"],
          message:
            "`providerAccount.setCurrent` returns the account it made " +
            "current, so `isDefault` cannot be false on a success reply",
        });
      }
    });

/**
 * The named account is not signed in, so it is refused as a switch target before
 * anything moves: the mark stays and every session stays where it was. An
 * account whose last limits read showed its login gone is refused this way.
 */
export const PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE = "provideraccount.not_authenticated" as const;
/**
 * The type of {@link PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE}.
 *
 * @consumedBy the handler that returns the `provideraccount.not_authenticated` error
 */
export type ProviderAccountNotAuthenticatedCode = typeof PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE;

/** The refused account's own remedy, so the refusal points at the one way back for it. */
export type ProviderAccountNotAuthenticatedDetails = { remedy: ProviderLoginExpiredRemedy };
/** Parses {@link ProviderAccountNotAuthenticatedDetails}. */
export const ProviderAccountNotAuthenticatedDetailsSchema: z.ZodType<
  ProviderAccountNotAuthenticatedDetails,
  ProviderAccountNotAuthenticatedDetails
> = z.object({ remedy: ProviderLoginExpiredRemedySchema }).strict();

/** Checks one account's health now. */
export interface ProviderAccountProbeRequest {
  accountId: ProviderAccountId;
}

/** Parses a {@link ProviderAccountProbeRequest}. */
export const ProviderAccountProbeRequestSchema: z.ZodType<
  ProviderAccountProbeRequest,
  ProviderAccountProbeRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

/** The account's health as the probe read it. */
export interface ProviderAccountProbeResponse {
  accountId: ProviderAccountId;
  healthState: ProviderAccountHealthState;
  /** The generation the probe observed; a later bump invalidates this reading. */
  credentialGeneration: CredentialGeneration;
}

/** Parses a {@link ProviderAccountProbeResponse}. */
export const ProviderAccountProbeResponseSchema: z.ZodType<ProviderAccountProbeResponse> = z
  .object({
    accountId: ProviderAccountIdSchema,
    healthState: ProviderAccountHealthStateSchema,
    credentialGeneration: CredentialGenerationSchema,
  })
  .strict();

/**
 * Copies the person's own provider memory into this account's home, once, never overwriting a
 * file. It answers with the outcome the account keeps, so a repeat never copies twice.
 */
export interface ProviderAccountMemoryImportRequest {
  accountId: ProviderAccountId;
}

/** Parses a {@link ProviderAccountMemoryImportRequest}. */
export const ProviderAccountMemoryImportRequestSchema: z.ZodType<
  ProviderAccountMemoryImportRequest,
  ProviderAccountMemoryImportRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

/** The accounts a usage read covers: one account, or every account of one provider. */
export type ProviderAccountUsageScope =
  | { accountId: ProviderAccountId }
  | { provider: ProviderName };

const PROVIDER_ACCOUNT_USAGE_GROUPING_VALUES = ["day", "model"] as const;

/** How a usage read splits its figures: by calendar day, or by model. */
export type ProviderAccountUsageGrouping = (typeof PROVIDER_ACCOUNT_USAGE_GROUPING_VALUES)[number];

/**
 * Reads tokens and spend per account from the service's per-turn records. A subscription
 * account's tokens are priced at the provider's published per-token rates.
 */
export interface ProviderAccountUsageReadRequest {
  scope: ProviderAccountUsageScope;
  /** RFC 3339, inclusive. Absent = from the first recorded turn. */
  from?: string | undefined;
  /** RFC 3339, exclusive. Absent = now. */
  to?: string | undefined;
  /** Absent = one row for the whole range. */
  groupBy?: ProviderAccountUsageGrouping | undefined;
}

/** Parses a {@link ProviderAccountUsageReadRequest}. */
export const ProviderAccountUsageReadRequestSchema: z.ZodType<
  ProviderAccountUsageReadRequest,
  ProviderAccountUsageReadRequest
> = z
  .object({
    scope: z.union([
      z.object({ accountId: ProviderAccountIdSchema }).strict(),
      z.object({ provider: ProviderNameSchema }).strict(),
    ]),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    groupBy: z.enum(PROVIDER_ACCOUNT_USAGE_GROUPING_VALUES).optional(),
  })
  .strict();

/**
 * One figure: the tokens and what they cost, in whole micro-dollars. `day` is set on a row
 * grouped by day (`YYYY-MM-DD`) and `model` on a row grouped by model, as the provider names it.
 */
export interface ProviderAccountUsageRow {
  day?: string | undefined;
  model?: string | undefined;
  tokens: number;
  costUsdMicros: number;
}

/** The usage rows for the requested range and grouping. */
export interface ProviderAccountUsageReadResponse {
  rows: ProviderAccountUsageRow[];
}

/** Parses a {@link ProviderAccountUsageReadResponse}. */
export const ProviderAccountUsageReadResponseSchema: z.ZodType<ProviderAccountUsageReadResponse> = z
  .object({
    rows: z.array(
      z
        .object({
          day: z.iso.date().optional(),
          model: wireFreeFormString(
            PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN,
            "ProviderAccountUsageRow.model",
          ).optional(),
          tokens: z.number().int().min(0),
          costUsdMicros: UsdMicrosSchema,
        })
        .strict(),
    ),
  })
  .strict();

/** The `providerAccount.*` methods the daemon answers. */
export interface ProviderAccountMethodDescriptors {
  readonly "providerAccount.list": MethodDescriptor<
    "providerAccount.list",
    ProviderAccountListRequest,
    ProviderAccountListResponse
  >;
  readonly "providerAccount.subscribe": SubscriptionMethodDescriptor<
    "providerAccount.subscribe",
    ProviderAccountSubscribeRequest,
    SubscribeAckResponse,
    ProviderAccountNotification
  >;
  readonly "providerAccount.register": MethodDescriptor<
    "providerAccount.register",
    ProviderAccountRegisterRequest,
    ProviderAccountRegisterResponse
  >;
  readonly "providerAccount.update": MethodDescriptor<
    "providerAccount.update",
    ProviderAccountUpdateRequest,
    ProviderAccountUpdateResponse
  >;
  readonly "providerAccount.remove": MethodDescriptor<
    "providerAccount.remove",
    ProviderAccountRemoveRequest,
    ProviderAccountRemoveResponse
  >;
  readonly "providerAccount.setCurrent": MethodDescriptor<
    "providerAccount.setCurrent",
    ProviderAccountSetCurrentRequest,
    ProviderAccountSetCurrentResponse
  >;
  readonly "providerAccount.probe": MethodDescriptor<
    "providerAccount.probe",
    ProviderAccountProbeRequest,
    ProviderAccountProbeResponse
  >;
  readonly "providerAccount.resetCredentialHome": MethodDescriptor<
    "providerAccount.resetCredentialHome",
    ProviderAccountResetCredentialHomeRequest,
    ProviderAccountResetCredentialHomeResponse
  >;
  readonly "providerAccount.login": MethodDescriptor<
    "providerAccount.login",
    ProviderAccountLoginRequest,
    ProviderAccountLoginResponse
  >;
  readonly "providerAccount.loginCancel": MethodDescriptor<
    "providerAccount.loginCancel",
    ProviderAccountLoginCancelRequest,
    ProviderAccountLoginCancelResponse
  >;
  readonly "providerAccount.memoryImport": MethodDescriptor<
    "providerAccount.memoryImport",
    ProviderAccountMemoryImportRequest,
    ProviderAccountMemoryImportOutcome
  >;
  readonly "providerAccount.usageRead": MethodDescriptor<
    "providerAccount.usageRead",
    ProviderAccountUsageReadRequest,
    ProviderAccountUsageReadResponse
  >;
}

/** Every `providerAccount.*` method: its name, how it answers, and its shapes. */
export const PROVIDER_ACCOUNT_METHOD_DESCRIPTORS: ProviderAccountMethodDescriptors =
  defineMethodDescriptors({
    "providerAccount.list": {
      method: "providerAccount.list",
      procedureType: "query",
      mutating: false,
      requestSchema: ProviderAccountListRequestSchema,
      responseSchema: ProviderAccountListResponseSchema,
    },
    "providerAccount.subscribe": {
      method: "providerAccount.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: ProviderAccountSubscribeRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: ProviderAccountNotificationSchema,
    },
    "providerAccount.register": {
      method: "providerAccount.register",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountRegisterRequestSchema,
      responseSchema: ProviderAccountRegisterResponseSchema,
    },
    "providerAccount.update": {
      method: "providerAccount.update",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountUpdateRequestSchema,
      responseSchema: ProviderAccountUpdateResponseSchema,
    },
    "providerAccount.remove": {
      method: "providerAccount.remove",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountRemoveRequestSchema,
      responseSchema: ProviderAccountRemoveResponseSchema,
    },
    "providerAccount.setCurrent": {
      method: "providerAccount.setCurrent",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountSetCurrentRequestSchema,
      responseSchema: ProviderAccountSetCurrentResponseSchema,
    },
    "providerAccount.probe": {
      method: "providerAccount.probe",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountProbeRequestSchema,
      responseSchema: ProviderAccountProbeResponseSchema,
    },
    "providerAccount.resetCredentialHome": {
      method: "providerAccount.resetCredentialHome",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountResetCredentialHomeRequestSchema,
      responseSchema: ProviderAccountResetCredentialHomeResponseSchema,
    },
    "providerAccount.login": {
      method: "providerAccount.login",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountLoginRequestSchema,
      responseSchema: ProviderAccountLoginResponseSchema,
    },
    "providerAccount.loginCancel": {
      method: "providerAccount.loginCancel",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountLoginCancelRequestSchema,
      responseSchema: ProviderAccountLoginCancelResponseSchema,
    },
    "providerAccount.memoryImport": {
      method: "providerAccount.memoryImport",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderAccountMemoryImportRequestSchema,
      responseSchema: ProviderAccountMemoryImportOutcomeSchema,
    },
    "providerAccount.usageRead": {
      method: "providerAccount.usageRead",
      procedureType: "query",
      mutating: false,
      requestSchema: ProviderAccountUsageReadRequestSchema,
      responseSchema: ProviderAccountUsageReadResponseSchema,
    },
  });
