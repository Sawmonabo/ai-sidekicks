// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The message queue: every message the person sends waits here until the agent takes it at its next step. Also the `agent.queueItem.*` event payloads and the frame `agent.queueItem.subscribe` sends.

import type { ChildHandle } from "../agent/tree.js";
import type { AttachmentReferenceList } from "../artifacts/attachment-reference.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { PlanId } from "../plan.js";
import type { QuestionId } from "../question.js";
import type { WorkspaceId } from "../repo/mount.js";
import type { SessionReviewTarget } from "../session/controls/methods.js";
import type { EventCursor, SessionId } from "../session/id.js";
import type { DeviceId } from "../trust-statement.js";
import type { RunId } from "./id.js";

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

export {
  validateAgentQueueItemAdmittedPayload,
  validateAgentQueueItemCanceledPayload,
  validateAgentQueueItemCreatedPayload,
  validateAgentQueueItemNotDeliveredPayload,
  validateAgentQueueItemSupersededPayload,
  validatePlanMessage,
  validatePlanMessageKind,
  validateQueueItemId,
  validateQueueItemNotDeliveredReason,
  validateQueueItemSummary,
  validateUserMessageSentPayload,
} from "../checks/run/queue.js";
