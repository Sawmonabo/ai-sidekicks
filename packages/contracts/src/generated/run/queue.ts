// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The message queue: every message the person sends waits here until the agent takes it at its next step. Also the `agent.queueItem.*` event payloads and the frame `agent.queueItem.subscribe` sends.

import { type CompiledSchemaCheck, deepEqual, ucs2length } from "../../schema-check.js";
import { type ChildHandle, validateChildHandle } from "../agent/tree.js";
import {
  type AttachmentReferenceList,
  validateAttachmentReferenceList,
} from "../artifacts/attachment-reference.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type PlanId, validatePlanId } from "../plan.js";
import { type QuestionId, validateQuestionId } from "../question.js";
import { type WorkspaceId, validateWorkspaceId } from "../repo/mount.js";
import {
  type SessionReviewTarget,
  validateSessionReviewTarget,
} from "../session/controls/methods.js";
import {
  type EventCursor,
  type SessionId,
  validateEventCursor,
  validateSessionId,
} from "../session/id.js";
import { type DeviceId, validateDeviceId } from "../trust-statement.js";
import { type RunId, validateRunId } from "./id.js";

/**
 * The refusal of a send while the daemon cannot store the queue: nothing is queued, and the
 * send can be made again once the store is back.
 */
export const AGENT_QUEUE_ITEM_PERSISTENCE_UNAVAILABLE_CODE =
  "agent.queueItem.persistenceUnavailable" as const;

/**
 * The refusal of a send whose session's lead run started, ended or was continued between
 * each read and the write that sends into it, every time the daemon tried: nothing is queued.
 */
export const AGENT_QUEUE_ITEM_RUN_CHANGED_CODE = "agent.queueItem.runChanged" as const;

/**
 * The refusal of a change naming a queue item the queue does not hold: an id it never stored,
 * an item of another session, or one of another queue than the change names.
 */
export const AGENT_QUEUE_ITEM_NOT_FOUND_CODE = "agent.queueItem.notFound" as const;

/**
 * The refusal of a change to a waiting message the agent has already taken or the provider
 * did not give back, a retry in other words than its own, an edit of a queued review or of a
 * plan message, the cancel of a hand-off's seed, a review's or a plan message's retry
 * carrying a message's extras, or a reorder whose list is not exactly the waiting items.
 */
export const AGENT_QUEUE_ITEM_CHANGE_REFUSED_CODE = "agent.queueItem.changeRefused" as const;

/**
 * Identifies one queued message.
 */
export type QueueItemId = string & { readonly __brand: "QueueItemId" };
/**
 * Where a queued message stands: waiting, sent to the run, replaced, canceled, or never sent.
 */
export type QueueItemState = "queued" | "admitted" | "superseded" | "canceled" | "notDelivered";
/**
 * Why a taken message was never delivered, tagged on `kind`: it waited past the daemon's own
 * delivery timeout, its delivery failed outright, or the person's own `UserPromptSubmit` hook
 * refused it after the provider was handed it, with the hook's words. Either way it can be sent
 * again.
 */
export type QueueItemNotDeliveredReason =
  | {
      kind: "timedOut";
    }
  | {
      kind: "failed";
    }
  | {
      kind: "refusedByHook";
      /**
       * The hook's own words.
       */
      words: string;
    };
/**
 * What a plan message is for: building the plan in its own session, or seeding the fresh session
 * a plan was handed to as its first turn.
 */
export type PlanMessageKind = "build" | "seed";
/**
 * The queued item, as a send, a child's steer or a review's start answers, and, when a send
 * again under the same key answers one whose delivery failed, the daemon's reason.
 */
export type AgentQueueItemCreateResponse =
  | {
      state: "queued";
      /**
       * The item.
       */
      queueItemId: QueueItemId;
      /**
       * When it was queued.
       */
      createdAt: WireInstant;
      /**
       * Only a not-delivered item carries a reason.
       */
      notDeliveredReason?: never;
    }
  | {
      state: "admitted";
      /**
       * The item.
       */
      queueItemId: QueueItemId;
      /**
       * When it was queued.
       */
      createdAt: WireInstant;
      /**
       * Only a not-delivered item carries a reason.
       */
      notDeliveredReason?: never;
    }
  | {
      state: "superseded";
      /**
       * The item.
       */
      queueItemId: QueueItemId;
      /**
       * When it was queued.
       */
      createdAt: WireInstant;
      /**
       * Only a not-delivered item carries a reason.
       */
      notDeliveredReason?: never;
    }
  | {
      state: "canceled";
      /**
       * The item.
       */
      queueItemId: QueueItemId;
      /**
       * When it was queued.
       */
      createdAt: WireInstant;
      /**
       * Only a not-delivered item carries a reason.
       */
      notDeliveredReason?: never;
    }
  | {
      state: "notDelivered";
      /**
       * The item.
       */
      queueItemId: QueueItemId;
      /**
       * When it was queued.
       */
      createdAt: WireInstant;
      /**
       * Why it was never delivered.
       */
      notDeliveredReason: QueueItemNotDeliveredReason;
    };
/**
 * One queue item as a pending row draws it, tagged on `kind`: a message the person sent, the
 * provider's own review queued as the session's next item, or a message the daemon sent for a
 * plan's verdict; each also tagged on `state`.
 */
export type QueueItemSummary =
  | ((
      | {
          state: "queued";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The words.
           */
          content: string;
          /**
           * The message's files in staging order.
           */
          attachments?: AttachmentReferenceList;
          /**
           * The child whose queue holds it; absent on the lead's.
           */
          childHandle?: ChildHandle;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "admitted";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The words.
           */
          content: string;
          /**
           * The message's files in staging order.
           */
          attachments?: AttachmentReferenceList;
          /**
           * The child whose queue holds it; absent on the lead's.
           */
          childHandle?: ChildHandle;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "superseded";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The words.
           */
          content: string;
          /**
           * The message's files in staging order.
           */
          attachments?: AttachmentReferenceList;
          /**
           * The child whose queue holds it; absent on the lead's.
           */
          childHandle?: ChildHandle;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "canceled";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The words.
           */
          content: string;
          /**
           * The message's files in staging order.
           */
          attachments?: AttachmentReferenceList;
          /**
           * The child whose queue holds it; absent on the lead's.
           */
          childHandle?: ChildHandle;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "notDelivered";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The words.
           */
          content: string;
          /**
           * The message's files in staging order.
           */
          attachments?: AttachmentReferenceList;
          /**
           * The child whose queue holds it; absent on the lead's.
           */
          childHandle?: ChildHandle;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Why it was never delivered.
           */
          notDeliveredReason: QueueItemNotDeliveredReason;
        }
    ) & {
      kind: "message";
    })
  | ((
      | {
          state: "queued";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * What the review covers.
           */
          target: SessionReviewTarget;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "admitted";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * What the review covers.
           */
          target: SessionReviewTarget;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "superseded";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * What the review covers.
           */
          target: SessionReviewTarget;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "canceled";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * What the review covers.
           */
          target: SessionReviewTarget;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "notDelivered";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * What the review covers.
           */
          target: SessionReviewTarget;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Why it was never delivered.
           */
          notDeliveredReason: QueueItemNotDeliveredReason;
        }
    ) & {
      kind: "review";
    })
  | ((
      | {
          state: "queued";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The plan it carries out.
           */
          planMessage: PlanMessage;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "admitted";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The plan it carries out.
           */
          planMessage: PlanMessage;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "superseded";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The plan it carries out.
           */
          planMessage: PlanMessage;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "canceled";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The plan it carries out.
           */
          planMessage: PlanMessage;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Only a not-delivered item carries a reason.
           */
          notDeliveredReason?: never;
        }
      | {
          state: "notDelivered";
          /**
           * The item.
           */
          id: QueueItemId;
          /**
           * Its place in its queue's order, lowest first.
           */
          position: number;
          /**
           * The plan it carries out.
           */
          planMessage: PlanMessage;
          /**
           * Whether `Send now` marked it and no later order moved it off first place.
           */
          isSentNow: boolean;
          /**
           * When it was queued.
           */
          createdAt: WireInstant;
          /**
           * When it last changed.
           */
          updatedAt: WireInstant;
          /**
           * Why it was never delivered.
           */
          notDeliveredReason: QueueItemNotDeliveredReason;
        }
    ) & {
      kind: "planMessage";
    });
/**
 * Why a change to a waiting message was refused.
 */
export type AgentQueueItemChangeRefusedReason =
  | "alreadyTaken"
  | "notDelivered"
  | "orderMismatch"
  | "reviewItem"
  | "planMessage"
  | "handOffSeed"
  | "retryExtras";

/**
 * One skill a send picked: its front-matter name and its folder, as `skill.list` gives them. A
 * provider that takes a skill as its own input item receives the `SKILL.md` path its own skill
 * list gives for that name in that folder.
 */
export interface QueuedSkillPick {
  /**
   * The skill's front-matter name.
   */
  name: string;
  /**
   * The skill's folder.
   */
  folderPath: string;
}
/**
 * Sends one message to the lead, whether a turn is running or not (`agent.queueItem.create`).
 */
export interface AgentQueueItemCreateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Another session to deliver to instead; the message arrives there as its own row.
   */
  to?: SessionId;
  /**
   * Binds the run a send starts to its repository.
   */
  workspaceId?: WorkspaceId;
  /**
   * A send again under the same key answers what the first saved. A retry's key is the failed
   * message's id, so a second press answers as the first did.
   */
  clientIdempotencyKey: string;
  /**
   * The words.
   */
  content: string;
  /**
   * The message's files in staging order; one the daemon cannot deliver stays, marked.
   */
  attachments?: AttachmentReferenceList;
  /**
   * Each skill picked from the composer's `/` and `$` list, in the order picked. The daemon
   * refuses a pick the provider's own skill list, where it keeps one, does not name in that
   * folder.
   */
  skills?: QueuedSkillPick[];
  /**
   * Edits this waiting message in place: it keeps its place and the old item reads
   * `superseded`. Naming a message not delivered, with its own words, is a retry that queues
   * its words and files again as a new message at the queue's end. Naming a review not
   * delivered queues the same review, the words unread, and naming a plan message not delivered,
   * with its own words, queues the same plan message; carrying `attachments`, `skills`,
   * `answersQuestionId` or `outputSpeedForTurn` beside either is refused
   * `agent.queueItem.changeRefused`, `retryExtras`.
   */
  replacesQueueItemId?: QueueItemId;
  /**
   * The question this send answers, one the agent does not wait for; the daemon copies it onto
   * the `user.message.sent` row it writes, which marks the question answered.
   */
  answersQuestionId?: QuestionId;
  /**
   * The output-speed level this send's turn alone runs at, the agent's own level staying as it
   * is: `Use standard` after a turn failed for want of flex capacity sends the standard level.
   */
  outputSpeedForTurn?: string;
}
/**
 * The plan a daemon-sent message carries out: the plan, what the message is for, and, on a seed,
 * the planning session it came from.
 */
export interface PlanMessage {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * What the message is for.
   */
  kind: PlanMessageKind;
  /**
   * The planning session, on a seed.
   */
  sourceSessionId?: SessionId;
}
/**
 * The `user.message.sent` payload: the person's message as a transcript row, written when the
 * daemon accepts the send. `origin` marks the words a voice call heard, `answers_question_id` is
 * the answered mark of the question a message answers, and `plan_message` marks a message the
 * daemon sent for a plan's verdict.
 */
export interface UserMessageSentPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The queued message, where the send went through the queue.
   */
  queueItemId?: QueueItemId;
  /**
   * The run it was sent toward.
   */
  runId?: RunId;
  /**
   * Repeats the envelope's actor.
   */
  actor: string;
  /**
   * The device that sent it.
   */
  deviceId?: DeviceId;
  /**
   * The words.
   */
  message: string;
  /**
   * Where the words came from when no one typed them.
   */
  origin?: "voice";
  /**
   * The question it answers; absent on every other message.
   */
  answersQuestionId?: QuestionId;
  /**
   * The plan it carries out, on a message the daemon sent for a plan's verdict; absent on every
   * other message.
   */
  planMessage?: PlanMessage;
}
/**
 * The `agent.queueItem.created` payload: a message entered the queue. The words stay on
 * `user.message.sent`.
 */
export interface AgentQueueItemCreatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The item.
   */
  queueItemId: QueueItemId;
  /**
   * The state the item entered.
   */
  state: "queued";
}
/**
 * The `agent.queueItem.admitted` payload: the run that took the message, which can differ from
 * the run its `user.message.sent` was sent toward.
 */
export interface AgentQueueItemAdmittedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The item.
   */
  queueItemId: QueueItemId;
  /**
   * The state the item entered.
   */
  state: "admitted";
  /**
   * The run that took it.
   */
  runId: RunId;
}
/**
 * The `agent.queueItem.superseded` payload: the item that replaced the message.
 */
export interface AgentQueueItemSupersededPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The item.
   */
  queueItemId: QueueItemId;
  /**
   * The state the item entered.
   */
  state: "superseded";
  /**
   * The item that replaced it.
   */
  replacedByQueueItemId: QueueItemId;
}
/**
 * The `agent.queueItem.canceled` payload: the message was removed.
 */
export interface AgentQueueItemCanceledPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The item.
   */
  queueItemId: QueueItemId;
  /**
   * The state the item entered.
   */
  state: "canceled";
}
/**
 * The `agent.queueItem.notDelivered` payload: the message was taken and never delivered, and
 * why.
 */
export interface AgentQueueItemNotDeliveredPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The item.
   */
  queueItemId: QueueItemId;
  /**
   * The state the item entered.
   */
  state: "notDelivered";
  /**
   * Why it was never delivered.
   */
  notDeliveredReason: QueueItemNotDeliveredReason;
}
/**
 * Reads a queue, the lead's or, with `childHandle`, a child's, in the daemon's order
 * (`agent.queueItem.list`): the items in `state` when it is given, else every item waiting or not
 * delivered.
 */
export interface AgentQueueItemListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The child whose queue to read; absent for the lead's.
   */
  childHandle?: ChildHandle;
  /**
   * The state to read.
   */
  state?: QueueItemState;
}
/**
 * A queue's items in the daemon's order.
 */
export interface AgentQueueItemListResponse {
  /**
   * The items.
   */
  items: QueueItemSummary[];
}
/**
 * One change on a queue's stream: the item as it now stands, and the cursor of the
 * `agent.queueItem.*` event that changed it, or, for a reorder, which no event records, the
 * session's newest cursor when the change went out.
 */
export interface RunQueueStreamChange {
  /**
   * Where the change stands in the session's log.
   */
  cursor: EventCursor;
  /**
   * The item as it now stands.
   */
  item: QueueItemSummary;
}
/**
 * One notify of `agent.queueItem.subscribe`: the queue's changes since the previous frame.
 */
export interface RunQueueStreamFrame {
  /**
   * The changes, oldest first.
   *
   * @minItems 1
   * @maxItems 50
   */
  changes: [RunQueueStreamChange, ...RunQueueStreamChange[]];
}
/**
 * Opens a queue's stream, the lead's or, with `childHandle`, a child's
 * (`agent.queueItem.subscribe`). With `after_cursor`, the stream first sends each item that
 * changed after that cursor and every item still waiting, as it now stands, then follows live;
 * without it, it follows from now.
 */
export interface AgentQueueItemSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The child whose queue to follow; absent for the lead's.
   */
  childHandle?: ChildHandle;
  /**
   * The cursor to catch up from.
   */
  afterCursor?: EventCursor;
}
/**
 * Removes a waiting message, from the lead's queue or, with `childHandle`, a child's
 * (`agent.queueItem.cancel`).
 */
export interface AgentQueueItemCancelRequest {
  /**
   * The item.
   */
  queueItemId: QueueItemId;
  /**
   * The child whose queue holds it; absent for the lead's.
   */
  childHandle?: ChildHandle;
}
/**
 * The canceled message.
 */
export interface AgentQueueItemCancelResponse {
  /**
   * The item.
   */
  queueItemId: QueueItemId;
  /**
   * Always `canceled`.
   */
  state: "canceled";
}
/**
 * Puts a queue's waiting messages in a new order (`agent.queueItem.reorder`): the full order,
 * naming each waiting item once. The daemon refuses a list that does not name exactly the items
 * still waiting, and answers the queue in its new order.
 */
export interface AgentQueueItemReorderRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The child whose queue to reorder; absent for the lead's.
   */
  childHandle?: ChildHandle;
  /**
   * The new order, each waiting item once.
   *
   * @minItems 1
   */
  queueItemIds: [QueueItemId, ...QueueItemId[]];
}
/**
 * The details an `agent.queueItem.changeRefused` refusal carries.
 */
export interface AgentQueueItemChangeRefusedDetails {
  /**
   * Why the change was refused.
   */
  reason: AgentQueueItemChangeRefusedReason;
}
/**
 * The details a `session.message.tooLarge` refusal carries: the provider's limit and the
 * message's length, both in characters as that provider counts them.
 */
export interface SessionMessageTooLargeDetails {
  /**
   * The most characters the provider takes in one message.
   */
  limit: number;
  /**
   * The characters the refused message held.
   */
  observed: number;
}

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link QueueItemId}. */
// prettier-ignore
export const validateQueueItemId: CompiledSchemaCheck<QueueItemId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QueueItemId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateQueueItemId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateQueueItemId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateQueueItemId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateQueueItemId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateQueueItemId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1124: any = {"description":"Where a queued message stands: waiting, sent to the run, replaced, canceled, or never sent.","type":"string","enum":["queued","admitted","superseded","canceled","notDelivered"]};
/** Checks that a value is a {@link QueueItemState}. */
// prettier-ignore
export const validateQueueItemState: CompiledSchemaCheck<QueueItemState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QueueItemState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateQueueItemState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateQueueItemState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "queued") || (data === "admitted")) || (data === "superseded")) || (data === "canceled")) || (data === "notDelivered"))){validateQueueItemState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1124.enum}}];return false;}validateQueueItemState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateQueueItemState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link QueueItemNotDeliveredReason}. */
// prettier-ignore
export const validateQueueItemNotDeliveredReason: CompiledSchemaCheck<QueueItemNotDeliveredReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QueueItemNotDeliveredReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateQueueItemNotDeliveredReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "timedOut"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kind === undefined) && (missing0 = "kind")){validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "kind")){validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;if(typeof data0 !== "string"){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("timedOut" !== data0){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "timedOut"}}];return false;}}}}}else {validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "failed"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.kind === undefined) && (missing1 = "kind")){validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!(key1 === "kind")){validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.kind !== undefined){let data1: any = data.kind;if(typeof data1 !== "string"){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data1){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}}}}}else {validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "refusedByHook"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.kind === undefined) && (missing2 = "kind")) || ((data.words === undefined) && (missing2 = "words"))){validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!((key2 === "kind") || (key2 === "words"))){validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("refusedByHook" !== data2){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "refusedByHook"}}];return false;}var valid6: any = _errs15 === errors;}else {var valid6: any = true;}if(valid6){if(data.words !== undefined){let data3: any = data.words;const _errs17: any = errors;if(errors === _errs17){if(typeof data3 === "string"){if(func1(data3) > 32768){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/words",schemaPath:"#/oneOf/2/properties/words/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data3) < 1){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/words",schemaPath:"#/oneOf/2/properties/words/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/words",schemaPath:"#/oneOf/2/properties/words/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateQueueItemNotDeliveredReason.errors = [{instancePath:instancePath+"/words",schemaPath:"#/oneOf/2/properties/words/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}}}}}else {validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateQueueItemNotDeliveredReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateQueueItemNotDeliveredReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateQueueItemNotDeliveredReason.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link QueuedSkillPick}. */
// prettier-ignore
export const validateQueuedSkillPick: CompiledSchemaCheck<QueuedSkillPick> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QueuedSkillPick {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateQueuedSkillPick.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.name === undefined) && (missing0 = "name")) || ((data.folderPath === undefined) && (missing0 = "folderPath"))){validateQueuedSkillPick.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "name") || (key0 === "folderPath"))){validateQueuedSkillPick.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateQueuedSkillPick.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateQueuedSkillPick.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateQueuedSkillPick.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateQueuedSkillPick.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderPath !== undefined){let data1: any = data.folderPath;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 4096){validateQueuedSkillPick.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateQueuedSkillPick.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateQueuedSkillPick.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateQueuedSkillPick.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateQueuedSkillPick.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateQueuedSkillPick.errors = vErrors;return errors === 0;};
// prettier-ignore
validateQueuedSkillPick.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1120: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"to":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"Another session to deliver to instead; the message arrives there as its own row."},"workspaceId":{"$ref":"sidekicks-contracts:repo/mount#/$defs/WorkspaceId","description":"Binds the run a send starts to its repository."},"clientIdempotencyKey":{"type":"string","pattern":"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$","description":"A send again under the same key answers what the first saved. A retry's key is the failed\nmessage's id, so a second press answers as the first did."},"content":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"The words."},"attachments":{"$ref":"sidekicks-contracts:artifacts/attachment-reference#/$defs/AttachmentReferenceList","description":"The message's files in staging order; one the daemon cannot deliver stays, marked."},"skills":{"type":"array","items":{"$ref":"#/$defs/QueuedSkillPick"},"description":"Each skill picked from the composer's `/` and `$` list, in the order picked. The daemon\nrefuses a pick the provider's own skill list, where it keeps one, does not name in that\nfolder."},"replacesQueueItemId":{"$ref":"#/$defs/QueueItemId","description":"Edits this waiting message in place: it keeps its place and the old item reads\n`superseded`. Naming a message not delivered, with its own words, is a retry that queues\nits words and files again as a new message at the queue's end. Naming a review not\ndelivered queues the same review, the words unread, and naming a plan message not delivered,\nwith its own words, queues the same plan message; carrying `attachments`, `skills`,\n`answersQuestionId` or `outputSpeedForTurn` beside either is refused\n`agent.queueItem.changeRefused`, `retryExtras`."},"answersQuestionId":{"$ref":"sidekicks-contracts:question#/$defs/QuestionId","description":"The question this send answers, one the agent does not wait for; the daemon copies it onto\nthe `user.message.sent` row it writes, which marks the question answered."},"outputSpeedForTurn":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The output-speed level this send's turn alone runs at, the agent's own level staying as it\nis: `Use standard` after a turn failed for want of flex capacity sends the standard level."}},"required":["sessionId","clientIdempotencyKey","content"],"description":"Sends one message to the lead, whether a turn is running or not (`agent.queueItem.create`)."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link AgentQueueItemCreateRequest}. */
// prettier-ignore
export const validateAgentQueueItemCreateRequest: CompiledSchemaCheck<AgentQueueItemCreateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemCreateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))) || ((data.content === undefined) && (missing0 = "content"))){validateAgentQueueItemCreateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1120.properties, key0))){validateAgentQueueItemCreateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.to !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.to, {instancePath:instancePath+"/to",parentData:data,parentDataProperty:"to",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.workspaceId !== undefined){const _errs4: any = errors;if(!(validateWorkspaceId.call(this, data.workspaceId, {instancePath:instancePath+"/workspaceId",parentData:data,parentDataProperty:"workspaceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceId.errors : vErrors.concat(validateWorkspaceId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data3: any = data.clientIdempotencyKey;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(!pattern88.test(data3)){validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.content !== undefined){let data4: any = data.content;const _errs7: any = errors;if(errors === _errs7){if(typeof data4 === "string"){if(func1(data4) < 1){validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.attachments !== undefined){const _errs9: any = errors;if(!(validateAttachmentReferenceList.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttachmentReferenceList.errors : vErrors.concat(validateAttachmentReferenceList.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.skills !== undefined){let data6: any = data.skills;const _errs10: any = errors;if(errors === _errs10){if(Array.isArray(data6)){var valid1: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){const _errs12: any = errors;if(!(validateQueuedSkillPick.call(this, data6[i0], {instancePath:instancePath+"/skills/" + i0,parentData:data6,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueuedSkillPick.errors : vErrors.concat(validateQueuedSkillPick.errors);errors = vErrors.length;}var valid1: any = _errs12 === errors;if(!valid1){break;}}}else {validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.replacesQueueItemId !== undefined){const _errs13: any = errors;if(!(validateQueueItemId.call(this, data.replacesQueueItemId, {instancePath:instancePath+"/replacesQueueItemId",parentData:data,parentDataProperty:"replacesQueueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.answersQuestionId !== undefined){const _errs14: any = errors;if(!(validateQuestionId.call(this, data.answersQuestionId, {instancePath:instancePath+"/answersQuestionId",parentData:data,parentDataProperty:"answersQuestionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQuestionId.errors : vErrors.concat(validateQuestionId.errors);errors = vErrors.length;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSpeedForTurn !== undefined){let data10: any = data.outputSpeedForTurn;const _errs15: any = errors;if(errors === _errs15){if(typeof data10 === "string"){if(func1(data10) > 128){validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data10) < 1){validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data10)){validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentQueueItemCreateRequest.errors = [{instancePath:instancePath+"/outputSpeedForTurn",schemaPath:"#/properties/outputSpeedForTurn/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validateAgentQueueItemCreateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemCreateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemCreateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema416: any = {"description":"What a plan message is for: building the plan in its own session, or seeding the fresh session\na plan was handed to as its first turn.","type":"string","enum":["build","seed"]};
/** Checks that a value is a {@link PlanMessageKind}. */
// prettier-ignore
export const validatePlanMessageKind: CompiledSchemaCheck<PlanMessageKind> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanMessageKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanMessageKind.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePlanMessageKind.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "build") || (data === "seed"))){validatePlanMessageKind.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema416.enum}}];return false;}validatePlanMessageKind.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanMessageKind.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanMessage}. */
// prettier-ignore
export const validatePlanMessage: CompiledSchemaCheck<PlanMessage> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanMessage {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanMessage.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.planId === undefined) && (missing0 = "planId")) || ((data.kind === undefined) && (missing0 = "kind"))){validatePlanMessage.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "planId") || (key0 === "kind")) || (key0 === "sourceSessionId"))){validatePlanMessage.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){const _errs2: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.kind !== undefined){const _errs3: any = errors;if(!(validatePlanMessageKind.call(this, data.kind, {instancePath:instancePath+"/kind",parentData:data,parentDataProperty:"kind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanMessageKind.errors : vErrors.concat(validatePlanMessageKind.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceSessionId !== undefined){const _errs4: any = errors;if(!(validateSessionId.call(this, data.sourceSessionId, {instancePath:instancePath+"/sourceSessionId",parentData:data,parentDataProperty:"sourceSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePlanMessage.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanMessage.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanMessage.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema414: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"queueItemId":{"$ref":"#/$defs/QueueItemId","description":"The queued message, where the send went through the queue."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run it was sent toward."},"actor":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Repeats the envelope's actor."},"deviceId":{"$ref":"sidekicks-contracts:trust-statement#/$defs/DeviceId","description":"The device that sent it."},"message":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"The words."},"origin":{"description":"Where the words came from when no one typed them.","type":"string","enum":["voice"]},"answersQuestionId":{"$ref":"sidekicks-contracts:question#/$defs/QuestionId","description":"The question it answers; absent on every other message."},"planMessage":{"$ref":"#/$defs/PlanMessage","description":"The plan it carries out, on a message the daemon sent for a plan's verdict; absent on every\nother message."}},"required":["sessionId","actor","message"],"description":"The `user.message.sent` payload: the person's message as a transcript row, written when the\ndaemon accepts the send. `origin` marks the words a voice call heard, `answers_question_id` is\nthe answered mark of the question a message answers, and `plan_message` marks a message the\ndaemon sent for a plan's verdict."};
/** Checks that a value is a {@link UserMessageSentPayload}. */
// prettier-ignore
export const validateUserMessageSentPayload: CompiledSchemaCheck<UserMessageSentPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is UserMessageSentPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateUserMessageSentPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.actor === undefined) && (missing0 = "actor"))) || ((data.message === undefined) && (missing0 = "message"))){validateUserMessageSentPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema414.properties, key0))){validateUserMessageSentPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.queueItemId !== undefined){const _errs3: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs4: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){let data3: any = data.actor;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(func1(data3) > 256){validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs7: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.message !== undefined){let data5: any = data.message;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) < 1){validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.origin !== undefined){let data6: any = data.origin;const _errs10: any = errors;if(typeof data6 !== "string"){validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data6 === "voice")){validateUserMessageSentPayload.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/enum",keyword:"enum",params:{allowedValues: schema414.properties.origin.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.answersQuestionId !== undefined){const _errs12: any = errors;if(!(validateQuestionId.call(this, data.answersQuestionId, {instancePath:instancePath+"/answersQuestionId",parentData:data,parentDataProperty:"answersQuestionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQuestionId.errors : vErrors.concat(validateQuestionId.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.planMessage !== undefined){const _errs13: any = errors;if(!(validatePlanMessage.call(this, data.planMessage, {instancePath:instancePath+"/planMessage",parentData:data,parentDataProperty:"planMessage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanMessage.errors : vErrors.concat(validatePlanMessage.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validateUserMessageSentPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateUserMessageSentPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateUserMessageSentPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema417: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"queueItemId":{"$ref":"#/$defs/QueueItemId","description":"The item."},"state":{"description":"The state the item entered.","type":"string","enum":["queued"]}},"required":["sessionId","queueItemId","state"],"description":"The `agent.queueItem.created` payload: a message entered the queue. The words stay on\n`user.message.sent`."};
/** Checks that a value is a {@link AgentQueueItemCreatedPayload}. */
// prettier-ignore
export const validateAgentQueueItemCreatedPayload: CompiledSchemaCheck<AgentQueueItemCreatedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemCreatedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemCreatedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.queueItemId === undefined) && (missing0 = "queueItemId"))) || ((data.state === undefined) && (missing0 = "state"))){validateAgentQueueItemCreatedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "queueItemId")) || (key0 === "state"))){validateAgentQueueItemCreatedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.queueItemId !== undefined){const _errs3: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs4: any = errors;if(typeof data2 !== "string"){validateAgentQueueItemCreatedPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "queued")){validateAgentQueueItemCreatedPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema417.properties.state.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateAgentQueueItemCreatedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemCreatedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemCreatedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema418: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"queueItemId":{"$ref":"#/$defs/QueueItemId","description":"The item."},"state":{"description":"The state the item entered.","type":"string","enum":["admitted"]},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run that took it."}},"required":["sessionId","queueItemId","state","runId"],"description":"The `agent.queueItem.admitted` payload: the run that took the message, which can differ from\nthe run its `user.message.sent` was sent toward."};
/** Checks that a value is a {@link AgentQueueItemAdmittedPayload}. */
// prettier-ignore
export const validateAgentQueueItemAdmittedPayload: CompiledSchemaCheck<AgentQueueItemAdmittedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemAdmittedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemAdmittedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.queueItemId === undefined) && (missing0 = "queueItemId"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.runId === undefined) && (missing0 = "runId"))){validateAgentQueueItemAdmittedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "queueItemId")) || (key0 === "state")) || (key0 === "runId"))){validateAgentQueueItemAdmittedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.queueItemId !== undefined){const _errs3: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs4: any = errors;if(typeof data2 !== "string"){validateAgentQueueItemAdmittedPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "admitted")){validateAgentQueueItemAdmittedPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema418.properties.state.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs6: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateAgentQueueItemAdmittedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemAdmittedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemAdmittedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema419: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"queueItemId":{"$ref":"#/$defs/QueueItemId","description":"The item."},"state":{"description":"The state the item entered.","type":"string","enum":["superseded"]},"replacedByQueueItemId":{"$ref":"#/$defs/QueueItemId","description":"The item that replaced it."}},"required":["sessionId","queueItemId","state","replacedByQueueItemId"],"description":"The `agent.queueItem.superseded` payload: the item that replaced the message."};
/** Checks that a value is a {@link AgentQueueItemSupersededPayload}. */
// prettier-ignore
export const validateAgentQueueItemSupersededPayload: CompiledSchemaCheck<AgentQueueItemSupersededPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemSupersededPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemSupersededPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.queueItemId === undefined) && (missing0 = "queueItemId"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.replacedByQueueItemId === undefined) && (missing0 = "replacedByQueueItemId"))){validateAgentQueueItemSupersededPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "queueItemId")) || (key0 === "state")) || (key0 === "replacedByQueueItemId"))){validateAgentQueueItemSupersededPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.queueItemId !== undefined){const _errs3: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs4: any = errors;if(typeof data2 !== "string"){validateAgentQueueItemSupersededPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "superseded")){validateAgentQueueItemSupersededPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema419.properties.state.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.replacedByQueueItemId !== undefined){const _errs6: any = errors;if(!(validateQueueItemId.call(this, data.replacedByQueueItemId, {instancePath:instancePath+"/replacedByQueueItemId",parentData:data,parentDataProperty:"replacedByQueueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateAgentQueueItemSupersededPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemSupersededPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemSupersededPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema420: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"queueItemId":{"$ref":"#/$defs/QueueItemId","description":"The item."},"state":{"description":"The state the item entered.","type":"string","enum":["canceled"]}},"required":["sessionId","queueItemId","state"],"description":"The `agent.queueItem.canceled` payload: the message was removed."};
/** Checks that a value is a {@link AgentQueueItemCanceledPayload}. */
// prettier-ignore
export const validateAgentQueueItemCanceledPayload: CompiledSchemaCheck<AgentQueueItemCanceledPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemCanceledPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemCanceledPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.queueItemId === undefined) && (missing0 = "queueItemId"))) || ((data.state === undefined) && (missing0 = "state"))){validateAgentQueueItemCanceledPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "queueItemId")) || (key0 === "state"))){validateAgentQueueItemCanceledPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.queueItemId !== undefined){const _errs3: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs4: any = errors;if(typeof data2 !== "string"){validateAgentQueueItemCanceledPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "canceled")){validateAgentQueueItemCanceledPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema420.properties.state.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateAgentQueueItemCanceledPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemCanceledPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemCanceledPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema421: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"queueItemId":{"$ref":"#/$defs/QueueItemId","description":"The item."},"state":{"description":"The state the item entered.","type":"string","enum":["notDelivered"]},"notDeliveredReason":{"$ref":"#/$defs/QueueItemNotDeliveredReason","description":"Why it was never delivered."}},"required":["sessionId","queueItemId","state","notDeliveredReason"],"description":"The `agent.queueItem.notDelivered` payload: the message was taken and never delivered, and\nwhy."};
/** Checks that a value is a {@link AgentQueueItemNotDeliveredPayload}. */
// prettier-ignore
export const validateAgentQueueItemNotDeliveredPayload: CompiledSchemaCheck<AgentQueueItemNotDeliveredPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemNotDeliveredPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemNotDeliveredPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.queueItemId === undefined) && (missing0 = "queueItemId"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.notDeliveredReason === undefined) && (missing0 = "notDeliveredReason"))){validateAgentQueueItemNotDeliveredPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "queueItemId")) || (key0 === "state")) || (key0 === "notDeliveredReason"))){validateAgentQueueItemNotDeliveredPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.queueItemId !== undefined){const _errs3: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs4: any = errors;if(typeof data2 !== "string"){validateAgentQueueItemNotDeliveredPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "notDelivered")){validateAgentQueueItemNotDeliveredPayload.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema421.properties.state.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.notDeliveredReason !== undefined){const _errs6: any = errors;if(!(validateQueueItemNotDeliveredReason.call(this, data.notDeliveredReason, {instancePath:instancePath+"/notDeliveredReason",parentData:data,parentDataProperty:"notDeliveredReason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemNotDeliveredReason.errors : vErrors.concat(validateQueueItemNotDeliveredReason.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateAgentQueueItemNotDeliveredPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemNotDeliveredPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemNotDeliveredPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentQueueItemCreateResponse}. */
// prettier-ignore
export const validateAgentQueueItemCreateResponse: CompiledSchemaCheck<AgentQueueItemCreateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemCreateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemCreateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "queued"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.state === undefined) && (missing0 = "state")) || ((data.queueItemId === undefined) && (missing0 = "queueItemId"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "state") || (key0 === "queueItemId")) || (key0 === "createdAt")) || (key0 === "notDeliveredReason"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("queued" !== data0){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "queued"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.queueItemId !== undefined){const _errs7: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdAt !== undefined){const _errs8: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.notDeliveredReason !== undefined){const _errs9: any = errors;validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/0/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid2: any = _errs9 === errors;}else {var valid2: any = true;}}}}}}}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "admitted"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.state === undefined) && (missing1 = "state")) || ((data.queueItemId === undefined) && (missing1 = "queueItemId"))) || ((data.createdAt === undefined) && (missing1 = "createdAt"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data){if(!((((key1 === "state") || (key1 === "queueItemId")) || (key1 === "createdAt")) || (key1 === "notDeliveredReason"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data.state !== undefined){let data4: any = data.state;const _errs15: any = errors;if(typeof data4 !== "string"){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("admitted" !== data4){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "admitted"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.queueItemId !== undefined){const _errs17: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}if(valid4){if(data.createdAt !== undefined){const _errs18: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.notDeliveredReason !== undefined){const _errs19: any = errors;validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/1/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid4: any = _errs19 === errors;}else {var valid4: any = true;}}}}}}}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "superseded"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.state === undefined) && (missing2 = "state")) || ((data.queueItemId === undefined) && (missing2 = "queueItemId"))) || ((data.createdAt === undefined) && (missing2 = "createdAt"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs24: any = errors;for(const key2 in data){if(!((((key2 === "state") || (key2 === "queueItemId")) || (key2 === "createdAt")) || (key2 === "notDeliveredReason"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs24 === errors){if(data.state !== undefined){let data8: any = data.state;const _errs25: any = errors;if(typeof data8 !== "string"){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("superseded" !== data8){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "superseded"}}];return false;}var valid6: any = _errs25 === errors;}else {var valid6: any = true;}if(valid6){if(data.queueItemId !== undefined){const _errs27: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}if(valid6){if(data.createdAt !== undefined){const _errs28: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid6: any = _errs28 === errors;}else {var valid6: any = true;}if(valid6){if(data.notDeliveredReason !== undefined){const _errs29: any = errors;validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/2/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid6: any = _errs29 === errors;}else {var valid6: any = true;}}}}}}}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs22 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "canceled"){const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((data.state === undefined) && (missing3 = "state")) || ((data.queueItemId === undefined) && (missing3 = "queueItemId"))) || ((data.createdAt === undefined) && (missing3 = "createdAt"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs34: any = errors;for(const key3 in data){if(!((((key3 === "state") || (key3 === "queueItemId")) || (key3 === "createdAt")) || (key3 === "notDeliveredReason"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs34 === errors){if(data.state !== undefined){let data12: any = data.state;const _errs35: any = errors;if(typeof data12 !== "string"){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data12){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid8: any = _errs35 === errors;}else {var valid8: any = true;}if(valid8){if(data.queueItemId !== undefined){const _errs37: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid8: any = _errs37 === errors;}else {var valid8: any = true;}if(valid8){if(data.createdAt !== undefined){const _errs38: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid8: any = _errs38 === errors;}else {var valid8: any = true;}if(valid8){if(data.notDeliveredReason !== undefined){const _errs39: any = errors;validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/3/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid8: any = _errs39 === errors;}else {var valid8: any = true;}}}}}}}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs32 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else if(tag0 === "notDelivered"){const _errs42: any = errors;if(errors === _errs42){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((data.state === undefined) && (missing4 = "state")) || ((data.queueItemId === undefined) && (missing4 = "queueItemId"))) || ((data.createdAt === undefined) && (missing4 = "createdAt"))) || ((data.notDeliveredReason === undefined) && (missing4 = "notDeliveredReason"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs44: any = errors;for(const key4 in data){if(!((((key4 === "state") || (key4 === "queueItemId")) || (key4 === "createdAt")) || (key4 === "notDeliveredReason"))){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs44 === errors){if(data.state !== undefined){let data16: any = data.state;const _errs45: any = errors;if(typeof data16 !== "string"){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("notDelivered" !== data16){validateAgentQueueItemCreateResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "notDelivered"}}];return false;}var valid10: any = _errs45 === errors;}else {var valid10: any = true;}if(valid10){if(data.queueItemId !== undefined){const _errs47: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid10: any = _errs47 === errors;}else {var valid10: any = true;}if(valid10){if(data.createdAt !== undefined){const _errs48: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid10: any = _errs48 === errors;}else {var valid10: any = true;}if(valid10){if(data.notDeliveredReason !== undefined){const _errs49: any = errors;if(!(validateQueueItemNotDeliveredReason.call(this, data.notDeliveredReason, {instancePath:instancePath+"/notDeliveredReason",parentData:data,parentDataProperty:"notDeliveredReason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemNotDeliveredReason.errors : vErrors.concat(validateQueueItemNotDeliveredReason.errors);errors = vErrors.length;}var valid10: any = _errs49 === errors;}else {var valid10: any = true;}}}}}}}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs42 === errors;if(props0 !== true){props0 = true;}valid0 = valid9;}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key5 in data){if(!props0 || !props0[key5]){validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}}}}}else {validateAgentQueueItemCreateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemCreateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemCreateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentQueueItemListRequest}. */
// prettier-ignore
export const validateAgentQueueItemListRequest: CompiledSchemaCheck<AgentQueueItemListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateAgentQueueItemListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "childHandle")) || (key0 === "state"))){validateAgentQueueItemListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.childHandle !== undefined){const _errs3: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs4: any = errors;if(!(validateQueueItemState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemState.errors : vErrors.concat(validateQueueItemState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateAgentQueueItemListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link QueueItemSummary}. */
// prettier-ignore
export const validateQueueItemSummary: CompiledSchemaCheck<QueueItemSummary> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QueueItemSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateQueueItemSummary.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "message"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kind === undefined) && (missing0 = "kind")){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("message" !== data0){validateQueueItemSummary.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "message"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){const tag1: any = data.state;if(typeof tag1 == "string"){if(tag1 === "queued"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((data.state === undefined) && (missing1 = "state")) || ((data.id === undefined) && (missing1 = "id"))) || ((data.position === undefined) && (missing1 = "position"))) || ((data.content === undefined) && (missing1 = "content"))) || ((data.isSentNow === undefined) && (missing1 = "isSentNow"))) || ((data.createdAt === undefined) && (missing1 = "createdAt"))) || ((data.updatedAt === undefined) && (missing1 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {if(data.state !== undefined){let data1: any = data.state;const _errs9: any = errors;if(typeof data1 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("queued" !== data1){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "queued"}}];return false;}var valid5: any = _errs9 === errors;}else {var valid5: any = true;}if(valid5){if(data.id !== undefined){const _errs11: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid5: any = _errs11 === errors;}else {var valid5: any = true;}if(valid5){if(data.position !== undefined){let data3: any = data.position;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/0/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/0/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/0/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs12 === errors;}else {var valid5: any = true;}if(valid5){if(data.content !== undefined){let data4: any = data.content;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) < 1){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/0/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/0/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/0/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs14 === errors;}else {var valid5: any = true;}if(valid5){if(data.attachments !== undefined){const _errs16: any = errors;if(!(validateAttachmentReferenceList.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttachmentReferenceList.errors : vErrors.concat(validateAttachmentReferenceList.errors);errors = vErrors.length;}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}if(valid5){if(data.childHandle !== undefined){const _errs17: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.isSentNow !== undefined){const _errs18: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/0/oneOf/0/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}if(valid5){if(data.createdAt !== undefined){const _errs20: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}if(valid5){if(data.updatedAt !== undefined){const _errs21: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}if(valid5){if(data.notDeliveredReason !== undefined){const _errs22: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/0/oneOf/0/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid5: any = _errs22 === errors;}else {var valid5: any = true;}}}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var props0: any = {};props0.state = true;props0.id = true;props0.position = true;props0.content = true;props0.attachments = true;props0.childHandle = true;props0.isSentNow = true;props0.createdAt = true;props0.updatedAt = true;props0.notDeliveredReason = true;props0.kind = true;}else if(tag1 === "admitted"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((((((data.state === undefined) && (missing2 = "state")) || ((data.id === undefined) && (missing2 = "id"))) || ((data.position === undefined) && (missing2 = "position"))) || ((data.content === undefined) && (missing2 = "content"))) || ((data.isSentNow === undefined) && (missing2 = "isSentNow"))) || ((data.createdAt === undefined) && (missing2 = "createdAt"))) || ((data.updatedAt === undefined) && (missing2 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {if(data.state !== undefined){let data11: any = data.state;const _errs27: any = errors;if(typeof data11 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("admitted" !== data11){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "admitted"}}];return false;}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.id !== undefined){const _errs29: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid7: any = _errs29 === errors;}else {var valid7: any = true;}if(valid7){if(data.position !== undefined){let data13: any = data.position;const _errs30: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/1/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs30){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 9007199254740991 || isNaN(data13)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/1/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data13 < 0 || isNaN(data13)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/1/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs30 === errors;}else {var valid7: any = true;}if(valid7){if(data.content !== undefined){let data14: any = data.content;const _errs32: any = errors;if(errors === _errs32){if(typeof data14 === "string"){if(func1(data14) < 1){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/1/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data14)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/1/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/1/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs32 === errors;}else {var valid7: any = true;}if(valid7){if(data.attachments !== undefined){const _errs34: any = errors;if(!(validateAttachmentReferenceList.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttachmentReferenceList.errors : vErrors.concat(validateAttachmentReferenceList.errors);errors = vErrors.length;}var valid7: any = _errs34 === errors;}else {var valid7: any = true;}if(valid7){if(data.childHandle !== undefined){const _errs35: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid7: any = _errs35 === errors;}else {var valid7: any = true;}if(valid7){if(data.isSentNow !== undefined){const _errs36: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/0/oneOf/1/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid7: any = _errs36 === errors;}else {var valid7: any = true;}if(valid7){if(data.createdAt !== undefined){const _errs38: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid7: any = _errs38 === errors;}else {var valid7: any = true;}if(valid7){if(data.updatedAt !== undefined){const _errs39: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid7: any = _errs39 === errors;}else {var valid7: any = true;}if(valid7){if(data.notDeliveredReason !== undefined){const _errs40: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/0/oneOf/1/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid7: any = _errs40 === errors;}else {var valid7: any = true;}}}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}if(props0 !== true){props0 = props0 || {};props0.state = true;props0.id = true;props0.position = true;props0.content = true;props0.attachments = true;props0.childHandle = true;props0.isSentNow = true;props0.createdAt = true;props0.updatedAt = true;props0.notDeliveredReason = true;}}else if(tag1 === "superseded"){const _errs43: any = errors;if(errors === _errs43){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((((((data.state === undefined) && (missing3 = "state")) || ((data.id === undefined) && (missing3 = "id"))) || ((data.position === undefined) && (missing3 = "position"))) || ((data.content === undefined) && (missing3 = "content"))) || ((data.isSentNow === undefined) && (missing3 = "isSentNow"))) || ((data.createdAt === undefined) && (missing3 = "createdAt"))) || ((data.updatedAt === undefined) && (missing3 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {if(data.state !== undefined){let data21: any = data.state;const _errs45: any = errors;if(typeof data21 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("superseded" !== data21){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "superseded"}}];return false;}var valid9: any = _errs45 === errors;}else {var valid9: any = true;}if(valid9){if(data.id !== undefined){const _errs47: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid9: any = _errs47 === errors;}else {var valid9: any = true;}if(valid9){if(data.position !== undefined){let data23: any = data.position;const _errs48: any = errors;if(!(((typeof data23 == "number") && (!(data23 % 1) && !isNaN(data23))) && (isFinite(data23)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/2/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs48){if((typeof data23 == "number") && (isFinite(data23))){if(data23 > 9007199254740991 || isNaN(data23)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/2/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data23 < 0 || isNaN(data23)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/2/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid9: any = _errs48 === errors;}else {var valid9: any = true;}if(valid9){if(data.content !== undefined){let data24: any = data.content;const _errs50: any = errors;if(errors === _errs50){if(typeof data24 === "string"){if(func1(data24) < 1){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/2/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data24)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/2/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/2/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs50 === errors;}else {var valid9: any = true;}if(valid9){if(data.attachments !== undefined){const _errs52: any = errors;if(!(validateAttachmentReferenceList.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttachmentReferenceList.errors : vErrors.concat(validateAttachmentReferenceList.errors);errors = vErrors.length;}var valid9: any = _errs52 === errors;}else {var valid9: any = true;}if(valid9){if(data.childHandle !== undefined){const _errs53: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid9: any = _errs53 === errors;}else {var valid9: any = true;}if(valid9){if(data.isSentNow !== undefined){const _errs54: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/0/oneOf/2/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid9: any = _errs54 === errors;}else {var valid9: any = true;}if(valid9){if(data.createdAt !== undefined){const _errs56: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid9: any = _errs56 === errors;}else {var valid9: any = true;}if(valid9){if(data.updatedAt !== undefined){const _errs57: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid9: any = _errs57 === errors;}else {var valid9: any = true;}if(valid9){if(data.notDeliveredReason !== undefined){const _errs58: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/0/oneOf/2/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid9: any = _errs58 === errors;}else {var valid9: any = true;}}}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}if(props0 !== true){props0 = props0 || {};props0.state = true;props0.id = true;props0.position = true;props0.content = true;props0.attachments = true;props0.childHandle = true;props0.isSentNow = true;props0.createdAt = true;props0.updatedAt = true;props0.notDeliveredReason = true;}}else if(tag1 === "canceled"){const _errs61: any = errors;if(errors === _errs61){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((((((data.state === undefined) && (missing4 = "state")) || ((data.id === undefined) && (missing4 = "id"))) || ((data.position === undefined) && (missing4 = "position"))) || ((data.content === undefined) && (missing4 = "content"))) || ((data.isSentNow === undefined) && (missing4 = "isSentNow"))) || ((data.createdAt === undefined) && (missing4 = "createdAt"))) || ((data.updatedAt === undefined) && (missing4 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {if(data.state !== undefined){let data31: any = data.state;const _errs63: any = errors;if(typeof data31 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data31){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid11: any = _errs63 === errors;}else {var valid11: any = true;}if(valid11){if(data.id !== undefined){const _errs65: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid11: any = _errs65 === errors;}else {var valid11: any = true;}if(valid11){if(data.position !== undefined){let data33: any = data.position;const _errs66: any = errors;if(!(((typeof data33 == "number") && (!(data33 % 1) && !isNaN(data33))) && (isFinite(data33)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/3/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs66){if((typeof data33 == "number") && (isFinite(data33))){if(data33 > 9007199254740991 || isNaN(data33)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/3/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data33 < 0 || isNaN(data33)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/3/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid11: any = _errs66 === errors;}else {var valid11: any = true;}if(valid11){if(data.content !== undefined){let data34: any = data.content;const _errs68: any = errors;if(errors === _errs68){if(typeof data34 === "string"){if(func1(data34) < 1){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/3/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data34)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/3/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/3/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs68 === errors;}else {var valid11: any = true;}if(valid11){if(data.attachments !== undefined){const _errs70: any = errors;if(!(validateAttachmentReferenceList.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttachmentReferenceList.errors : vErrors.concat(validateAttachmentReferenceList.errors);errors = vErrors.length;}var valid11: any = _errs70 === errors;}else {var valid11: any = true;}if(valid11){if(data.childHandle !== undefined){const _errs71: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid11: any = _errs71 === errors;}else {var valid11: any = true;}if(valid11){if(data.isSentNow !== undefined){const _errs72: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/0/oneOf/3/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid11: any = _errs72 === errors;}else {var valid11: any = true;}if(valid11){if(data.createdAt !== undefined){const _errs74: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid11: any = _errs74 === errors;}else {var valid11: any = true;}if(valid11){if(data.updatedAt !== undefined){const _errs75: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid11: any = _errs75 === errors;}else {var valid11: any = true;}if(valid11){if(data.notDeliveredReason !== undefined){const _errs76: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/0/oneOf/3/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid11: any = _errs76 === errors;}else {var valid11: any = true;}}}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}if(props0 !== true){props0 = props0 || {};props0.state = true;props0.id = true;props0.position = true;props0.content = true;props0.attachments = true;props0.childHandle = true;props0.isSentNow = true;props0.createdAt = true;props0.updatedAt = true;props0.notDeliveredReason = true;}}else if(tag1 === "notDelivered"){const _errs79: any = errors;if(errors === _errs79){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((((((data.state === undefined) && (missing5 = "state")) || ((data.id === undefined) && (missing5 = "id"))) || ((data.position === undefined) && (missing5 = "position"))) || ((data.content === undefined) && (missing5 = "content"))) || ((data.isSentNow === undefined) && (missing5 = "isSentNow"))) || ((data.createdAt === undefined) && (missing5 = "createdAt"))) || ((data.updatedAt === undefined) && (missing5 = "updatedAt"))) || ((data.notDeliveredReason === undefined) && (missing5 = "notDeliveredReason"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/4/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {if(data.state !== undefined){let data41: any = data.state;const _errs81: any = errors;if(typeof data41 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("notDelivered" !== data41){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "notDelivered"}}];return false;}var valid13: any = _errs81 === errors;}else {var valid13: any = true;}if(valid13){if(data.id !== undefined){const _errs83: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid13: any = _errs83 === errors;}else {var valid13: any = true;}if(valid13){if(data.position !== undefined){let data43: any = data.position;const _errs84: any = errors;if(!(((typeof data43 == "number") && (!(data43 % 1) && !isNaN(data43))) && (isFinite(data43)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/4/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs84){if((typeof data43 == "number") && (isFinite(data43))){if(data43 > 9007199254740991 || isNaN(data43)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/4/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data43 < 0 || isNaN(data43)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/0/oneOf/4/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid13: any = _errs84 === errors;}else {var valid13: any = true;}if(valid13){if(data.content !== undefined){let data44: any = data.content;const _errs86: any = errors;if(errors === _errs86){if(typeof data44 === "string"){if(func1(data44) < 1){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/4/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data44)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/4/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateQueueItemSummary.errors = [{instancePath:instancePath+"/content",schemaPath:"#/oneOf/0/oneOf/4/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid13: any = _errs86 === errors;}else {var valid13: any = true;}if(valid13){if(data.attachments !== undefined){const _errs88: any = errors;if(!(validateAttachmentReferenceList.call(this, data.attachments, {instancePath:instancePath+"/attachments",parentData:data,parentDataProperty:"attachments",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttachmentReferenceList.errors : vErrors.concat(validateAttachmentReferenceList.errors);errors = vErrors.length;}var valid13: any = _errs88 === errors;}else {var valid13: any = true;}if(valid13){if(data.childHandle !== undefined){const _errs89: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid13: any = _errs89 === errors;}else {var valid13: any = true;}if(valid13){if(data.isSentNow !== undefined){const _errs90: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/0/oneOf/4/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid13: any = _errs90 === errors;}else {var valid13: any = true;}if(valid13){if(data.createdAt !== undefined){const _errs92: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid13: any = _errs92 === errors;}else {var valid13: any = true;}if(valid13){if(data.updatedAt !== undefined){const _errs93: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid13: any = _errs93 === errors;}else {var valid13: any = true;}if(valid13){if(data.notDeliveredReason !== undefined){const _errs94: any = errors;if(!(validateQueueItemNotDeliveredReason.call(this, data.notDeliveredReason, {instancePath:instancePath+"/notDeliveredReason",parentData:data,parentDataProperty:"notDeliveredReason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemNotDeliveredReason.errors : vErrors.concat(validateQueueItemNotDeliveredReason.errors);errors = vErrors.length;}var valid13: any = _errs94 === errors;}else {var valid13: any = true;}}}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}if(props0 !== true){props0 = props0 || {};props0.state = true;props0.id = true;props0.position = true;props0.content = true;props0.attachments = true;props0.childHandle = true;props0.isSentNow = true;props0.createdAt = true;props0.updatedAt = true;props0.notDeliveredReason = true;}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag1}}];return false;}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag1}}];return false;}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;valid0 = valid1;}else if(tag0 === "review"){const _errs95: any = errors;if(errors === _errs95){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((data.kind === undefined) && (missing6 = "kind")){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {if(data.kind !== undefined){let data51: any = data.kind;const _errs98: any = errors;if(typeof data51 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("review" !== data51){validateQueueItemSummary.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "review"}}];return false;}var valid15: any = _errs98 === errors;}else {var valid15: any = true;}if(valid15){const tag2: any = data.state;if(typeof tag2 == "string"){if(tag2 === "queued"){const _errs100: any = errors;if(errors === _errs100){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if((((((((data.state === undefined) && (missing7 = "state")) || ((data.id === undefined) && (missing7 = "id"))) || ((data.position === undefined) && (missing7 = "position"))) || ((data.target === undefined) && (missing7 = "target"))) || ((data.isSentNow === undefined) && (missing7 = "isSentNow"))) || ((data.createdAt === undefined) && (missing7 = "createdAt"))) || ((data.updatedAt === undefined) && (missing7 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/0/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {if(data.state !== undefined){let data52: any = data.state;const _errs102: any = errors;if(typeof data52 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("queued" !== data52){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "queued"}}];return false;}var valid18: any = _errs102 === errors;}else {var valid18: any = true;}if(valid18){if(data.id !== undefined){const _errs104: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid18: any = _errs104 === errors;}else {var valid18: any = true;}if(valid18){if(data.position !== undefined){let data54: any = data.position;const _errs105: any = errors;if(!(((typeof data54 == "number") && (!(data54 % 1) && !isNaN(data54))) && (isFinite(data54)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/0/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs105){if((typeof data54 == "number") && (isFinite(data54))){if(data54 > 9007199254740991 || isNaN(data54)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/0/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data54 < 0 || isNaN(data54)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/0/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid18: any = _errs105 === errors;}else {var valid18: any = true;}if(valid18){if(data.target !== undefined){const _errs107: any = errors;if(!(validateSessionReviewTarget.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionReviewTarget.errors : vErrors.concat(validateSessionReviewTarget.errors);errors = vErrors.length;}var valid18: any = _errs107 === errors;}else {var valid18: any = true;}if(valid18){if(data.isSentNow !== undefined){const _errs108: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/1/oneOf/0/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid18: any = _errs108 === errors;}else {var valid18: any = true;}if(valid18){if(data.createdAt !== undefined){const _errs110: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid18: any = _errs110 === errors;}else {var valid18: any = true;}if(valid18){if(data.updatedAt !== undefined){const _errs111: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid18: any = _errs111 === errors;}else {var valid18: any = true;}if(valid18){if(data.notDeliveredReason !== undefined){const _errs112: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/1/oneOf/0/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid18: any = _errs112 === errors;}else {var valid18: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var props1: any = {};props1.state = true;props1.id = true;props1.position = true;props1.target = true;props1.isSentNow = true;props1.createdAt = true;props1.updatedAt = true;props1.notDeliveredReason = true;props1.kind = true;}else if(tag2 === "admitted"){const _errs115: any = errors;if(errors === _errs115){if(data && typeof data == "object" && !Array.isArray(data)){let missing8: any;if((((((((data.state === undefined) && (missing8 = "state")) || ((data.id === undefined) && (missing8 = "id"))) || ((data.position === undefined) && (missing8 = "position"))) || ((data.target === undefined) && (missing8 = "target"))) || ((data.isSentNow === undefined) && (missing8 = "isSentNow"))) || ((data.createdAt === undefined) && (missing8 = "createdAt"))) || ((data.updatedAt === undefined) && (missing8 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/1/required",keyword:"required",params:{missingProperty: missing8}}];return false;}else {if(data.state !== undefined){let data60: any = data.state;const _errs117: any = errors;if(typeof data60 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("admitted" !== data60){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "admitted"}}];return false;}var valid20: any = _errs117 === errors;}else {var valid20: any = true;}if(valid20){if(data.id !== undefined){const _errs119: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid20: any = _errs119 === errors;}else {var valid20: any = true;}if(valid20){if(data.position !== undefined){let data62: any = data.position;const _errs120: any = errors;if(!(((typeof data62 == "number") && (!(data62 % 1) && !isNaN(data62))) && (isFinite(data62)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/1/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs120){if((typeof data62 == "number") && (isFinite(data62))){if(data62 > 9007199254740991 || isNaN(data62)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/1/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data62 < 0 || isNaN(data62)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/1/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid20: any = _errs120 === errors;}else {var valid20: any = true;}if(valid20){if(data.target !== undefined){const _errs122: any = errors;if(!(validateSessionReviewTarget.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionReviewTarget.errors : vErrors.concat(validateSessionReviewTarget.errors);errors = vErrors.length;}var valid20: any = _errs122 === errors;}else {var valid20: any = true;}if(valid20){if(data.isSentNow !== undefined){const _errs123: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/1/oneOf/1/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid20: any = _errs123 === errors;}else {var valid20: any = true;}if(valid20){if(data.createdAt !== undefined){const _errs125: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid20: any = _errs125 === errors;}else {var valid20: any = true;}if(valid20){if(data.updatedAt !== undefined){const _errs126: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid20: any = _errs126 === errors;}else {var valid20: any = true;}if(valid20){if(data.notDeliveredReason !== undefined){const _errs127: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/1/oneOf/1/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid20: any = _errs127 === errors;}else {var valid20: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}if(props1 !== true){props1 = props1 || {};props1.state = true;props1.id = true;props1.position = true;props1.target = true;props1.isSentNow = true;props1.createdAt = true;props1.updatedAt = true;props1.notDeliveredReason = true;}}else if(tag2 === "superseded"){const _errs130: any = errors;if(errors === _errs130){if(data && typeof data == "object" && !Array.isArray(data)){let missing9: any;if((((((((data.state === undefined) && (missing9 = "state")) || ((data.id === undefined) && (missing9 = "id"))) || ((data.position === undefined) && (missing9 = "position"))) || ((data.target === undefined) && (missing9 = "target"))) || ((data.isSentNow === undefined) && (missing9 = "isSentNow"))) || ((data.createdAt === undefined) && (missing9 = "createdAt"))) || ((data.updatedAt === undefined) && (missing9 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/2/required",keyword:"required",params:{missingProperty: missing9}}];return false;}else {if(data.state !== undefined){let data68: any = data.state;const _errs132: any = errors;if(typeof data68 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("superseded" !== data68){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "superseded"}}];return false;}var valid22: any = _errs132 === errors;}else {var valid22: any = true;}if(valid22){if(data.id !== undefined){const _errs134: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid22: any = _errs134 === errors;}else {var valid22: any = true;}if(valid22){if(data.position !== undefined){let data70: any = data.position;const _errs135: any = errors;if(!(((typeof data70 == "number") && (!(data70 % 1) && !isNaN(data70))) && (isFinite(data70)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/2/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs135){if((typeof data70 == "number") && (isFinite(data70))){if(data70 > 9007199254740991 || isNaN(data70)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/2/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data70 < 0 || isNaN(data70)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/2/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid22: any = _errs135 === errors;}else {var valid22: any = true;}if(valid22){if(data.target !== undefined){const _errs137: any = errors;if(!(validateSessionReviewTarget.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionReviewTarget.errors : vErrors.concat(validateSessionReviewTarget.errors);errors = vErrors.length;}var valid22: any = _errs137 === errors;}else {var valid22: any = true;}if(valid22){if(data.isSentNow !== undefined){const _errs138: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/1/oneOf/2/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid22: any = _errs138 === errors;}else {var valid22: any = true;}if(valid22){if(data.createdAt !== undefined){const _errs140: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid22: any = _errs140 === errors;}else {var valid22: any = true;}if(valid22){if(data.updatedAt !== undefined){const _errs141: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid22: any = _errs141 === errors;}else {var valid22: any = true;}if(valid22){if(data.notDeliveredReason !== undefined){const _errs142: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/1/oneOf/2/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid22: any = _errs142 === errors;}else {var valid22: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}if(props1 !== true){props1 = props1 || {};props1.state = true;props1.id = true;props1.position = true;props1.target = true;props1.isSentNow = true;props1.createdAt = true;props1.updatedAt = true;props1.notDeliveredReason = true;}}else if(tag2 === "canceled"){const _errs145: any = errors;if(errors === _errs145){if(data && typeof data == "object" && !Array.isArray(data)){let missing10: any;if((((((((data.state === undefined) && (missing10 = "state")) || ((data.id === undefined) && (missing10 = "id"))) || ((data.position === undefined) && (missing10 = "position"))) || ((data.target === undefined) && (missing10 = "target"))) || ((data.isSentNow === undefined) && (missing10 = "isSentNow"))) || ((data.createdAt === undefined) && (missing10 = "createdAt"))) || ((data.updatedAt === undefined) && (missing10 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/3/required",keyword:"required",params:{missingProperty: missing10}}];return false;}else {if(data.state !== undefined){let data76: any = data.state;const _errs147: any = errors;if(typeof data76 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data76){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid24: any = _errs147 === errors;}else {var valid24: any = true;}if(valid24){if(data.id !== undefined){const _errs149: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid24: any = _errs149 === errors;}else {var valid24: any = true;}if(valid24){if(data.position !== undefined){let data78: any = data.position;const _errs150: any = errors;if(!(((typeof data78 == "number") && (!(data78 % 1) && !isNaN(data78))) && (isFinite(data78)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/3/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs150){if((typeof data78 == "number") && (isFinite(data78))){if(data78 > 9007199254740991 || isNaN(data78)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/3/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data78 < 0 || isNaN(data78)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/3/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid24: any = _errs150 === errors;}else {var valid24: any = true;}if(valid24){if(data.target !== undefined){const _errs152: any = errors;if(!(validateSessionReviewTarget.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionReviewTarget.errors : vErrors.concat(validateSessionReviewTarget.errors);errors = vErrors.length;}var valid24: any = _errs152 === errors;}else {var valid24: any = true;}if(valid24){if(data.isSentNow !== undefined){const _errs153: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/1/oneOf/3/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid24: any = _errs153 === errors;}else {var valid24: any = true;}if(valid24){if(data.createdAt !== undefined){const _errs155: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid24: any = _errs155 === errors;}else {var valid24: any = true;}if(valid24){if(data.updatedAt !== undefined){const _errs156: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid24: any = _errs156 === errors;}else {var valid24: any = true;}if(valid24){if(data.notDeliveredReason !== undefined){const _errs157: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/1/oneOf/3/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid24: any = _errs157 === errors;}else {var valid24: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}if(props1 !== true){props1 = props1 || {};props1.state = true;props1.id = true;props1.position = true;props1.target = true;props1.isSentNow = true;props1.createdAt = true;props1.updatedAt = true;props1.notDeliveredReason = true;}}else if(tag2 === "notDelivered"){const _errs160: any = errors;if(errors === _errs160){if(data && typeof data == "object" && !Array.isArray(data)){let missing11: any;if(((((((((data.state === undefined) && (missing11 = "state")) || ((data.id === undefined) && (missing11 = "id"))) || ((data.position === undefined) && (missing11 = "position"))) || ((data.target === undefined) && (missing11 = "target"))) || ((data.isSentNow === undefined) && (missing11 = "isSentNow"))) || ((data.createdAt === undefined) && (missing11 = "createdAt"))) || ((data.updatedAt === undefined) && (missing11 = "updatedAt"))) || ((data.notDeliveredReason === undefined) && (missing11 = "notDeliveredReason"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/4/required",keyword:"required",params:{missingProperty: missing11}}];return false;}else {if(data.state !== undefined){let data84: any = data.state;const _errs162: any = errors;if(typeof data84 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("notDelivered" !== data84){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "notDelivered"}}];return false;}var valid26: any = _errs162 === errors;}else {var valid26: any = true;}if(valid26){if(data.id !== undefined){const _errs164: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid26: any = _errs164 === errors;}else {var valid26: any = true;}if(valid26){if(data.position !== undefined){let data86: any = data.position;const _errs165: any = errors;if(!(((typeof data86 == "number") && (!(data86 % 1) && !isNaN(data86))) && (isFinite(data86)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/4/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs165){if((typeof data86 == "number") && (isFinite(data86))){if(data86 > 9007199254740991 || isNaN(data86)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/4/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data86 < 0 || isNaN(data86)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/1/oneOf/4/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid26: any = _errs165 === errors;}else {var valid26: any = true;}if(valid26){if(data.target !== undefined){const _errs167: any = errors;if(!(validateSessionReviewTarget.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionReviewTarget.errors : vErrors.concat(validateSessionReviewTarget.errors);errors = vErrors.length;}var valid26: any = _errs167 === errors;}else {var valid26: any = true;}if(valid26){if(data.isSentNow !== undefined){const _errs168: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/1/oneOf/4/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid26: any = _errs168 === errors;}else {var valid26: any = true;}if(valid26){if(data.createdAt !== undefined){const _errs170: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid26: any = _errs170 === errors;}else {var valid26: any = true;}if(valid26){if(data.updatedAt !== undefined){const _errs171: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid26: any = _errs171 === errors;}else {var valid26: any = true;}if(valid26){if(data.notDeliveredReason !== undefined){const _errs172: any = errors;if(!(validateQueueItemNotDeliveredReason.call(this, data.notDeliveredReason, {instancePath:instancePath+"/notDeliveredReason",parentData:data,parentDataProperty:"notDeliveredReason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemNotDeliveredReason.errors : vErrors.concat(validateQueueItemNotDeliveredReason.errors);errors = vErrors.length;}var valid26: any = _errs172 === errors;}else {var valid26: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}if(props1 !== true){props1 = props1 || {};props1.state = true;props1.id = true;props1.position = true;props1.target = true;props1.isSentNow = true;props1.createdAt = true;props1.updatedAt = true;props1.notDeliveredReason = true;}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag2}}];return false;}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag2}}];return false;}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid14: any = _errs95 === errors;if(props0 !== true && props1 !== undefined){if(props1 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props1);}}valid0 = valid14;}else if(tag0 === "planMessage"){const _errs173: any = errors;if(errors === _errs173){if(data && typeof data == "object" && !Array.isArray(data)){let missing12: any;if((data.kind === undefined) && (missing12 = "kind")){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing12}}];return false;}else {if(data.kind !== undefined){let data92: any = data.kind;const _errs176: any = errors;if(typeof data92 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("planMessage" !== data92){validateQueueItemSummary.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "planMessage"}}];return false;}var valid28: any = _errs176 === errors;}else {var valid28: any = true;}if(valid28){const tag3: any = data.state;if(typeof tag3 == "string"){if(tag3 === "queued"){const _errs178: any = errors;if(errors === _errs178){if(data && typeof data == "object" && !Array.isArray(data)){let missing13: any;if((((((((data.state === undefined) && (missing13 = "state")) || ((data.id === undefined) && (missing13 = "id"))) || ((data.position === undefined) && (missing13 = "position"))) || ((data.planMessage === undefined) && (missing13 = "planMessage"))) || ((data.isSentNow === undefined) && (missing13 = "isSentNow"))) || ((data.createdAt === undefined) && (missing13 = "createdAt"))) || ((data.updatedAt === undefined) && (missing13 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/0/required",keyword:"required",params:{missingProperty: missing13}}];return false;}else {if(data.state !== undefined){let data93: any = data.state;const _errs180: any = errors;if(typeof data93 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("queued" !== data93){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "queued"}}];return false;}var valid31: any = _errs180 === errors;}else {var valid31: any = true;}if(valid31){if(data.id !== undefined){const _errs182: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid31: any = _errs182 === errors;}else {var valid31: any = true;}if(valid31){if(data.position !== undefined){let data95: any = data.position;const _errs183: any = errors;if(!(((typeof data95 == "number") && (!(data95 % 1) && !isNaN(data95))) && (isFinite(data95)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/0/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs183){if((typeof data95 == "number") && (isFinite(data95))){if(data95 > 9007199254740991 || isNaN(data95)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/0/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data95 < 0 || isNaN(data95)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/0/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid31: any = _errs183 === errors;}else {var valid31: any = true;}if(valid31){if(data.planMessage !== undefined){const _errs185: any = errors;if(!(validatePlanMessage.call(this, data.planMessage, {instancePath:instancePath+"/planMessage",parentData:data,parentDataProperty:"planMessage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanMessage.errors : vErrors.concat(validatePlanMessage.errors);errors = vErrors.length;}var valid31: any = _errs185 === errors;}else {var valid31: any = true;}if(valid31){if(data.isSentNow !== undefined){const _errs186: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/2/oneOf/0/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid31: any = _errs186 === errors;}else {var valid31: any = true;}if(valid31){if(data.createdAt !== undefined){const _errs188: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid31: any = _errs188 === errors;}else {var valid31: any = true;}if(valid31){if(data.updatedAt !== undefined){const _errs189: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid31: any = _errs189 === errors;}else {var valid31: any = true;}if(valid31){if(data.notDeliveredReason !== undefined){const _errs190: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/2/oneOf/0/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid31: any = _errs190 === errors;}else {var valid31: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var props2: any = {};props2.state = true;props2.id = true;props2.position = true;props2.planMessage = true;props2.isSentNow = true;props2.createdAt = true;props2.updatedAt = true;props2.notDeliveredReason = true;props2.kind = true;}else if(tag3 === "admitted"){const _errs193: any = errors;if(errors === _errs193){if(data && typeof data == "object" && !Array.isArray(data)){let missing14: any;if((((((((data.state === undefined) && (missing14 = "state")) || ((data.id === undefined) && (missing14 = "id"))) || ((data.position === undefined) && (missing14 = "position"))) || ((data.planMessage === undefined) && (missing14 = "planMessage"))) || ((data.isSentNow === undefined) && (missing14 = "isSentNow"))) || ((data.createdAt === undefined) && (missing14 = "createdAt"))) || ((data.updatedAt === undefined) && (missing14 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/1/required",keyword:"required",params:{missingProperty: missing14}}];return false;}else {if(data.state !== undefined){let data101: any = data.state;const _errs195: any = errors;if(typeof data101 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("admitted" !== data101){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "admitted"}}];return false;}var valid33: any = _errs195 === errors;}else {var valid33: any = true;}if(valid33){if(data.id !== undefined){const _errs197: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid33: any = _errs197 === errors;}else {var valid33: any = true;}if(valid33){if(data.position !== undefined){let data103: any = data.position;const _errs198: any = errors;if(!(((typeof data103 == "number") && (!(data103 % 1) && !isNaN(data103))) && (isFinite(data103)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/1/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs198){if((typeof data103 == "number") && (isFinite(data103))){if(data103 > 9007199254740991 || isNaN(data103)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/1/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data103 < 0 || isNaN(data103)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/1/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid33: any = _errs198 === errors;}else {var valid33: any = true;}if(valid33){if(data.planMessage !== undefined){const _errs200: any = errors;if(!(validatePlanMessage.call(this, data.planMessage, {instancePath:instancePath+"/planMessage",parentData:data,parentDataProperty:"planMessage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanMessage.errors : vErrors.concat(validatePlanMessage.errors);errors = vErrors.length;}var valid33: any = _errs200 === errors;}else {var valid33: any = true;}if(valid33){if(data.isSentNow !== undefined){const _errs201: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/2/oneOf/1/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid33: any = _errs201 === errors;}else {var valid33: any = true;}if(valid33){if(data.createdAt !== undefined){const _errs203: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid33: any = _errs203 === errors;}else {var valid33: any = true;}if(valid33){if(data.updatedAt !== undefined){const _errs204: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid33: any = _errs204 === errors;}else {var valid33: any = true;}if(valid33){if(data.notDeliveredReason !== undefined){const _errs205: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/2/oneOf/1/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid33: any = _errs205 === errors;}else {var valid33: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}if(props2 !== true){props2 = props2 || {};props2.state = true;props2.id = true;props2.position = true;props2.planMessage = true;props2.isSentNow = true;props2.createdAt = true;props2.updatedAt = true;props2.notDeliveredReason = true;}}else if(tag3 === "superseded"){const _errs208: any = errors;if(errors === _errs208){if(data && typeof data == "object" && !Array.isArray(data)){let missing15: any;if((((((((data.state === undefined) && (missing15 = "state")) || ((data.id === undefined) && (missing15 = "id"))) || ((data.position === undefined) && (missing15 = "position"))) || ((data.planMessage === undefined) && (missing15 = "planMessage"))) || ((data.isSentNow === undefined) && (missing15 = "isSentNow"))) || ((data.createdAt === undefined) && (missing15 = "createdAt"))) || ((data.updatedAt === undefined) && (missing15 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/2/required",keyword:"required",params:{missingProperty: missing15}}];return false;}else {if(data.state !== undefined){let data109: any = data.state;const _errs210: any = errors;if(typeof data109 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("superseded" !== data109){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "superseded"}}];return false;}var valid35: any = _errs210 === errors;}else {var valid35: any = true;}if(valid35){if(data.id !== undefined){const _errs212: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid35: any = _errs212 === errors;}else {var valid35: any = true;}if(valid35){if(data.position !== undefined){let data111: any = data.position;const _errs213: any = errors;if(!(((typeof data111 == "number") && (!(data111 % 1) && !isNaN(data111))) && (isFinite(data111)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/2/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs213){if((typeof data111 == "number") && (isFinite(data111))){if(data111 > 9007199254740991 || isNaN(data111)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/2/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data111 < 0 || isNaN(data111)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/2/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid35: any = _errs213 === errors;}else {var valid35: any = true;}if(valid35){if(data.planMessage !== undefined){const _errs215: any = errors;if(!(validatePlanMessage.call(this, data.planMessage, {instancePath:instancePath+"/planMessage",parentData:data,parentDataProperty:"planMessage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanMessage.errors : vErrors.concat(validatePlanMessage.errors);errors = vErrors.length;}var valid35: any = _errs215 === errors;}else {var valid35: any = true;}if(valid35){if(data.isSentNow !== undefined){const _errs216: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/2/oneOf/2/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid35: any = _errs216 === errors;}else {var valid35: any = true;}if(valid35){if(data.createdAt !== undefined){const _errs218: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid35: any = _errs218 === errors;}else {var valid35: any = true;}if(valid35){if(data.updatedAt !== undefined){const _errs219: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid35: any = _errs219 === errors;}else {var valid35: any = true;}if(valid35){if(data.notDeliveredReason !== undefined){const _errs220: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/2/oneOf/2/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid35: any = _errs220 === errors;}else {var valid35: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}if(props2 !== true){props2 = props2 || {};props2.state = true;props2.id = true;props2.position = true;props2.planMessage = true;props2.isSentNow = true;props2.createdAt = true;props2.updatedAt = true;props2.notDeliveredReason = true;}}else if(tag3 === "canceled"){const _errs223: any = errors;if(errors === _errs223){if(data && typeof data == "object" && !Array.isArray(data)){let missing16: any;if((((((((data.state === undefined) && (missing16 = "state")) || ((data.id === undefined) && (missing16 = "id"))) || ((data.position === undefined) && (missing16 = "position"))) || ((data.planMessage === undefined) && (missing16 = "planMessage"))) || ((data.isSentNow === undefined) && (missing16 = "isSentNow"))) || ((data.createdAt === undefined) && (missing16 = "createdAt"))) || ((data.updatedAt === undefined) && (missing16 = "updatedAt"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/3/required",keyword:"required",params:{missingProperty: missing16}}];return false;}else {if(data.state !== undefined){let data117: any = data.state;const _errs225: any = errors;if(typeof data117 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data117){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid37: any = _errs225 === errors;}else {var valid37: any = true;}if(valid37){if(data.id !== undefined){const _errs227: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid37: any = _errs227 === errors;}else {var valid37: any = true;}if(valid37){if(data.position !== undefined){let data119: any = data.position;const _errs228: any = errors;if(!(((typeof data119 == "number") && (!(data119 % 1) && !isNaN(data119))) && (isFinite(data119)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/3/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs228){if((typeof data119 == "number") && (isFinite(data119))){if(data119 > 9007199254740991 || isNaN(data119)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/3/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data119 < 0 || isNaN(data119)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/3/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid37: any = _errs228 === errors;}else {var valid37: any = true;}if(valid37){if(data.planMessage !== undefined){const _errs230: any = errors;if(!(validatePlanMessage.call(this, data.planMessage, {instancePath:instancePath+"/planMessage",parentData:data,parentDataProperty:"planMessage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanMessage.errors : vErrors.concat(validatePlanMessage.errors);errors = vErrors.length;}var valid37: any = _errs230 === errors;}else {var valid37: any = true;}if(valid37){if(data.isSentNow !== undefined){const _errs231: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/2/oneOf/3/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid37: any = _errs231 === errors;}else {var valid37: any = true;}if(valid37){if(data.createdAt !== undefined){const _errs233: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid37: any = _errs233 === errors;}else {var valid37: any = true;}if(valid37){if(data.updatedAt !== undefined){const _errs234: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid37: any = _errs234 === errors;}else {var valid37: any = true;}if(valid37){if(data.notDeliveredReason !== undefined){const _errs235: any = errors;validateQueueItemSummary.errors = [{instancePath:instancePath+"/notDeliveredReason",schemaPath:"#/oneOf/2/oneOf/3/properties/notDeliveredReason/not",keyword:"not",params:{}}];return false;var valid37: any = _errs235 === errors;}else {var valid37: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}if(props2 !== true){props2 = props2 || {};props2.state = true;props2.id = true;props2.position = true;props2.planMessage = true;props2.isSentNow = true;props2.createdAt = true;props2.updatedAt = true;props2.notDeliveredReason = true;}}else if(tag3 === "notDelivered"){const _errs238: any = errors;if(errors === _errs238){if(data && typeof data == "object" && !Array.isArray(data)){let missing17: any;if(((((((((data.state === undefined) && (missing17 = "state")) || ((data.id === undefined) && (missing17 = "id"))) || ((data.position === undefined) && (missing17 = "position"))) || ((data.planMessage === undefined) && (missing17 = "planMessage"))) || ((data.isSentNow === undefined) && (missing17 = "isSentNow"))) || ((data.createdAt === undefined) && (missing17 = "createdAt"))) || ((data.updatedAt === undefined) && (missing17 = "updatedAt"))) || ((data.notDeliveredReason === undefined) && (missing17 = "notDeliveredReason"))){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/4/required",keyword:"required",params:{missingProperty: missing17}}];return false;}else {if(data.state !== undefined){let data125: any = data.state;const _errs240: any = errors;if(typeof data125 !== "string"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("notDelivered" !== data125){validateQueueItemSummary.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "notDelivered"}}];return false;}var valid39: any = _errs240 === errors;}else {var valid39: any = true;}if(valid39){if(data.id !== undefined){const _errs242: any = errors;if(!(validateQueueItemId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid39: any = _errs242 === errors;}else {var valid39: any = true;}if(valid39){if(data.position !== undefined){let data127: any = data.position;const _errs243: any = errors;if(!(((typeof data127 == "number") && (!(data127 % 1) && !isNaN(data127))) && (isFinite(data127)))){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/4/properties/position/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs243){if((typeof data127 == "number") && (isFinite(data127))){if(data127 > 9007199254740991 || isNaN(data127)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/4/properties/position/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data127 < 0 || isNaN(data127)){validateQueueItemSummary.errors = [{instancePath:instancePath+"/position",schemaPath:"#/oneOf/2/oneOf/4/properties/position/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid39: any = _errs243 === errors;}else {var valid39: any = true;}if(valid39){if(data.planMessage !== undefined){const _errs245: any = errors;if(!(validatePlanMessage.call(this, data.planMessage, {instancePath:instancePath+"/planMessage",parentData:data,parentDataProperty:"planMessage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanMessage.errors : vErrors.concat(validatePlanMessage.errors);errors = vErrors.length;}var valid39: any = _errs245 === errors;}else {var valid39: any = true;}if(valid39){if(data.isSentNow !== undefined){const _errs246: any = errors;if(typeof data.isSentNow !== "boolean"){validateQueueItemSummary.errors = [{instancePath:instancePath+"/isSentNow",schemaPath:"#/oneOf/2/oneOf/4/properties/isSentNow/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid39: any = _errs246 === errors;}else {var valid39: any = true;}if(valid39){if(data.createdAt !== undefined){const _errs248: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid39: any = _errs248 === errors;}else {var valid39: any = true;}if(valid39){if(data.updatedAt !== undefined){const _errs249: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid39: any = _errs249 === errors;}else {var valid39: any = true;}if(valid39){if(data.notDeliveredReason !== undefined){const _errs250: any = errors;if(!(validateQueueItemNotDeliveredReason.call(this, data.notDeliveredReason, {instancePath:instancePath+"/notDeliveredReason",parentData:data,parentDataProperty:"notDeliveredReason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemNotDeliveredReason.errors : vErrors.concat(validateQueueItemNotDeliveredReason.errors);errors = vErrors.length;}var valid39: any = _errs250 === errors;}else {var valid39: any = true;}}}}}}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}if(props2 !== true){props2 = props2 || {};props2.state = true;props2.id = true;props2.position = true;props2.planMessage = true;props2.isSentNow = true;props2.createdAt = true;props2.updatedAt = true;props2.notDeliveredReason = true;}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag3}}];return false;}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag3}}];return false;}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid27: any = _errs173 === errors;if(props0 !== true && props2 !== undefined){if(props2 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props2);}}valid0 = valid27;}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key0 in data){if(!props0 || !props0[key0]){validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}}}}}else {validateQueueItemSummary.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateQueueItemSummary.errors = vErrors;return errors === 0;};
// prettier-ignore
validateQueueItemSummary.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentQueueItemListResponse}. */
// prettier-ignore
export const validateAgentQueueItemListResponse: CompiledSchemaCheck<AgentQueueItemListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.items === undefined) && (missing0 = "items")){validateAgentQueueItemListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "items")){validateAgentQueueItemListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.items !== undefined){let data0: any = data.items;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateQueueItemSummary.call(this, data0[i0], {instancePath:instancePath+"/items/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemSummary.errors : vErrors.concat(validateQueueItemSummary.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateAgentQueueItemListResponse.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateAgentQueueItemListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RunQueueStreamChange}. */
// prettier-ignore
export const validateRunQueueStreamChange: CompiledSchemaCheck<RunQueueStreamChange> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunQueueStreamChange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunQueueStreamChange.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.cursor === undefined) && (missing0 = "cursor")) || ((data.item === undefined) && (missing0 = "item"))){validateRunQueueStreamChange.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "cursor") || (key0 === "item"))){validateRunQueueStreamChange.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cursor !== undefined){const _errs2: any = errors;if(!(validateEventCursor.call(this, data.cursor, {instancePath:instancePath+"/cursor",parentData:data,parentDataProperty:"cursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventCursor.errors : vErrors.concat(validateEventCursor.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.item !== undefined){const _errs3: any = errors;if(!(validateQueueItemSummary.call(this, data.item, {instancePath:instancePath+"/item",parentData:data,parentDataProperty:"item",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemSummary.errors : vErrors.concat(validateQueueItemSummary.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateRunQueueStreamChange.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRunQueueStreamChange.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunQueueStreamChange.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RunQueueStreamFrame}. */
// prettier-ignore
export const validateRunQueueStreamFrame: CompiledSchemaCheck<RunQueueStreamFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunQueueStreamFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunQueueStreamFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.changes === undefined) && (missing0 = "changes")){validateRunQueueStreamFrame.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "changes")){validateRunQueueStreamFrame.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.changes !== undefined){let data0: any = data.changes;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length > 50){validateRunQueueStreamFrame.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/maxItems",keyword:"maxItems",params:{limit: 50}}];return false;}else {if(data0.length < 1){validateRunQueueStreamFrame.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateRunQueueStreamChange.call(this, data0[i0], {instancePath:instancePath+"/changes/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunQueueStreamChange.errors : vErrors.concat(validateRunQueueStreamChange.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}}else {validateRunQueueStreamFrame.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateRunQueueStreamFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRunQueueStreamFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunQueueStreamFrame.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentQueueItemSubscribeRequest}. */
// prettier-ignore
export const validateAgentQueueItemSubscribeRequest: CompiledSchemaCheck<AgentQueueItemSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateAgentQueueItemSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "childHandle")) || (key0 === "afterCursor"))){validateAgentQueueItemSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.childHandle !== undefined){const _errs3: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.afterCursor !== undefined){const _errs4: any = errors;if(!(validateEventCursor.call(this, data.afterCursor, {instancePath:instancePath+"/afterCursor",parentData:data,parentDataProperty:"afterCursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventCursor.errors : vErrors.concat(validateEventCursor.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateAgentQueueItemSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentQueueItemCancelRequest}. */
// prettier-ignore
export const validateAgentQueueItemCancelRequest: CompiledSchemaCheck<AgentQueueItemCancelRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemCancelRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemCancelRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.queueItemId === undefined) && (missing0 = "queueItemId")){validateAgentQueueItemCancelRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "queueItemId") || (key0 === "childHandle"))){validateAgentQueueItemCancelRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.queueItemId !== undefined){const _errs2: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.childHandle !== undefined){const _errs3: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentQueueItemCancelRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemCancelRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemCancelRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1119: any = {"type":"object","additionalProperties":false,"properties":{"queueItemId":{"$ref":"#/$defs/QueueItemId","description":"The item."},"state":{"description":"Always `canceled`.","type":"string","enum":["canceled"]}},"required":["queueItemId","state"],"description":"The canceled message."};
/** Checks that a value is a {@link AgentQueueItemCancelResponse}. */
// prettier-ignore
export const validateAgentQueueItemCancelResponse: CompiledSchemaCheck<AgentQueueItemCancelResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemCancelResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemCancelResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.queueItemId === undefined) && (missing0 = "queueItemId")) || ((data.state === undefined) && (missing0 = "state"))){validateAgentQueueItemCancelResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "queueItemId") || (key0 === "state"))){validateAgentQueueItemCancelResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.queueItemId !== undefined){const _errs2: any = errors;if(!(validateQueueItemId.call(this, data.queueItemId, {instancePath:instancePath+"/queueItemId",parentData:data,parentDataProperty:"queueItemId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs3: any = errors;if(typeof data1 !== "string"){validateAgentQueueItemCancelResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data1 === "canceled")){validateAgentQueueItemCancelResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema1119.properties.state.enum}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentQueueItemCancelResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemCancelResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemCancelResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link AgentQueueItemReorderRequest}. */
// prettier-ignore
export const validateAgentQueueItemReorderRequest: CompiledSchemaCheck<AgentQueueItemReorderRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentQueueItemReorderRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentQueueItemReorderRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.queueItemIds === undefined) && (missing0 = "queueItemIds"))){validateAgentQueueItemReorderRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "childHandle")) || (key0 === "queueItemIds"))){validateAgentQueueItemReorderRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.childHandle !== undefined){const _errs3: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.queueItemIds !== undefined){let data2: any = data.queueItemIds;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data2)){if(data2.length < 1){validateAgentQueueItemReorderRequest.errors = [{instancePath:instancePath+"/queueItemIds",schemaPath:"#/properties/queueItemIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validateQueueItemId.call(this, data2[i0], {instancePath:instancePath+"/queueItemIds/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}if(valid1){let i1: any = data2.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data2[i1], data2[j0])){validateAgentQueueItemReorderRequest.errors = [{instancePath:instancePath+"/queueItemIds",schemaPath:"#/properties/queueItemIds/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validateAgentQueueItemReorderRequest.errors = [{instancePath:instancePath+"/queueItemIds",schemaPath:"#/properties/queueItemIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateAgentQueueItemReorderRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentQueueItemReorderRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentQueueItemReorderRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
