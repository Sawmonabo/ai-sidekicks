// The remaining `providerAccount.*` methods (update, remove, set-current,
// probe, memory import and usage read), the credential census over every
// account shape, and the one method table for the namespace. The account record
// and its reads are in `provider-account.ts`; registering and signing in are in
// `provider-account-sign-in.ts`.
//
// ----------------------------------------------------------------------------
// The one credential input, and the census that keeps it one
// ----------------------------------------------------------------------------
//
// Credential material crosses this surface on EXACTLY ONE input —
// `ProviderAccountRegisterRequest.nonInteractiveToken` — and on NO output. No
// response and no notification shape in the three provider-account modules
// carries a token-shaped member under any name. That claim is not prose:
// `PROVIDER_ACCOUNT_WIRE_SHAPES` below enumerates every request, response, and
// notification shape in the three, and the contract suite walks it to count credential-accepting inputs
// (must be exactly one, named) and credential-bearing outputs (must be zero).
// A shape added to any of the three without a registry entry is caught by the same suite's
// completeness check, so the census cannot go vacuous by omission.
//
// THE ERROR CHANNEL IS THE FOURTH DIRECTION, and no module declares a shape
// for it. A `provideraccount.*` refusal travels as `JsonRpcErrorData`, whose
// `fields` is `Record<string, unknown>` — an untyped hole no schema census can
// close, because there is no schema. The permitted contents are declared in
// prose, per code the guarantee that matters most there is
// `provideraccount.token_class_refused`, which "names which condition failed and
// never quotes, echoes, or excerpts the supplied value". The contract suite
// therefore censuses representative refusal envelopes — each code transcribed
// from those rows, each `fields` shape composed to be consistent with that row's
// prose — by member NAME at any depth and by VALUE against the token fixture, so
// a mapper that echoed the input back fails a test rather than only a reading of
// the docs. Two honest limits: the fixture set is enumerated by hand, so a code
// added to that doc without a fixture is not caught here, and the binding
// enforcement is the daemon's error mapper, which is a later phase. Registering
// the field names as a typed contract belongs to the swap that gives them a
// producer — a declaration whose only consumer is its own test is minted ahead
// of its reader.
//
// ----------------------------------------------------------------------------
// What is response-only, and what deliberately is not
// ----------------------------------------------------------------------------
//
// `credentialGeneration` is daemon-owned and appears on NO provider-account
// request: a caller that could assert a generation could assert that a stale
// quota reading or a superseded attention epoch is current.
//
// `accountId` never mints an identity from a request. Every request that
// carries it is a selector naming an account the daemon already minted — the
// required selector on update / remove / set-current / home-reset / probe /
// login, the optional read scope on `ProviderAccountListRequest.accountId`,
// and the optional token RE-SUPPLY selector on
// `ProviderAccountRegisterRequest.accountId` (the one CREATE-shaped verb, so
// the only place a supplied id could be mistaken for an assertion — documented
// in the canonical wire section and). A supplied id that names no registered
// account is refused rather than created.
//
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import type { MethodDescriptor, SubscriptionMethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
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
  ProviderNameSchema,
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
  type ProviderName,
} from "./provider-account.js";
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
} from "./provider-account-sign-in.js";
import { UsdMicrosSchema } from "./session-cost.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

// --------------------------------------------------------------------------
// Length caps
// --------------------------------------------------------------------------

/** A model id on a usage row, as the provider names it. */
export const PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN = 128;
/** Why the wake helper did not install, in the installer's own words. */
export const PROVIDER_WAKE_HELPER_REASON_MAX_LEN = 1024;

// --------------------------------------------------------------------------
// providerAccount.update
// --------------------------------------------------------------------------
//
// NOT UPDATABLE, by omission from the request and enforced on write:
// `provider` (an account does not change vendor), `credentialHomePath`
// (rebinding a registration to a different home would silently re-point
// historical spend at other credentials), `credentialGeneration` (daemon-owned
// — a descriptive correction is not a credential event), and `isDefault`, which
// has its own verb whose partial-unique-index race semantics this verb must not
// duplicate.

export interface ProviderAccountUpdateRequest {
  accountId: ProviderAccountId;
  /** Omitted = unchanged. */
  displayLabel?: string | undefined;
  /** Omitted = unchanged; this is how `unknown` is resolved to a declared mode. */
  billingMode?: BillingMode | undefined;
  /**
   * The durable per-account opt-out for the background observer. Carried on the
   * existing update verb rather than as a dedicated verb: it is an ordinary
   * mutable account preference. Omitted = unchanged; the column default is
   * enabled, so silence never silences an observer.
   */
  probeEnabled?: boolean | undefined;
  /**
   * Start each usage window as soon as it opens, with one small turn on the
   * smallest model. Omitted = unchanged; on by default. It sits under
   * `probeEnabled` and does nothing while that is off, so turning it on then is
   * kept rather than refused.
   */
  windowStartEnabled?: boolean | undefined;
  /**
   * Wake this computer for a window that resets while it sleeps. The first
   * account turned on installs the wake helper and the last one turned off
   * removes it; the reply says whether the helper is installed.
   */
  wakeForWindowStartEnabled?: boolean | undefined;
}

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

export interface ProviderAccountUpdateResponse {
  account: ProviderAccount;
  /** Present when the request changed `wakeForWindowStartEnabled` on a machine that wakes through the helper. */
  wakeHelper?: ProviderWakeHelperState | undefined;
}

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

// --------------------------------------------------------------------------
// providerAccount.remove
// --------------------------------------------------------------------------

export interface ProviderAccountRemoveRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountRemoveRequestSchema: z.ZodType<
  ProviderAccountRemoveRequest,
  ProviderAccountRemoveRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountRemoveResponse {
  accountId: ProviderAccountId;
  /**
   * `z.literal(true)` and not `z.boolean()`: removal has no partial success. A
   * `removed: false` reply would be a refusal wearing a success envelope, and
   * every refusal on this verb is a typed error instead.
   */
  removed: true;
}

export const ProviderAccountRemoveResponseSchema: z.ZodType<ProviderAccountRemoveResponse> = z
  .object({ accountId: ProviderAccountIdSchema, removed: z.literal(true) })
  .strict();

/** A run bound to the account is live, so it is not removed; the refusal names those sessions. */
export const PROVIDER_ACCOUNT_IN_USE_CODE = "provideraccount.account_in_use" as const;
export type ProviderAccountInUseCode = typeof PROVIDER_ACCOUNT_IN_USE_CODE;

export type ProviderAccountInUseDetails = { sessionIds: SessionId[] };
export const ProviderAccountInUseDetailsSchema: z.ZodType<ProviderAccountInUseDetails> = z
  .object({ sessionIds: z.array(SessionIdSchema).min(1) })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.setCurrent
// --------------------------------------------------------------------------
//
// Makes this account its provider's current account, which is the account the
// `Default` mark sits on: one fact. New sessions on that provider start on it,
// and every running session on that provider that is not pinned to an account
// moves to it. A saved agent or a workflow step set to a specific account stays
// where it is pinned. Nothing here touches a credential.

export interface ProviderAccountSetCurrentRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountSetCurrentRequestSchema: z.ZodType<
  ProviderAccountSetCurrentRequest,
  ProviderAccountSetCurrentRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

const PROVIDER_ACCOUNT_MOVE_APPLIES_AT_VALUES = ["immediately", "next_tool_call"] as const;

/**
 * When a moved session reaches the new account: `immediately`, or at its next
 * tool call where the provider can only move it by resuming the conversation in
 * the new account and the session is in the middle of a turn.
 */
export type ProviderAccountMoveAppliesAt = (typeof PROVIDER_ACCOUNT_MOVE_APPLIES_AT_VALUES)[number];

/** One running session the switch is moving. The move settles on that session's own timeline. */
export interface ProviderAccountMovingSession {
  sessionId: SessionId;
  appliesAt: ProviderAccountMoveAppliesAt;
}

export interface ProviderAccountSetCurrentResponse {
  /**
   * The account now current for its provider, so `isDefault` on it is `true`:
   * the verb has no partial success, and every refusal is a typed error. A
   * runtime check rather than a narrowed type, because the account projection
   * is shared with every other reply.
   */
  account: ProviderAccount;
  /**
   * The sessions the switch is moving, so the caller knows the press reached
   * live work. An empty list says nothing was running on that provider, or that
   * the account was already current.
   */
  movingSessions: ProviderAccountMovingSession[];
}

export const ProviderAccountSetCurrentResponseSchema: z.ZodType<ProviderAccountSetCurrentResponse> =
  z
    .object({
      account: ProviderAccountSchema,
      movingSessions: z.array(
        z
          .object({
            sessionId: SessionIdSchema,
            appliesAt: z.enum(PROVIDER_ACCOUNT_MOVE_APPLIES_AT_VALUES),
          })
          .strict(),
      ),
    })
    .strict()
    .superRefine((response, ctx) => {
      if (!response.account.isDefault) {
        ctx.addIssue({
          code: "custom",
          path: ["account", "isDefault"],
          message:
            "`providerAccount.setCurrent` returns the account it made current, so `isDefault` cannot be false on a success reply",
        });
      }
    });

/**
 * The named account is not signed in, so it is refused as a switch target before
 * anything moves: the mark stays and every session stays where it was. An
 * account whose last limits read showed its login gone is refused this way.
 */
export const PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE = "provideraccount.not_authenticated" as const;
export type ProviderAccountNotAuthenticatedCode = typeof PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE;

// --------------------------------------------------------------------------
// providerAccount.probe
// --------------------------------------------------------------------------

export interface ProviderAccountProbeRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountProbeRequestSchema: z.ZodType<
  ProviderAccountProbeRequest,
  ProviderAccountProbeRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountProbeResponse {
  accountId: ProviderAccountId;
  healthState: ProviderAccountHealthState;
  /** The generation the probe observed; a later bump invalidates this reading. */
  credentialGeneration: CredentialGeneration;
}

export const ProviderAccountProbeResponseSchema: z.ZodType<ProviderAccountProbeResponse> = z
  .object({
    accountId: ProviderAccountIdSchema,
    healthState: ProviderAccountHealthStateSchema,
    credentialGeneration: CredentialGenerationSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.memoryImport
// --------------------------------------------------------------------------
//
// Copies the person's own memory store into this account's home, once, on a
// press: Claude Code's `~/.claude/projects/*/memory/` (and the person's own agent
// notes into the service's one agent-memory folder, never overwriting a file
// already there), Codex's `~/.codex/memories/`. The two homes are never joined.
// It answers with the outcome the account keeps as its `memoryImport`, so a
// repeated press answers it again rather than copying twice.

export interface ProviderAccountMemoryImportRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountMemoryImportRequestSchema: z.ZodType<
  ProviderAccountMemoryImportRequest,
  ProviderAccountMemoryImportRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

// --------------------------------------------------------------------------
// providerAccount.usageRead
// --------------------------------------------------------------------------
//
// Tokens and spend from the one table the service keeps a row in per turn,
// each row naming the account that paid for it. Every dollar figure is the cost
// with no mark: a subscription account's tokens are priced at the provider's
// published per-token rates, and an account that has spent nothing reads zero.
// These are the service's own figures; the provider's own usage windows are the
// separate `usageWindows` on `providerAccount.list`.

/** The accounts a usage read covers: one account, or every account of one provider. */
export type ProviderAccountUsageScope =
  | { accountId: ProviderAccountId }
  | { provider: ProviderName };

const PROVIDER_ACCOUNT_USAGE_GROUPING_VALUES = ["day", "model"] as const;

/** How a usage read splits its figures: by calendar day, or by model. */
export type ProviderAccountUsageGrouping = (typeof PROVIDER_ACCOUNT_USAGE_GROUPING_VALUES)[number];

export interface ProviderAccountUsageReadRequest {
  scope: ProviderAccountUsageScope;
  /** RFC 3339, inclusive. Absent = from the first recorded turn. */
  from?: string | undefined;
  /** RFC 3339, exclusive. Absent = now. */
  to?: string | undefined;
  /** Absent = one row for the whole range. */
  groupBy?: ProviderAccountUsageGrouping | undefined;
}

export const ProviderAccountUsageReadRequestSchema: z.ZodType<
  ProviderAccountUsageReadRequest,
  ProviderAccountUsageReadRequest
> = z
  .object({
    scope: z.union([
      z.object({ accountId: ProviderAccountIdSchema }).strict(),
      z.object({ provider: ProviderNameSchema }).strict(),
    ]),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    groupBy: z.enum(PROVIDER_ACCOUNT_USAGE_GROUPING_VALUES).optional(),
  })
  .strict();

/**
 * One figure: the tokens and what they cost, in whole micro-dollars. `day` is set on a row
 * grouped by day (`YYYY-MM-DD`) and `model` on a row grouped by model, the
 * model id as the provider names it.
 */
export interface ProviderAccountUsageRow {
  day?: string | undefined;
  model?: string | undefined;
  tokens: number;
  costUsdMicros: number;
}

export interface ProviderAccountUsageReadResponse {
  rows: ProviderAccountUsageRow[];
}

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

// --------------------------------------------------------------------------
// The wire-shape registry — the census's subject set
// --------------------------------------------------------------------------
//
// Every provider-account request, response, and notification schema appears here
// exactly once. The registry exists so census DERIVES its subject set rather
// than hand-listing it: a hand-listed census passes forever after someone adds
// an eleventh shape, which is precisely the incremental widening names as its
// failure mode and this census as its detection.
//
// `direction` is what makes the count meaningful: credential material may
// appear on `request` shapes (exactly one member, on exactly one shape) and on
// NO `response` or `notification` shape.

export type ProviderAccountWireDirection = "request" | "response" | "notification";

export interface ProviderAccountWireShape {
  /** The exported interface's name, for a failure message that names the offender. */
  readonly name: string;
  readonly direction: ProviderAccountWireDirection;
  readonly schema: z.ZodType<unknown>;
}

export const PROVIDER_ACCOUNT_WIRE_SHAPES: readonly ProviderAccountWireShape[] = [
  {
    name: "ProviderAccountListRequest",
    direction: "request",
    schema: ProviderAccountListRequestSchema,
  },
  {
    name: "ProviderAccountListResponse",
    direction: "response",
    schema: ProviderAccountListResponseSchema,
  },
  {
    name: "ProviderAccountRegisterRequest",
    direction: "request",
    schema: ProviderAccountRegisterRequestSchema,
  },
  {
    name: "ProviderAccountRegisterResponse",
    direction: "response",
    schema: ProviderAccountRegisterResponseSchema,
  },
  {
    name: "ProviderAccountUpdateRequest",
    direction: "request",
    schema: ProviderAccountUpdateRequestSchema,
  },
  {
    name: "ProviderAccountUpdateResponse",
    direction: "response",
    schema: ProviderAccountUpdateResponseSchema,
  },
  {
    name: "ProviderAccountRemoveRequest",
    direction: "request",
    schema: ProviderAccountRemoveRequestSchema,
  },
  {
    name: "ProviderAccountRemoveResponse",
    direction: "response",
    schema: ProviderAccountRemoveResponseSchema,
  },
  {
    name: "ProviderAccountSetCurrentRequest",
    direction: "request",
    schema: ProviderAccountSetCurrentRequestSchema,
  },
  {
    name: "ProviderAccountSetCurrentResponse",
    direction: "response",
    schema: ProviderAccountSetCurrentResponseSchema,
  },
  {
    name: "ProviderAccountResetCredentialHomeRequest",
    direction: "request",
    schema: ProviderAccountResetCredentialHomeRequestSchema,
  },
  {
    name: "ProviderAccountResetCredentialHomeResponse",
    direction: "response",
    schema: ProviderAccountResetCredentialHomeResponseSchema,
  },
  {
    name: "ProviderAccountProbeRequest",
    direction: "request",
    schema: ProviderAccountProbeRequestSchema,
  },
  {
    name: "ProviderAccountProbeResponse",
    direction: "response",
    schema: ProviderAccountProbeResponseSchema,
  },
  {
    name: "ProviderAccountLoginRequest",
    direction: "request",
    schema: ProviderAccountLoginRequestSchema,
  },
  {
    name: "ProviderAccountLoginResponse",
    direction: "response",
    schema: ProviderAccountLoginResponseSchema,
  },
  {
    name: "ProviderAccountLoginCancelRequest",
    direction: "request",
    schema: ProviderAccountLoginCancelRequestSchema,
  },
  {
    name: "ProviderAccountLoginCancelResponse",
    direction: "response",
    schema: ProviderAccountLoginCancelResponseSchema,
  },
  {
    name: "ProviderAccountMemoryImportRequest",
    direction: "request",
    schema: ProviderAccountMemoryImportRequestSchema,
  },
  {
    name: "ProviderAccountUsageReadRequest",
    direction: "request",
    schema: ProviderAccountUsageReadRequestSchema,
  },
  {
    name: "ProviderAccountUsageReadResponse",
    direction: "response",
    schema: ProviderAccountUsageReadResponseSchema,
  },
  {
    name: "ProviderAccountSubscribeRequest",
    direction: "request",
    schema: ProviderAccountSubscribeRequestSchema,
  },
  {
    name: "ProviderAccountNotification",
    direction: "notification",
    schema: ProviderAccountNotificationSchema,
  },
];

// --------------------------------------------------------------------------
// The method table
// --------------------------------------------------------------------------

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
