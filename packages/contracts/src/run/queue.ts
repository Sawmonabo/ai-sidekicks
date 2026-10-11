// The message queue: every message the person sends waits here until the agent takes it at its
// next step. The lead has one queue and each child its own; every queue verb but the send takes
// `childHandle` to reach a child's queue, whose messages arrive through `run.childSteer`. Also the
// `queue_item.*` event payloads and the frame `run.subscribeQueue` sends.
import { z } from "zod";

import { providerTokenSchema } from "../agent/definition.js";
import { ChildHandleSchema, type ChildHandle } from "../agent/tree.js";
import { EVENT_FIELD_MAX_LEN } from "../event/version.js";
import { brandedUuidIdSchema } from "../internal/branded.js";
import { AttachmentReferenceListSchema } from "../artifacts/attachment-reference.js";
import type { ArtifactId } from "../artifacts/id.js";
import { RunIdSchema, type RunId } from "./id.js";
import { QuestionIdSchema, type QuestionId } from "../question.js";
import { WorkspaceIdSchema, type WorkspaceId } from "../repo/mount.js";
import {
  FILE_PATH_MAX_LEN,
  wireFreeFormString,
  wireUncappedFreeFormString,
} from "../free-form-string.js";
import { StreamFrameSchema, type StreamFrame } from "../jsonrpc/streaming.js";
import type { EventCursor } from "../session/event-cursor.js";
import { EventCursorSchema, SessionIdSchema, type SessionId } from "../session/id.js";
import { DeviceIdSchema, type DeviceId } from "../trust-statement.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";
import { MessageOriginSchema, type MessageOrigin } from "../voice.js";

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

/**
 * Why a taken message was never delivered: it waited past the daemon's own delivery timeout, or its
 * delivery failed outright. Either way it can be sent again.
 */
export type QueueItemNotDeliveredReason = "timed_out" | "failed";
const QueueItemNotDeliveredReasonSchema: z.ZodType<
  QueueItemNotDeliveredReason,
  QueueItemNotDeliveredReason
> = z.enum(["timed_out", "failed"]);

// The words of a message the person sends.
const messageContentSchema = (fieldLabel: string): z.ZodString =>
  wireUncappedFreeFormString(fieldLabel);

// run.queueCreate

/** Sends one message to the lead, whether a turn is running or not. */
export interface QueueItemCreateRequest {
  sessionId: SessionId;
  /** Another session to deliver to instead; the message arrives there as its own row. */
  to?: SessionId | undefined;
  /** Binds the run a send starts to its repository. */
  workspaceId?: WorkspaceId | undefined;
  /** A retried send with the same key returns the saved result. */
  clientIdempotencyKey: string;
  content: string;
  /** The message's files in staging order; one the daemon cannot deliver stays, marked. */
  attachments?: ArtifactId[] | undefined;
  /**
   * Each skill picked from the composer's `/` and `$` list, in the order picked, its name and
   * folder as `skill.list` gives them. The daemon refuses a pick a Codex session's own list does not
   * name in that folder (`skill.path_refused`, `not_listed`).
   */
  skills?: QueuedSkillPick[] | undefined;
  /**
   * Edits this waiting message in place: it keeps its place and the old item reads `superseded`.
   * Refused once the agent has taken it.
   */
  replacesQueueItemId?: QueueItemId | undefined;
  /**
   * The question this send answers, a question the agent does not wait for. The daemon copies it
   * onto the `user.message` row it writes, which marks the question answered.
   */
  answersQuestionId?: QuestionId | undefined;
  /**
   * The output-speed level this send's turn alone runs at, the agent's own level staying as it is:
   * `Use standard` on a turn that failed for want of flex capacity sends the same words again with
   * the provider's standard level here.
   */
  outputSpeedForTurn?: string | undefined;
}

/**
 * One skill a send picked: its front-matter name and its folder, as `skill.list` gives them. A
 * Codex agent's skill input names the `SKILL.md` path Codex lists for that name in that folder.
 */
export interface QueuedSkillPick {
  name: string;
  folderPath: string;
}
const QueuedSkillPickSchema: z.ZodType<QueuedSkillPick, QueuedSkillPick> = z
  .object({
    name: wireFreeFormString(FILE_PATH_MAX_LEN, "QueuedSkillPick.name"),
    folderPath: wireFreeFormString(FILE_PATH_MAX_LEN, "QueuedSkillPick.folderPath"),
  })
  .strict();
/** Parses a {@link QueueItemCreateRequest}. */
export const QueueItemCreateRequestSchema: z.ZodType<
  QueueItemCreateRequest,
  QueueItemCreateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    to: SessionIdSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
    clientIdempotencyKey: z.uuid(),
    content: messageContentSchema("QueueItemCreateRequest.content"),
    attachments: AttachmentReferenceListSchema.optional(),
    skills: z.array(QueuedSkillPickSchema).optional(),
    replacesQueueItemId: QueueItemIdSchema.optional(),
    answersQuestionId: QuestionIdSchema.optional(),
    outputSpeedForTurn: providerTokenSchema("QueueItemCreateRequest.outputSpeedForTurn").optional(),
  })
  .strict();

/**
 * The `user.message` payload: the person's message as a transcript row, written when the daemon
 * accepts the send. `origin` marks the words a voice call heard; `answersQuestionId` names the
 * question a message answers, which is that question's answered mark, and is absent on every
 * other message; `deviceId` is the device that sent it.
 */
export type UserMessagePayload = {
  sessionId: SessionId;
  queueItemId?: QueueItemId | undefined;
  runId?: RunId | undefined;
  /** Repeats the envelope's actor. */
  actor: string;
  deviceId?: DeviceId | undefined;
  message: string;
  origin?: MessageOrigin | undefined;
  answersQuestionId?: QuestionId | undefined;
};
/** Parses a {@link UserMessagePayload}. */
export const UserMessagePayloadSchema: z.ZodType<UserMessagePayload, UserMessagePayload> = z
  .object({
    sessionId: SessionIdSchema,
    queueItemId: QueueItemIdSchema.optional(),
    runId: RunIdSchema.optional(),
    actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "UserMessagePayload.actor"),
    deviceId: DeviceIdSchema.optional(),
    message: messageContentSchema("UserMessagePayload.message"),
    origin: MessageOriginSchema.optional(),
    answersQuestionId: QuestionIdSchema.optional(),
  })
  .strict();

// The members each `queue_item.*` event adds, keyed by the state it records: an admitted item
// names the run that took it, which can differ from the run its `user.message` was sent toward, a
// superseded one names the item that replaced it, and a not-delivered one says why. The words stay
// on `user.message`.
interface QueueItemEventMembersByState {
  queued: Record<never, never>;
  admitted: { runId: RunId };
  superseded: { replacedByQueueItemId: QueueItemId };
  canceled: Record<never, never>;
  not_delivered: { notDeliveredReason: QueueItemNotDeliveredReason };
}

/**
 * The payload of a `queue_item.*` event: the item and the state it entered, `queued` on
 * `queue_item.created` and the event's own state on the other four.
 */
export type QueueItemEventPayload<TState extends QueueItemState> = {
  sessionId: SessionId;
  queueItemId: QueueItemId;
  state: TState;
} & QueueItemEventMembersByState[TState];

const buildQueueItemEventPayloadSchema = <
  TState extends QueueItemState,
  TStateShape extends z.ZodRawShape,
>(
  state: TState,
  stateShape: TStateShape,
) =>
  z
    .object({
      sessionId: SessionIdSchema,
      queueItemId: QueueItemIdSchema,
      state: z.literal(state),
      ...stateShape,
    })
    .strict();

/**
 * Parses each `queue_item.*` payload, keyed by the state it records; each refuses another `state`
 * and the members of another event.
 */
export const QUEUE_ITEM_EVENT_PAYLOAD_SCHEMAS: {
  readonly [TState in QueueItemState]: z.ZodType<
    QueueItemEventPayload<TState>,
    QueueItemEventPayload<TState>
  >;
} = {
  queued: buildQueueItemEventPayloadSchema("queued", {}),
  admitted: buildQueueItemEventPayloadSchema("admitted", { runId: RunIdSchema }),
  superseded: buildQueueItemEventPayloadSchema("superseded", {
    replacedByQueueItemId: QueueItemIdSchema,
  }),
  canceled: buildQueueItemEventPayloadSchema("canceled", {}),
  not_delivered: buildQueueItemEventPayloadSchema("not_delivered", {
    notDeliveredReason: QueueItemNotDeliveredReasonSchema,
  }),
};

// Only a not-delivered message carries a reason, and it always does.
function hasReasonOnlyWhenNotDelivered(item: {
  readonly state: QueueItemState;
  readonly notDeliveredReason?: QueueItemNotDeliveredReason | undefined;
}): boolean {
  return (item.state === "not_delivered") === (item.notDeliveredReason !== undefined);
}

const NOT_DELIVERED_REASON_ISSUE = {
  path: ["notDeliveredReason"],
  message: "A not-delivered message carries its reason, and only a not-delivered one does.",
};

/**
 * The queued message, as a send or a child's steer answers, and, when a retry answers one whose
 * delivery failed, the daemon's reason.
 */
export interface QueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  notDeliveredReason?: QueueItemNotDeliveredReason | undefined;
  createdAt: string;
}
/** Parses a {@link QueueItemCreateResponse}; only a not-delivered item carries a reason. */
export const QueueItemCreateResponseSchema: z.ZodType<QueueItemCreateResponse> = z
  .object({
    queueItemId: QueueItemIdSchema,
    state: QueueItemStateSchema,
    notDeliveredReason: QueueItemNotDeliveredReasonSchema.optional(),
    createdAt: isoDateTimeSchema,
  })
  .strict()
  .refine(hasReasonOnlyWhenNotDelivered, NOT_DELIVERED_REASON_ISSUE);

// run.queueList and run.subscribeQueue

/**
 * Reads a queue, the lead's or, with `childHandle`, a child's, in the daemon's order: the items in
 * `state` when it is given, else every item waiting or not delivered.
 */
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
 * One queued message, as a pending row draws it: its words and files, its place in its queue's
 * order (lowest first, an edit taking the place of the message it replaced), the child whose queue
 * holds it (absent on the lead's), and, once its delivery has failed, the daemon's reason.
 */
export interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  position: number;
  content: string;
  attachments?: ArtifactId[] | undefined;
  childHandle?: ChildHandle | undefined;
  notDeliveredReason?: QueueItemNotDeliveredReason | undefined;
  createdAt: string;
  updatedAt: string;
}
/** Parses a {@link QueueItemSummary}; only a not-delivered item carries a reason. */
export const QueueItemSummarySchema: z.ZodType<QueueItemSummary> = z
  .object({
    id: QueueItemIdSchema,
    state: QueueItemStateSchema,
    position: countSchema,
    content: messageContentSchema("QueueItemSummary.content"),
    attachments: AttachmentReferenceListSchema.optional(),
    childHandle: ChildHandleSchema.optional(),
    notDeliveredReason: QueueItemNotDeliveredReasonSchema.optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .refine(hasReasonOnlyWhenNotDelivered, NOT_DELIVERED_REASON_ISSUE);

/** A queue's items in the daemon's order. */
export interface QueueItemListResponse {
  items: QueueItemSummary[];
}
/** Parses a {@link QueueItemListResponse}. */
export const QueueItemListResponseSchema: z.ZodType<QueueItemListResponse> = z
  .object({ items: z.array(QueueItemSummarySchema) })
  .strict();

/**
 * One change on a queue's stream: the item as it now stands, and the cursor of the `queue_item.*`
 * event that changed it, or, for a reorder, which no event records, the session's newest cursor
 * when the change went out.
 */
export interface RunQueueStreamChange {
  readonly cursor: EventCursor;
  readonly item: QueueItemSummary;
}

/** One notify of `run.subscribeQueue`: a batch of changes, or the caught-up frame after a drop. */
export type RunQueueStreamFrame = StreamFrame<RunQueueStreamChange, EventCursor>;
/** Parses a {@link RunQueueStreamFrame}. */
export const RunQueueStreamFrameSchema: z.ZodType<RunQueueStreamFrame> = StreamFrameSchema(
  z.object({ cursor: EventCursorSchema, item: QueueItemSummarySchema }).strict(),
  EventCursorSchema,
);

/**
 * Opens a queue's stream, the lead's or, with `childHandle`, a child's. With `afterCursor`, the
 * stream first sends each item that changed after that cursor and every item still waiting, as it
 * now stands, then follows live; without it, the stream follows from now.
 */
export interface RunQueueSubscribeRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle | undefined;
  afterCursor?: EventCursor | undefined;
}
/** Parses a {@link RunQueueSubscribeRequest}. */
export const RunQueueSubscribeRequestSchema: z.ZodType<
  RunQueueSubscribeRequest,
  RunQueueSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    childHandle: ChildHandleSchema.optional(),
    afterCursor: EventCursorSchema.optional(),
  })
  .strict();

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
 * The refusal of a send while the daemon cannot store the queue: nothing is queued, and the send
 * can be made again once the store is back.
 */
export const QUEUE_PERSISTENCE_UNAVAILABLE_CODE = "queue.persistence_unavailable" as const;

/**
 * The refusal of a send whose session's lead run started, ended or was continued between each
 * read and the write that sends into it, every time the daemon tried: nothing is queued, and the
 * send can be made again.
 */
export const QUEUE_RUN_CHANGED_CODE = "queue.run_changed" as const;

/**
 * The refusal of a change naming a queue item the queue does not hold: an id it never stored, an
 * item of another session, or one of another queue than the change names.
 */
export const QUEUE_ITEM_NOT_FOUND_CODE = "queue.item_not_found" as const;

/**
 * The refusal of a change to a waiting message: an edit or removal of a message the agent has
 * already taken, an edit or removal of one the provider did not give back, which then reads not
 * delivered, or a reorder whose list is not exactly the waiting items.
 */
export const QUEUE_CHANGE_REFUSED_CODE = "queue.change_refused" as const;

/** Why a change to a waiting message was refused. */
export type QueueChangeRefusedReason = "already_taken" | "not_delivered" | "order_mismatch";

/** The details a `queue.change_refused` refusal carries. */
export interface QueueChangeRefusedDetails {
  reason: QueueChangeRefusedReason;
}
