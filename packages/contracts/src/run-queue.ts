// The message queue: every message the person sends waits here until the agent takes it at its
// next step. The lead has one queue and each child its own; every queue verb but the send takes
// `childHandle` to reach a child's queue, whose messages arrive through `run.childSteer`.
import { z } from "zod";

import { ChildHandleSchema, type ChildHandle } from "./agent.js";
import { brandedUuidIdSchema } from "./internal/branded.js";
import { ArtifactIdSchema, type ArtifactId } from "./provider-driver.js";
import { DRIVER_WIRE_REASON_MAX_LEN } from "./provider-driver-wire.js";
import { WorkspaceIdSchema, type WorkspaceId } from "./repo.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  wireUncappedFreeFormString,
  type SessionId,
} from "./session.js";

/** Identifies one queued message. */
export type QueueItemId = string & { readonly __brand: "QueueItemId" };
/** Parses a {@link QueueItemId}. */
export const QueueItemIdSchema: z.ZodType<QueueItemId, QueueItemId> =
  brandedUuidIdSchema<QueueItemId>("QueueItemId");

/** Where a queued message stands: waiting, sent to the run, replaced, canceled, or never sent. */
export type QueueItemState = "queued" | "admitted" | "superseded" | "canceled" | "not_delivered";
/** Parses a {@link QueueItemState}. */
export const QueueItemStateSchema: z.ZodType<QueueItemState, QueueItemState> = z.enum([
  "queued",
  "admitted",
  "superseded",
  "canceled",
  "not_delivered",
]);

// The words and files of a message the person sends. The files are artifact ids in staging order;
// how many a message carries is what the daemon and the provider accept, never a count of ours.
const messageContentSchema = (fieldLabel: string): z.ZodString =>
  wireUncappedFreeFormString(fieldLabel);
const messageAttachmentsSchema: z.ZodType<ArtifactId[], ArtifactId[]> = z.array(ArtifactIdSchema);

// run.queueCreate

/**
 * Sends one message to the lead, whether a turn is running or not. `to` addresses
 * another session instead: the message arrives there as that session's own row.
 * `replacesQueueItemId` is an edit of a waiting message, made in place in one
 * call, so the edited message keeps its place and the old item reads
 * `superseded`; the daemon refuses it once the agent has taken the message.
 * `clientIdempotencyKey` replays the first answer for a retried send.
 *
 * `workspaceId` binds the run a send starts to its repository, and `priority`
 * orders the stored items; neither reorders what the person sees, which is the
 * daemon's order (`run.queueReorder`).
 */
export interface QueueItemCreateRequest {
  sessionId: SessionId;
  to?: SessionId | undefined;
  workspaceId?: WorkspaceId | undefined;
  priority?: number | undefined;
  clientIdempotencyKey: string;
  content: string;
  attachments?: ArtifactId[] | undefined;
  replacesQueueItemId?: QueueItemId | undefined;
}
/** Parses a {@link QueueItemCreateRequest}. */
export const QueueItemCreateRequestSchema: z.ZodType<
  QueueItemCreateRequest,
  QueueItemCreateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    to: SessionIdSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
    // Whole, because the stored column is an integer; a negative de-prioritizes, so no floor.
    priority: z.number().int().optional(),
    clientIdempotencyKey: z.uuid(),
    content: messageContentSchema("QueueItemCreateRequest.content"),
    attachments: messageAttachmentsSchema.optional(),
    replacesQueueItemId: QueueItemIdSchema.optional(),
  })
  .strict();

/** The queued message, as a send or a child's steer answers. */
export interface QueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  createdAt: string;
}
/** Parses a {@link QueueItemCreateResponse}. */
export const QueueItemCreateResponseSchema: z.ZodType<QueueItemCreateResponse> = z
  .object({
    queueItemId: QueueItemIdSchema,
    state: QueueItemStateSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// run.queueList and run.subscribeQueue

/** Reads a queue, the lead's or, with `childHandle`, a child's, in the daemon's order. */
export interface QueueItemListRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle | undefined;
  state?: QueueItemState | undefined;
}
/** Parses a {@link QueueItemListRequest}. */
export const QueueItemListRequestSchema: z.ZodType<QueueItemListRequest, QueueItemListRequest> = z
  .object({
    sessionId: SessionIdSchema,
    childHandle: ChildHandleSchema.optional(),
    state: QueueItemStateSchema.optional(),
  })
  .strict();

/**
 * One queued message, as a pending row draws it: its words and files, the child
 * whose queue holds it (absent on the lead's), and, once its delivery has failed,
 * the daemon's reason.
 */
export interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  priority: number;
  content: string;
  attachments?: ArtifactId[] | undefined;
  childHandle?: ChildHandle | undefined;
  notDeliveredReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
}
/** Parses a {@link QueueItemSummary}; only a not-delivered item carries a reason. */
export const QueueItemSummarySchema: z.ZodType<QueueItemSummary> = z
  .object({
    id: QueueItemIdSchema,
    state: QueueItemStateSchema,
    priority: z.number().int(),
    content: messageContentSchema("QueueItemSummary.content"),
    attachments: messageAttachmentsSchema.optional(),
    childHandle: ChildHandleSchema.optional(),
    notDeliveredReason: wireFreeFormString(
      DRIVER_WIRE_REASON_MAX_LEN,
      "QueueItemSummary.notDeliveredReason",
    ).optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((item) => (item.state === "not_delivered") === (item.notDeliveredReason !== undefined), {
    path: ["notDeliveredReason"],
    message: "A not-delivered message carries its reason, and only a not-delivered one does.",
  });

/** A queue's items in the daemon's order. */
export interface QueueItemListResponse {
  items: QueueItemSummary[];
}
/** Parses a {@link QueueItemListResponse}. */
export const QueueItemListResponseSchema: z.ZodType<QueueItemListResponse> = z
  .object({ items: z.array(QueueItemSummarySchema) })
  .strict();

/**
 * Opens a queue's stream, the lead's or, with `childHandle`, a child's.
 * Session-scoped, with no replay cursor.
 */
export interface RunQueueSubscribeRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle | undefined;
}
/** Parses a {@link RunQueueSubscribeRequest}. */
export const RunQueueSubscribeRequestSchema: z.ZodType<
  RunQueueSubscribeRequest,
  RunQueueSubscribeRequest
> = z.object({ sessionId: SessionIdSchema, childHandle: ChildHandleSchema.optional() }).strict();

// run.queueCancel and run.queueReorder

/** Removes a waiting message, from the lead's queue or, with `childHandle`, a child's. */
export interface QueueItemCancelRequest {
  queueItemId: QueueItemId;
  childHandle?: ChildHandle | undefined;
}
/** Parses a {@link QueueItemCancelRequest}. */
export const QueueItemCancelRequestSchema: z.ZodType<
  QueueItemCancelRequest,
  QueueItemCancelRequest
> = z
  .object({ queueItemId: QueueItemIdSchema, childHandle: ChildHandleSchema.optional() })
  .strict();

/** The canceled message. */
export interface QueueItemCancelResponse {
  queueItemId: QueueItemId;
  state: "canceled";
}
/** Parses a {@link QueueItemCancelResponse}. */
export const QueueItemCancelResponseSchema: z.ZodType<QueueItemCancelResponse> = z
  .object({
    queueItemId: QueueItemIdSchema,
    state: z.literal("canceled"),
  })
  .strict();

/**
 * Puts a queue's waiting messages in a new order: the full order, naming each
 * waiting item once. The daemon refuses a list that does not name exactly the
 * items still waiting, and answers the queue in its new order.
 */
export interface QueueReorderRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle | undefined;
  queueItemIds: QueueItemId[];
}
/** Parses a {@link QueueReorderRequest}; each item is named once. */
export const QueueReorderRequestSchema: z.ZodType<QueueReorderRequest, QueueReorderRequest> = z
  .object({
    sessionId: SessionIdSchema,
    childHandle: ChildHandleSchema.optional(),
    queueItemIds: z.array(QueueItemIdSchema).min(1),
  })
  .strict()
  .refine((request) => new Set(request.queueItemIds).size === request.queueItemIds.length, {
    path: ["queueItemIds"],
    message: "A new order names each waiting message once.",
  });

/**
 * The refusal of a change to a waiting message: an edit of a message the agent
 * has already taken, or a reorder whose list is not exactly the waiting items.
 */
export const QUEUE_CHANGE_REFUSED_CODE = "queue.change_refused" as const;
/** The type of {@link QUEUE_CHANGE_REFUSED_CODE}. */
export type QueueChangeRefusedCode = typeof QUEUE_CHANGE_REFUSED_CODE;

/** Why a change to a waiting message was refused. */
export type QueueChangeRefusedReason = "already_taken" | "order_mismatch";
/** Every {@link QueueChangeRefusedReason}. */
export const QUEUE_CHANGE_REFUSED_REASONS: readonly QueueChangeRefusedReason[] = Object.freeze([
  "already_taken",
  "order_mismatch",
]);

/** The details a `queue.change_refused` refusal carries. */
export interface QueueChangeRefusedDetails {
  reason: QueueChangeRefusedReason;
}
/** Parses {@link QueueChangeRefusedDetails}. */
export const QueueChangeRefusedDetailsSchema: z.ZodType<QueueChangeRefusedDetails> = z
  .object({ reason: z.enum(QUEUE_CHANGE_REFUSED_REASONS) })
  .strict();
