// The attention projection (machine-wide, whole on every emission) and the `attention.*`
// methods: banner settling, seen marking, and delivery by web address or email digest,
// whose secrets the daemon seals and never sends back.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";
import { WorkflowNodeIdSchema, type WorkflowNodeId } from "./workflow-definition.js";

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
/** Every {@link AttentionBannerState}. */
export const ATTENTION_BANNER_STATES: readonly AttentionBannerState[] =
  ATTENTION_BANNER_STATE_VALUES;

/**
 * The longest id an attention entry carries: its own, its moment's, its run's and its
 * source event's. The daemon mints each of them.
 */
export const ATTENTION_ID_MAX_LEN = 256;

const attentionIdSchema = (fieldLabel: string): z.ZodString =>
  wireFreeFormString(ATTENTION_ID_MAX_LEN, fieldLabel);

/**
 * One attention item, run-scoped or the session-scoped aggregate. Scope is read off
 * `runId`: present means run-scoped, absent means the session aggregate.
 *
 * `momentId` is the stable id of the session or run and the state it is in, so a later
 * state (`Finished` after `Waiting on you`) replaces the operating-system banner in place.
 * A Notify step's moment comes from the run, the node and which execution of the node it
 * was. `stateWord` is what the line reads after `displayName` (`Waiting on you`, `Finished`,
 * `Failed`, or a Notify step's own notice text). `summary` is never a banner's body: a
 * banner says the name and the state, not what was said. `stepId` names the Notify node
 * on a `workflow_notify` item and is absent on every other; `seen` is the one seen-or-unseen
 * fact the daemon keeps, which the session's row reads too.
 */
export interface AttentionItem {
  readonly id: string;
  readonly momentId: string;
  readonly sessionId: string;
  /** Present on a run-scoped item; absent on the session-scoped aggregate. */
  readonly runId?: string | undefined;
  readonly trigger: AttentionTrigger;
  readonly severity: AttentionSeverity;
  readonly displayName: string;
  readonly stateWord: string;
  readonly stepId?: WorkflowNodeId | undefined;
  /** One line a surface renders. Prose, not an identifier. */
  readonly summary: string;
  /** The canonical event that triggered this item. */
  readonly sourceEventId: string;
  readonly createdAt: string;
  /** Set once the state that produced the item resolves; absent means outstanding. */
  readonly resolvedAt?: string | undefined;
  readonly bannerState: AttentionBannerState;
  readonly seen: boolean;
}

/**
 * Parses an {@link AttentionItem}. A Notify step's item names its step and no other
 * item does, and it is informational and carries its run: it tells the person
 * something and never counts as waiting on them.
 *
 * @consumedBy the attention projector
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
    createdAt: z.iso.datetime({ offset: true }),
    resolvedAt: z.iso.datetime({ offset: true }).optional(),
    bannerState: z.enum(ATTENTION_BANNER_STATE_VALUES),
    seen: z.boolean(),
  })
  .strict()
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

/** A request or a reply that carries nothing. */
export type AttentionEmptyMessage = Record<string, never>;
/** Parses an {@link AttentionEmptyMessage}: an empty object. */
export const AttentionEmptyMessageSchema: z.ZodType<AttentionEmptyMessage, AttentionEmptyMessage> =
  z.object({}).strict();

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
] as const;

/**
 * How one delivery attempt ended: accepted; refused by the address; no answer;
 * no answer in time; the mail server refused the sign-in; or the mail server
 * would not encrypt, so nothing was sent.
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
    at: z.iso.datetime({ offset: true }),
    result: z.enum(ATTENTION_DELIVERY_RESULT_VALUES),
    httpStatus: z.number().int().min(100).max(599).optional(),
    undelivered: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What each channel last did. The web address is shown back as its host only;
 * neither the address, its signing secret nor the mail password is ever sent.
 */
export interface AttentionDeliveryReadResponse {
  webAddress: {
    saved: boolean;
    host: string | null;
    lastOutcome: AttentionDeliveryOutcome | null;
  };
  emailDigest: {
    passwordSaved: boolean;
    lastOutcome: AttentionDeliveryOutcome | null;
  };
}
/** Parses an {@link AttentionDeliveryReadResponse}; `host` is set when an address is saved. */
export const AttentionDeliveryReadResponseSchema: z.ZodType<AttentionDeliveryReadResponse> = z
  .object({
    webAddress: z
      .object({
        saved: z.boolean(),
        host: z.string().min(1).nullable(),
        lastOutcome: AttentionDeliveryOutcomeSchema.nullable(),
      })
      .strict()
      .refine((webAddress) => webAddress.saved === (webAddress.host !== null), {
        message: "host is present exactly when an address is saved.",
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
 * Saves the web address, a secret because chat services put their token in it.
 * The daemon parses it and refuses one it cannot send to with
 * {@link ATTENTION_WEB_ADDRESS_INVALID_CODE}.
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
 * The saved address's host, and on the first save the signing secret the receiver
 * checks each message with, shown this once.
 */
export interface AttentionWebAddressSaveResponse {
  host: string;
  signingSecret?: string | undefined;
}
/** Parses an {@link AttentionWebAddressSaveResponse}. */
export const AttentionWebAddressSaveResponseSchema: z.ZodType<AttentionWebAddressSaveResponse> = z
  .object({ host: z.string().min(1), signingSecret: z.string().min(1).optional() })
  .strict();

/** A new signing secret, shown this once; the old one stops verifying at once. */
export interface AttentionWebAddressSecretRotateResponse {
  signingSecret: string;
}
/** Parses an {@link AttentionWebAddressSecretRotateResponse}. */
export const AttentionWebAddressSecretRotateResponseSchema: z.ZodType<AttentionWebAddressSecretRotateResponse> =
  z.object({ signingSecret: z.string().min(1) }).strict();

// Refusal codes

/** The web address cannot be sent to. */
export type AttentionWebAddressInvalidCode = "attention.web_address_invalid";
/** Error code for a web address the daemon cannot send to. */
export const ATTENTION_WEB_ADDRESS_INVALID_CODE: AttentionWebAddressInvalidCode =
  "attention.web_address_invalid";

const ATTENTION_WEB_ADDRESS_INVALID_REASON_VALUES = [
  "unparseable",
  "notHttps",
  "notPrivateHttp",
] as const;

/**
 * Why: it is not an address; it is neither `https:` nor `http:`; or it is `http:`
 * to a host that is neither this machine nor a private network.
 */
export type AttentionWebAddressInvalidReason =
  (typeof ATTENTION_WEB_ADDRESS_INVALID_REASON_VALUES)[number];
/** Every {@link AttentionWebAddressInvalidReason}. */
export const ATTENTION_WEB_ADDRESS_INVALID_REASONS: readonly AttentionWebAddressInvalidReason[] =
  ATTENTION_WEB_ADDRESS_INVALID_REASON_VALUES;

/** The details {@link ATTENTION_WEB_ADDRESS_INVALID_CODE} carries. Never the address. */
export interface AttentionWebAddressInvalidDetails {
  reason: AttentionWebAddressInvalidReason;
}
/** Parses an {@link AttentionWebAddressInvalidDetails}. */
export const AttentionWebAddressInvalidDetailsSchema: z.ZodType<AttentionWebAddressInvalidDetails> =
  z.object({ reason: z.enum(ATTENTION_WEB_ADDRESS_INVALID_REASON_VALUES) }).strict();

/** The keychain holding the delivery secrets could not be used. */
export type AttentionDeliveryStoreUnavailableCode = "attention.delivery_store_unavailable";
/** Error code for a keychain that could not be used for the delivery secrets. */
export const ATTENTION_DELIVERY_STORE_UNAVAILABLE_CODE: AttentionDeliveryStoreUnavailableCode =
  "attention.delivery_store_unavailable";

const ATTENTION_DELIVERY_STORE_CAUSE_VALUES = ["locked", "unavailable"] as const;

/** Why: the keychain is locked, or the machine has none the service can use. */
export type AttentionDeliveryStoreCause = (typeof ATTENTION_DELIVERY_STORE_CAUSE_VALUES)[number];

/** The details {@link ATTENTION_DELIVERY_STORE_UNAVAILABLE_CODE} carries. */
export interface AttentionDeliveryStoreUnavailableDetails {
  cause: AttentionDeliveryStoreCause;
}
/** Parses an {@link AttentionDeliveryStoreUnavailableDetails}. */
export const AttentionDeliveryStoreUnavailableDetailsSchema: z.ZodType<AttentionDeliveryStoreUnavailableDetails> =
  z.object({ cause: z.enum(ATTENTION_DELIVERY_STORE_CAUSE_VALUES) }).strict();

/** A test was asked of a channel that is not set up. */
export type AttentionDeliveryNotConfiguredCode = "attention.delivery_not_configured";
/** Error code for a delivery test asked of a channel that is not set up. */
export const ATTENTION_DELIVERY_NOT_CONFIGURED_CODE: AttentionDeliveryNotConfiguredCode =
  "attention.delivery_not_configured";

const ATTENTION_DELIVERY_MISSING_VALUES = ["address", "password"] as const;

/** What is missing: the web address, or the mail password. */
export type AttentionDeliveryMissing = (typeof ATTENTION_DELIVERY_MISSING_VALUES)[number];

/** The details {@link ATTENTION_DELIVERY_NOT_CONFIGURED_CODE} carries. */
export interface AttentionDeliveryNotConfiguredDetails {
  missing: AttentionDeliveryMissing;
}
/** Parses an {@link AttentionDeliveryNotConfiguredDetails}. */
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
    AttentionEmptyMessage,
    SubscribeAckResponse,
    AttentionProjection
  >;
  readonly "attention.bannerSettle": MethodDescriptor<
    "attention.bannerSettle",
    AttentionBannerSettleRequest,
    AttentionEmptyMessage
  >;
  readonly "attention.seenUpdate": MethodDescriptor<
    "attention.seenUpdate",
    AttentionSeenUpdateRequest,
    AttentionEmptyMessage
  >;
  readonly "attention.deliveryRead": MethodDescriptor<
    "attention.deliveryRead",
    AttentionEmptyMessage,
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
    AttentionEmptyMessage
  >;
  readonly "attention.mailPasswordRemove": MethodDescriptor<
    "attention.mailPasswordRemove",
    AttentionEmptyMessage,
    AttentionEmptyMessage
  >;
  readonly "attention.webAddressSave": MethodDescriptor<
    "attention.webAddressSave",
    AttentionWebAddressSaveRequest,
    AttentionWebAddressSaveResponse
  >;
  readonly "attention.webAddressSecretRotate": MethodDescriptor<
    "attention.webAddressSecretRotate",
    AttentionEmptyMessage,
    AttentionWebAddressSecretRotateResponse
  >;
  readonly "attention.webAddressRemove": MethodDescriptor<
    "attention.webAddressRemove",
    AttentionEmptyMessage,
    AttentionEmptyMessage
  >;
}

/** The `attention.*` methods' names, procedure types and shapes. */
export const ATTENTION_METHOD_DESCRIPTORS: AttentionMethodDescriptors = defineMethodDescriptors({
  "attention.projectionRead": {
    method: "attention.projectionRead",
    procedureType: "subscription",
    mutating: false,
    requestSchema: AttentionEmptyMessageSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: AttentionProjectionSchema,
  },
  "attention.bannerSettle": {
    method: "attention.bannerSettle",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionBannerSettleRequestSchema,
    responseSchema: AttentionEmptyMessageSchema,
  },
  "attention.seenUpdate": {
    method: "attention.seenUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionSeenUpdateRequestSchema,
    responseSchema: AttentionEmptyMessageSchema,
  },
  "attention.deliveryRead": {
    method: "attention.deliveryRead",
    procedureType: "query",
    mutating: false,
    requestSchema: AttentionEmptyMessageSchema,
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
    responseSchema: AttentionEmptyMessageSchema,
  },
  "attention.mailPasswordRemove": {
    method: "attention.mailPasswordRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionEmptyMessageSchema,
    responseSchema: AttentionEmptyMessageSchema,
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
    requestSchema: AttentionEmptyMessageSchema,
    responseSchema: AttentionWebAddressSecretRotateResponseSchema,
  },
  "attention.webAddressRemove": {
    method: "attention.webAddressRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttentionEmptyMessageSchema,
    responseSchema: AttentionEmptyMessageSchema,
  },
});
