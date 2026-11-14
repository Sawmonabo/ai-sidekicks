// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Interventions on a running run: the interrupt and the faster-model retry a caller sends through `agent.run.intervene`, the daemon's answer, the states an intervention passes through, and an interrupt's stored record.

import type { ProviderTurnId } from "../turn.js";
import type { RunId } from "./id.js";
import type { QueueItemId } from "./queue.js";

/** Every state an intervention passes through, `requested` first. */
export const INTERVENTION_STATES = [
  "requested",
  "accepted",
  "applied",
  "rejected",
  "degraded",
  "expired",
  "failed",
] as const;

/**
 * Identifies one intervention on a run.
 */
export type InterventionId = string & { readonly __brand: "InterventionId" };
/**
 * How a caller acts on a live run, as its intervention row records it: interrupt, or retry on a
 * faster model, which the daemon carries out by stopping the turn and sending its message again on
 * the named model. A person's message mid-turn is a queue send, never an intervention.
 */
export type InterventionType = "interrupt" | "fasterModelRetry";
/**
 * Where an intervention stands, from request to outcome; each state has its own event. `failed`
 * is a dispatch that threw, so a request never stays `accepted` for good.
 */
export type InterventionState =
  | "requested"
  | "accepted"
  | "applied"
  | "rejected"
  | "degraded"
  | "expired"
  | "failed";
/**
 * A limit the daemon stops a run at by itself: the step limit on a provider that does not bound a
 * turn's steps, or the spend or token limit. Only the daemon's own stop records one.
 */
export type RunLimit = "stepLimit" | "spendLimit" | "tokenLimit";
/**
 * A person's interrupt as its `interventions` row stores it: what becomes of the waiting
 * messages, the message delivered first and the person's reason, never a limit.
 */
export type PersonInterruptRecord =
  | {
      pending: "nextTurn";
      /**
       * The message `Send now` puts ahead of the rest.
       */
      deliverFirst?: QueueItemId;
      /**
       * The person's reason.
       */
      reason?: string;
      /**
       * Never present: only the daemon's own stop carries a limit.
       */
      limit?: never;
    }
  | {
      pending: "returnToDraft";
      /**
       * Never present: a message delivered first goes as the next turn.
       */
      deliverFirst?: never;
      /**
       * The person's reason.
       */
      reason?: string;
      /**
       * Never present: only the daemon's own stop carries a limit.
       */
      limit?: never;
    };
/**
 * The stored `payload` of an interrupt's `interventions` row: a person's, the daemon's own at a
 * limit, or the daemon's own for an undo. The three arms are disjoint: a person's carries
 * `pending` and no limit, a limit's only its limit, an undo's only its `undoKey`, so a person's
 * reason never reads as a limit and a mixed row is refused.
 */
export type InterruptInterventionRecord =
  | PersonInterruptRecord
  | LimitInterruptRecord
  | UndoInterruptRecord;
/**
 * A caller's request to interrupt or retry a run; a person's steer is an `agent.queueItem.create`,
 * never an intervention. `fasterModelRetry` resends a turn the provider holds for a safety check
 * on `model`.
 */
export type AgentRunInterveneRequest =
  | ((
      | {
          pending: "nextTurn";
          /**
           * The run interrupted.
           */
          targetRunId: RunId;
          /**
           * The run version the caller last saw; an absent or outdated one is refused,
           * never applied.
           */
          expectedRunVersion: number;
          /**
           * The caller's key, stored with the intervention, so an identical retry answers
           * the recorded outcome.
           */
          clientIdempotencyKey: string;
          /**
           * The person's reason.
           */
          reason?: string;
          /**
           * The message `Send now` puts ahead of the rest.
           */
          deliverFirst?: QueueItemId;
        }
      | {
          pending: "returnToDraft";
          /**
           * The run interrupted.
           */
          targetRunId: RunId;
          /**
           * The run version the caller last saw; an absent or outdated one is refused,
           * never applied.
           */
          expectedRunVersion: number;
          /**
           * The caller's key, stored with the intervention, so an identical retry answers
           * the recorded outcome.
           */
          clientIdempotencyKey: string;
          /**
           * The person's reason.
           */
          reason?: string;
          /**
           * Never present: a message delivered first goes as the next turn.
           */
          deliverFirst?: never;
        }
    ) & {
      type: "interrupt";
    })
  | {
      type: "fasterModelRetry";
      /**
       * The run retried.
       */
      targetRunId: RunId;
      /**
       * The run version the caller last saw; an absent or outdated one is refused, never
       * applied.
       */
      expectedRunVersion: number;
      /**
       * The caller's key, stored with the intervention, so an identical retry answers the
       * recorded outcome.
       */
      clientIdempotencyKey: string;
      /**
       * The provider's id of the turn held.
       */
      expectedTurnId: ProviderTurnId;
      /**
       * The model the turn is sent again on.
       */
      model: string;
    };
/**
 * The daemon's answer to an intervention request. A refused intervention is a normal answer in
 * state `rejected` with a machine-readable `rejectionReason`, not a JSON-RPC error; one whose
 * dispatch threw, never completed or was never sent answers `failed` with its `failureReason`,
 * the error's code or message, the restart that lost the outcome or the run's end and
 * continue before the dispatch, and a retry under the same key answers the same. No other
 * state carries a reason.
 */
export type AgentRunInterveneResponse =
  | {
      state: "requested";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "accepted";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "applied";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "degraded";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "expired";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "rejected";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The machine-readable cause, such as `provider.capability.unsupported`.
       */
      rejectionReason: string;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "failed";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The thrown error's code, else its message, or why it never completed or was never
       * sent.
       */
      failureReason: string;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
    };

/**
 * The daemon's own stop at a limit as its `interventions` row stores it, with no device: the
 * limit and the turn the stop cut, so a restart settles the run and ends that turn with that
 * cause. The waiting messages stay waiting.
 */
export interface LimitInterruptRecord {
  /**
   * The limit the run reached.
   */
  limit: RunLimit;
  /**
   * The turn the stop cut; absent when no turn of the run was open.
   */
  turnNumber?: number;
}
/**
 * The daemon's own interrupt for an undo as its `interventions` row stores it, with no device:
 * the undo it stopped the run for, named by its idempotency key. The waiting messages stay
 * waiting.
 */
export interface UndoInterruptRecord {
  /**
   * The idempotency key of the undo the interrupt serves.
   */
  undoKey: string;
}

export {
  validateAgentRunInterveneRequest,
  validateInterventionId,
  validateInterventionType,
} from "../checks/run/intervention.js";
