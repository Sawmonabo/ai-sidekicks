// The attention projection (machine-wide, whole on every emission) and the `attention.*`
// methods: banner settling, seen marking, and delivery by web address or email digest,
// whose secrets the daemon seals and never sends back.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "./method-descriptor.js";
import { wireFreeFormString } from "./free-form-string.js";
import { KeychainRefusalCauseSchema, type KeychainRefusalCause } from "./keychain.js";
import { SessionIdSchema, type SessionId } from "./session/id.js";
import { WorkflowNodeIdSchema, type WorkflowNodeId } from "./workflow/definition/document.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

/**
 * Every attention trigger: pending approval or user input, run completion, run failure,
 * and a workflow's Notify step. The set is closed; a client never invents a trigger.
 */
export const ATTENTION_TRIGGERS = [
  "pending_approval",
  "pending_input",
  "run_completed",
  "run_failed",
  "workflow_notify",
] as const;

/** One attention trigger. Derived, so the vocabulary has exactly one home. */
export type AttentionTrigger = (typeof ATTENTION_TRIGGERS)[number];

/**
 * The two severities: `actionable` attention blocks on the person, `informational` does not.
 * A client must render the two differently.
 */
export const ATTENTION_SEVERITIES = ["actionable", "informational"] as const;

/** One attention severity. Derived, so the vocabulary has exactly one home. */
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

const ATTENTION_BANNER_STATE_VALUES = ["pending", "posted", "withheld", "withdrawn"] as const;

/**
 * What became of an entry's operating-system banner. The daemon writes `withheld`
 * when a switch or a mute keeps the entry from raising one, and `pending`
 * otherwise; main settles a `pending` entry once, so no banner is posted twice.
 */
export type AttentionBannerState = (typeof ATTENTION_BANNER_STATE_VALUES)[number];
/**
 * Every {@link AttentionBannerState}.
 *
 * @consumedBy the main process's notification poster, which posts only pending entries and settles
 * each one
 */
export const ATTENTION_BANNER_STATES: readonly AttentionBannerState[] =
  ATTENTION_BANNER_STATE_VALUES;

const ATTENTION_WEB_ADDRESS_STATE_VALUES = ["pending", "delivered", "undelivered"] as const;

/** Where an entry's message to the person's web address stands. */
export type AttentionWebAddressState = (typeof ATTENTION_WEB_ADDRESS_STATE_VALUES)[number];
/**
 * Every {@link AttentionWebAddressState}.
 *
 * @consumedBy the web-address send, and the Notifications page's status line that counts what stays
 * undelivered
 */
export const ATTENTION_WEB_ADDRESS_STATES: readonly AttentionWebAddressState[] =
  ATTENTION_WEB_ADDRESS_STATE_VALUES;

/**
 * The longest id an attention entry carries: its own, its moment's, its run's and its
 * source event's. The daemon mints each of them.
 */
export const ATTENTION_ID_MAX_LEN = 256;

const attentionIdSchema = (fieldLabel: string): z.ZodString =>
  wireFreeFormString(ATTENTION_ID_MAX_LEN, fieldLabel);

/** One attention item: run-scoped when it carries `runId`, else the session-scoped aggregate. */
export interface AttentionItem {
  readonly id: string;
  /**
   * The session or run and the state it is in, so a later state replaces the operating-system
   * banner in place; a Notify step's moment also names its node and execution.
   */
  readonly momentId: string;
  readonly sessionId: SessionId;
  /** Present on a run-scoped item; absent on the session-scoped aggregate. */
  readonly runId?: string | undefined;
  readonly trigger: AttentionTrigger;
  readonly severity: AttentionSeverity;
  readonly displayName: string;
  /** What follows `displayName`: `Waiting on you`, `Finished`, `Failed`, or a notice. */
  readonly stateWord: string;
  /** The Notify node, on a `workflow_notify` item only. */
  readonly stepId?: WorkflowNodeId | undefined;
  /** One line of prose the list draws; never a banner's body, which says only name and state. */
  readonly summary: string;
  /** The canonical event that triggered this item. */
  readonly sourceEventId: string;
  readonly createdAt: string;
  /** Set once the state that produced the item resolves; absent means outstanding. */
  readonly resolvedAt?: string | undefined;
  readonly bannerState: AttentionBannerState;
  /**
   * Where the entry's message to the web address stands, and how many sends it took; both
   * present exactly when the entry is sent to a web address.
   */
  readonly webAddressState?: AttentionWebAddressState | undefined;
  readonly webAddressAttemptCount?: number | undefined;
  /** The one seen-or-unseen fact the daemon keeps, which the session's row reads too. */
  readonly seen: boolean;
}

/**
 * Parses an {@link AttentionItem}. A Notify step's item names its step and no other
 * item does, and it is informational and carries its run: it tells the person
 * something and never counts as waiting on them.
 */
export const AttentionItemSchema: z.ZodType<AttentionItem> = z
  .object({
    id: attentionIdSchema("AttentionItem.id"),
    momentId: attentionIdSchema("AttentionItem.momentId"),
    sessionId: SessionIdSchema,
    runId: attentionIdSchema("AttentionItem.runId").optional(),
    trigger: z.enum(ATTENTION_TRIGGERS),
    severity: z.enum(ATTENTION_SEVERITIES),
    displayName: z.string().min(1),
    stateWord: z.string().min(1),
    stepId: WorkflowNodeIdSchema.optional(),
    summary: z.string(),
    sourceEventId: attentionIdSchema("AttentionItem.sourceEventId"),
    createdAt: isoDateTimeSchema,
    resolvedAt: isoDateTimeSchema.optional(),
    bannerState: z.enum(ATTENTION_BANNER_STATE_VALUES),
    webAddressState: z.enum(ATTENTION_WEB_ADDRESS_STATE_VALUES).optional(),
    webAddressAttemptCount: countSchema.optional(),
    seen: z.boolean(),
  })
  .strict()
  .refine(
    (item) => (item.webAddressState === undefined) === (item.webAddressAttemptCount === undefined),
    {
      message: "webAddressState and webAddressAttemptCount are present together",
      path: ["webAddressAttemptCount"],
    },
  )
  .refine((item) => (item.trigger === "workflow_notify") === (item.stepId !== undefined), {
    message: "stepId is present exactly on a workflow_notify item",
    path: ["stepId"],
  })
  .refine(
    (item) =>
      item.trigger !== "workflow_notify" ||
      (item.severity === "informational" && item.runId !== undefined),
    {
      message: "a workflow_notify item is informational and carries its run",
      path: ["severity"],
    },
  );

/** The whole projection, as every emission of the attention read carries it. */
export interface AttentionProjection {
  readonly items: readonly AttentionItem[];
}
/** Parses an {@link AttentionProjection}. */
export const AttentionProjectionSchema: z.ZodType<AttentionProjection> = z
  .object({ items: z.array(AttentionItemSchema) })
  .strict();

// The banner and the seen fact

/**
 * Main's record of what became of a `pending` entry's banner. Only main sends it,
 * and the daemon ignores it once the entry has left `pending`.
 */
export interface AttentionBannerSettleRequest {
  entryId: string;
  state: Exclude<AttentionBannerState, "pending">;
}
/** Parses an {@link AttentionBannerSettleRequest}; settling back to `pending` is refused. */
export const AttentionBannerSettleRequestSchema: z.ZodType<
  AttentionBannerSettleRequest,
  AttentionBannerSettleRequest
> = z
  .object({
    entryId: attentionIdSchema("AttentionBannerSettleRequest.entryId"),
    state: z.enum(["posted", "withheld", "withdrawn"]),
  })
  .strict();

/**
 * Marks a session seen: its finished and failed entries stop reading as unseen,
 * in the notifications list and on the session's row alike. Opening the session
 * sends it.
 */
export interface AttentionSeenUpdateRequest {
  sessionId: SessionId;
}
/** Parses an {@link AttentionSeenUpdateRequest}. */
export const AttentionSeenUpdateRequestSchema: z.ZodType<
  AttentionSeenUpdateRequest,
  AttentionSeenUpdateRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

// Delivery beyond this machine: the web address and the email digest

const ATTENTION_DELIVERY_CHANNEL_VALUES = ["webAddress", "emailDigest"] as const;

/** The two ways a moment leaves the machine. */
export type AttentionDeliveryChannel = (typeof ATTENTION_DELIVERY_CHANNEL_VALUES)[number];

const ATTENTION_DELIVERY_RESULT_VALUES = [
  "delivered",
  "refused",
  "unreachable",
  "timedOut",
  "signInRefused",
  "notEncrypted",
  "notAnAddress",
] as const;

/**
 * How one delivery attempt ended: accepted; refused by the address; no answer;
 * no answer in time; the mail server refused the sign-in; the mail server
 * would not encrypt, so nothing was sent; or a test of saved web-address text
 * with no scheme and host, so nothing was sent.
 */
export type AttentionDeliveryResult = (typeof ATTENTION_DELIVERY_RESULT_VALUES)[number];

/**
 * A channel's last attempt. `httpStatus` is the address's answer where it gave
 * one; `undelivered` counts the messages given up on since the last delivery.
 */
export interface AttentionDeliveryOutcome {
  at: string;
  result: AttentionDeliveryResult;
  httpStatus?: number | undefined;
  undelivered: number;
}
const AttentionDeliveryOutcomeSchema: z.ZodType<AttentionDeliveryOutcome> = z
  .object({
    at: isoDateTimeSchema,
    result: z.enum(ATTENTION_DELIVERY_RESULT_VALUES),
    httpStatus: z.number().int().min(100).max(599).optional(),
    undelivered: countSchema,
  })
  .strict();

/**
 * What each channel last did. The web address is shown back as its host only, and a saved text
 * with no scheme and host has none; neither the address, its signing secret nor the mail
 * password is ever sent.
 */
export interface AttentionDeliveryReadResponse {
  webAddress: {
    saved: boolean;
    host?: string | undefined;
    lastOutcome: AttentionDeliveryOutcome | null;
  };
  emailDigest: {
    passwordSaved: boolean;
    lastOutcome: AttentionDeliveryOutcome | null;
  };
}
/** Parses an {@link AttentionDeliveryReadResponse}; `host` is present only when an address is saved. */
export const AttentionDeliveryReadResponseSchema: z.ZodType<AttentionDeliveryReadResponse> = z
  .object({
    webAddress: z
      .object({
        saved: z.boolean(),
        host: z.string().min(1).optional(),
        lastOutcome: AttentionDeliveryOutcomeSchema.nullable(),
      })
      .strict()
      .refine((webAddress) => webAddress.saved || webAddress.host === undefined, {
        message: "host is present only when an address is saved.",
        path: ["host"],
      }),
    emailDigest: z
      .object({
        passwordSaved: z.boolean(),
        lastOutcome: AttentionDeliveryOutcomeSchema.nullable(),
      })
      .strict(),
  })
  .strict();

/** Sends one test message on a channel. */
export interface AttentionDeliveryTestRequest {
  channel: AttentionDeliveryChannel;
}
/** Parses an {@link AttentionDeliveryTestRequest}. */
export const AttentionDeliveryTestRequestSchema: z.ZodType<
  AttentionDeliveryTestRequest,
  AttentionDeliveryTestRequest
> = z.object({ channel: z.enum(ATTENTION_DELIVERY_CHANNEL_VALUES) }).strict();

/** How the test ended. */
export interface AttentionDeliveryTestResponse {
  outcome: AttentionDeliveryOutcome;
}
/** Parses an {@link AttentionDeliveryTestResponse}. */
export const AttentionDeliveryTestResponseSchema: z.ZodType<AttentionDeliveryTestResponse> = z
  .object({ outcome: AttentionDeliveryOutcomeSchema })
  .strict();

/** The longest mail password or web address the daemon accepts. */
export const ATTENTION_DELIVERY_SECRET_MAX_LEN = 8192;

/** Saves the mail account's password. Write-only: it is sealed and never sent back. */
export interface AttentionMailPasswordSaveRequest {
  password: string;
}
/** Parses an {@link AttentionMailPasswordSaveRequest}. */
export const AttentionMailPasswordSaveRequestSchema: z.ZodType<
  AttentionMailPasswordSaveRequest,
  AttentionMailPasswordSaveRequest
> = z
  .object({
    password: wireFreeFormString(
      ATTENTION_DELIVERY_SECRET_MAX_LEN,
      "AttentionMailPasswordSaveRequest.password",
    ),
  })
  .strict();

/**
 * Saves the web address, a secret because chat services put their token in it. Whatever is typed
 * is saved as typed; a text that is not an address is kept, and each message to it fails and is
 * counted as undelivered.
 */
export interface AttentionWebAddressSaveRequest {
  address: string;
}
/** Parses an {@link AttentionWebAddressSaveRequest}. */
export const AttentionWebAddressSaveRequestSchema: z.ZodType<
  AttentionWebAddressSaveRequest,
  AttentionWebAddressSaveRequest
> = z
  .object({
    address: wireFreeFormString(
      ATTENTION_DELIVERY_SECRET_MAX_LEN,
      "AttentionWebAddressSaveRequest.address",
    ),
  })
  .strict();

/**
 * The saved address's host, absent for a text with no scheme and host, and on the first save the
 * signing secret the receiver checks each message with, shown this once.
 */
export interface AttentionWebAddressSaveResponse {
  host?: string | undefined;
  signingSecret?: string | undefined;
}
/** Parses an {@link AttentionWebAddressSaveResponse}. */
export const AttentionWebAddressSaveResponseSchema: z.ZodType<AttentionWebAddressSaveResponse> = z
  .object({ host: z.string().min(1).optional(), signingSecret: z.string().min(1).optional() })
  .strict();

/** A new signing secret, shown this once; the old one stops verifying at once. */
export interface AttentionWebAddressSecretRotateResponse {
  signingSecret: string;
}
/** Parses an {@link AttentionWebAddressSecretRotateResponse}. */
export const AttentionWebAddressSecretRotateResponseSchema: z.ZodType<AttentionWebAddressSecretRotateResponse> =
  z.object({ signingSecret: z.string().min(1) }).strict();

// Refusal codes

/** The keychain holding the delivery secrets could not be used. */
export type AttentionDeliveryStoreUnavailableCode = "attention.delivery_store_unavailable";
/**
 * Error code for a keychain that could not be used for the delivery secrets.
 *
 * @consumedBy the handler that returns the `attention.delivery_store_unavailable` error
 */
export const ATTENTION_DELIVERY_STORE_UNAVAILABLE_CODE: AttentionDeliveryStoreUnavailableCode =
  "attention.delivery_store_unavailable";

/**
 * The details {@link ATTENTION_DELIVERY_STORE_UNAVAILABLE_CODE} carries: why the keychain could
 * not be used.
 */
export interface AttentionDeliveryStoreUnavailableDetails {
  cause: KeychainRefusalCause;
}
/**
 * Parses an {@link AttentionDeliveryStoreUnavailableDetails}.
 *
 * @consumedBy the handler that returns the `attention.delivery_store_unavailable` error
 */
export const AttentionDeliveryStoreUnavailableDetailsSchema: z.ZodType<AttentionDeliveryStoreUnavailableDetails> =
  z.object({ cause: KeychainRefusalCauseSchema }).strict();

/** A test was asked of a channel that is not set up. */
export type AttentionDeliveryNotConfiguredCode = "attention.delivery_not_configured";
/**
 * Error code for a delivery test asked of a channel that is not set up.
 *
 * @consumedBy the handler that returns the `attention.delivery_not_configured` error
 */
export const ATTENTION_DELIVERY_NOT_CONFIGURED_CODE: AttentionDeliveryNotConfiguredCode =
  "attention.delivery_not_configured";

const ATTENTION_DELIVERY_MISSING_VALUES = ["address", "password"] as const;

/** What is missing: the web address, or the mail password. */
export type AttentionDeliveryMissing = (typeof ATTENTION_DELIVERY_MISSING_VALUES)[number];

/** The details {@link ATTENTION_DELIVERY_NOT_CONFIGURED_CODE} carries. */
export interface AttentionDeliveryNotConfiguredDetails {
  missing: AttentionDeliveryMissing;
}
/**
 * Parses an {@link AttentionDeliveryNotConfiguredDetails}.
 *
 * @consumedBy the handler that returns the `attention.delivery_not_configured` error
 */
export const AttentionDeliveryNotConfiguredDetailsSchema: z.ZodType<AttentionDeliveryNotConfiguredDetails> =
  z.object({ missing: z.enum(ATTENTION_DELIVERY_MISSING_VALUES) }).strict();

// The method table

/** The `attention.*` methods the daemon serves. */
export interface AttentionMethodDescriptors {
  /**
   * The machine-wide attention projection, served live: the whole projection first,
   * then the whole projection again on every change.
   */
  readonly "attention.projectionRead": SubscriptionMethodDescriptor<
    "attention.projectionRead",
    EmptyPayload,
    SubscribeAckResponse,
    AttentionProjection
  >;
  readonly "attention.bannerSettle": MethodDescriptor<
    "attention.bannerSettle",
    AttentionBannerSettleRequest,
    EmptyPayload
  >;
  readonly "attention.seenUpdate": MethodDescriptor<
    "attention.seenUpdate",
    AttentionSeenUpdateRequest,
    EmptyPayload
  >;
  readonly "attention.deliveryRead": MethodDescriptor<
    "attention.deliveryRead",
    EmptyPayload,
    AttentionDeliveryReadResponse
  >;
  readonly "attention.deliveryTest": MethodDescriptor<
    "attention.deliveryTest",
    AttentionDeliveryTestRequest,
    AttentionDeliveryTestResponse
  >;
  readonly "attention.mailPasswordSave": MethodDescriptor<
    "attention.mailPasswordSave",
    AttentionMailPasswordSaveRequest,
    EmptyPayload
  >;
  readonly "attention.mailPasswordRemove": MethodDescriptor<
    "attention.mailPasswordRemove",
    EmptyPayload,
    EmptyPayload
  >;
  readonly "attention.webAddressSave": MethodDescriptor<
    "attention.webAddressSave",
    AttentionWebAddressSaveRequest,
    AttentionWebAddressSaveResponse
  >;
  readonly "attention.webAddressSecretRotate": MethodDescriptor<
    "attention.webAddressSecretRotate",
    EmptyPayload,
    AttentionWebAddressSecretRotateResponse
  >;
  readonly "attention.webAddressRemove": MethodDescriptor<
    "attention.webAddressRemove",
    EmptyPayload,
    EmptyPayload
  >;
}

/**
 * The `attention.*` methods' names, procedure types and shapes.
 *
 * @consumedBy the daemon's `attention.*` handlers
 */
export const ATTENTION_METHOD_DESCRIPTORS: AttentionMethodDescriptors = defineMethodDescriptors({
  "attention.projectionRead": {
    method: "attention.projectionRead",
    procedureType: "subscription",
    mutating: false,
    requestSchema: EmptyPayloadSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: AttentionProjectionSchema,
  },
  "attention.bannerSettle": {
    method: "attention.bannerSettle",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionBannerSettleRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "attention.seenUpdate": {
    method: "attention.seenUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionSeenUpdateRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "attention.deliveryRead": {
    method: "attention.deliveryRead",
    procedureType: "query",
    mutating: false,
    requestSchema: EmptyPayloadSchema,
    responseSchema: AttentionDeliveryReadResponseSchema,
  },
  "attention.deliveryTest": {
    method: "attention.deliveryTest",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionDeliveryTestRequestSchema,
    responseSchema: AttentionDeliveryTestResponseSchema,
  },
  "attention.mailPasswordSave": {
    method: "attention.mailPasswordSave",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionMailPasswordSaveRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "attention.mailPasswordRemove": {
    method: "attention.mailPasswordRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: EmptyPayloadSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "attention.webAddressSave": {
    method: "attention.webAddressSave",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionWebAddressSaveRequestSchema,
    responseSchema: AttentionWebAddressSaveResponseSchema,
  },
  "attention.webAddressSecretRotate": {
    method: "attention.webAddressSecretRotate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: EmptyPayloadSchema,
    responseSchema: AttentionWebAddressSecretRotateResponseSchema,
  },
  "attention.webAddressRemove": {
    method: "attention.webAddressRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: EmptyPayloadSchema,
    responseSchema: EmptyPayloadSchema,
  },
});
