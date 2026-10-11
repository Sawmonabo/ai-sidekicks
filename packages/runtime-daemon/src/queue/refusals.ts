// The run queue's refusals of a send or a change: an item it does not hold, one no longer waiting
// or not given back by its provider, and a skill pick its provider does not list.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  QUEUE_CHANGE_REFUSED_CODE,
  QUEUE_ITEM_NOT_FOUND_CODE,
  type QueueChangeRefusedDetails,
  type QueueChangeRefusedReason,
  type QueueItemId,
  type QueuedSkillPick,
} from "@ai-sidekicks/contracts/run/queue";
import {
  SKILL_PATH_REFUSED_CODE,
  type SkillPathRefusedDetails,
} from "@ai-sidekicks/contracts/skill";

import { DaemonDomainError } from "../ipc/domain-error.js";
import type { QueueWithdrawal } from "./delivery.js";
import type { QueueItemRecord } from "./store.js";

/** A `queue.change_refused` refusal for `reason`, worded by `message`. */
export function changeRefused(
  reason: QueueChangeRefusedReason,
  message: string,
): DaemonDomainError {
  const detail: QueueChangeRefusedDetails = { reason };
  return new DaemonDomainError(message, {
    code: QUEUE_CHANGE_REFUSED_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
    detail: { ...detail },
  });
}

/** The refusal of a change to an item no longer waiting, by how it left the queue. */
export function leftQueueRefusal(item: QueueItemRecord): DaemonDomainError {
  switch (item.state) {
    case "admitted":
      return unreturnedRefusal(item.id, "taken");
    case "not_delivered":
      return unreturnedRefusal(item.id, "not_delivered");
    default:
      return changeRefused("already_taken", `Queue item ${item.id} has left the queue`);
  }
}

/** The refusal of a change to an item its provider did not give back, or the agent took. */
export function unreturnedRefusal(
  queueItemId: QueueItemId,
  withdrawal: Exclude<QueueWithdrawal, "returned">,
): DaemonDomainError {
  return withdrawal === "taken"
    ? changeRefused("already_taken", `Queue item ${queueItemId} has been taken by the agent`)
    : changeRefused(
        "not_delivered",
        `Queue item ${queueItemId} was not given back by the provider and reads not delivered`,
      );
}

/** The refusal of a skill pick the session's provider does not list. */
export function skillNotListed(pick: QueuedSkillPick): DaemonDomainError {
  const detail: SkillPathRefusedDetails = { path: pick.folderPath, reason: "not_listed" };
  return new DaemonDomainError(
    `The skill ${pick.name} in ${pick.folderPath} is not one the session's provider lists`,
    { code: SKILL_PATH_REFUSED_CODE, detail: { ...detail } },
  );
}

/** The refusal of a change to an item the queue does not hold. */
export function queueItemNotFound(queueItemId: QueueItemId): DaemonDomainError {
  return new DaemonDomainError(`Queue item ${queueItemId} is not in this queue`, {
    code: QUEUE_ITEM_NOT_FOUND_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { queueItemId },
  });
}
