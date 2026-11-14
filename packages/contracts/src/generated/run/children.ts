// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A child's own controls: steer, interrupt and pause one provider helper inside a run, and stop every agent a session dispatched.

import type { AgentTreeMember, ChildHandle } from "../agent/tree.js";
import type { SessionId } from "../session/id.js";
import type { RunId } from "./id.js";
import type { QueueItemId } from "./queue.js";
import type { RunState } from "./state.js";

/**
 * The refusal of a child control: the child has ended or the provider refused the act. A
 * handle that names no child of the run is `agent.childRun.notFound`, and a hold lost before
 * a continue is a result, never this refusal.
 */
export const AGENT_CHILD_RUN_CONTROL_REFUSED_CODE = "agent.childRun.controlRefused" as const;

/** Every reason a child control is refused. */
export const AGENT_CHILD_RUN_CONTROL_REFUSED_REASONS = ["childEnded", "providerRefused"] as const;

/**
 * Where the child stands after the set; a lost hold never comes with `paused: true`.
 */
export type AgentChildRunPausedUpdateResponse =
  | {
      /**
       * The child.
       */
      childHandle: ChildHandle;
      /**
       * Always `true`.
       */
      paused: true;
      /**
       * A lost hold never leaves the child paused.
       */
      holdLost?: never;
    }
  | {
      /**
       * The child.
       */
      childHandle: ChildHandle;
      /**
       * Always `false`.
       */
      paused: false;
      /**
       * Present only when the hold was lost.
       */
      holdLost?: true;
    };
/**
 * The run state a stop leaves a child in: `stopped` where the provider's stop is final,
 * `interrupted` where a send can continue it.
 */
export type ChildStoppedState = "stopped" | "interrupted";
/**
 * One child's stop: stopped, with the state it left the child in, already ended, or failed with
 * the daemon's reason.
 */
export type ChildStopOutcome =
  | {
      outcome: "stopped";
      /**
       * The child.
       */
      child: AgentTreeMember;
      /**
       * The state the stop left the child in.
       */
      state: ChildStoppedState;
      /**
       * Only a failed stop carries a reason.
       */
      reason?: never;
    }
  | {
      outcome: "alreadyEnded";
      /**
       * The child.
       */
      child: AgentTreeMember;
      /**
       * Only a stopped child carries the state the stop left it in.
       */
      state?: never;
      /**
       * Only a failed stop carries a reason.
       */
      reason?: never;
    }
  | {
      outcome: "failed";
      /**
       * The child.
       */
      child: AgentTreeMember;
      /**
       * Only a stopped child carries the state the stop left it in.
       */
      state?: never;
      /**
       * The daemon's reason.
       */
      reason: string;
    };
/**
 * Why a child control was refused.
 */
export type AgentChildRunControlRefusedReason = "childEnded" | "providerRefused";

/**
 * Sends a message onto one child's own queue (`agent.childRun.steer`), where it waits for the
 * child's next step as a pending row the lead's queue verbs reach with `childHandle`. It names
 * the helper by its session and handle, so it reaches a helper whose parent run has ended, and it
 * answers as `agent.queueItem.create` does.
 */
export interface AgentChildRunSteerRequest {
  /**
   * The session the helper works in.
   */
  sessionId: SessionId;
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * The words.
   */
  content: string;
  /**
   * A retry's key is the failed steer's queue item id, so a second press answers the first.
   */
  clientIdempotencyKey: string;
  /**
   * A retry of the child's steer that reads not delivered, with its own words: it goes again as
   * a new message at the end of the child's queue, and the failed one reads `superseded`.
   */
  replacesQueueItemId?: QueueItemId;
}
/**
 * Interrupts one child, and only that child (`agent.childRun.interrupt`); its pending messages go
 * as its next turn, with `deliver_first`, the row `Send now` was pressed on, ahead of the rest.
 */
export interface AgentChildRunInterruptRequest {
  /**
   * The run the child belongs to.
   */
  targetRunId: RunId;
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * The parent run's version the caller last observed.
   */
  expectedRunVersion: number;
  /**
   * A retry under the same key answers what the first saved.
   */
  clientIdempotencyKey: string;
  /**
   * The pending row that goes first.
   */
  deliverFirst?: QueueItemId;
}
/**
 * Where the child stands after the interrupt. A child that had already finished answers the state
 * it finished in.
 */
export interface AgentChildRunInterruptResponse {
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * Where it stands.
   */
  state: RunState;
}
/**
 * Pauses one child (`paused: true`) or continues it (`paused: false`)
 * (`agent.childRun.paused.update`). A repeated set answers the child's standing and takes no
 * second hold.
 */
export interface AgentChildRunPausedUpdateRequest {
  /**
   * The run the child belongs to.
   */
  targetRunId: RunId;
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * Whether to pause or continue it.
   */
  paused: boolean;
  /**
   * The parent run's version the caller last observed.
   */
  expectedRunVersion: number;
}
/**
 * Stops every agent the session dispatched at every depth (`agent.childRun.stopAll`), a helper an
 * earlier lead run left running included: the daemon walks its own index, one stop per agent,
 * never relayed through the lead.
 */
export interface AgentChildRunStopAllRequest {
  /**
   * The session whose agents to stop.
   */
  sessionId: SessionId;
}
/**
 * Every child the stop reached, each with its own outcome; nothing is atomic.
 */
export interface AgentChildRunStopAllResponse {
  /**
   * One row per child.
   */
  children: ChildStopOutcome[];
}
/**
 * The details an `agent.childRun.controlRefused` refusal carries.
 */
export interface AgentChildRunControlRefusedDetails {
  /**
   * Why it was refused.
   */
  reason: AgentChildRunControlRefusedReason;
}

export {
  validateAgentChildRunControlRefusedDetails,
  validateAgentChildRunControlRefusedReason,
  validateAgentChildRunInterruptRequest,
  validateAgentChildRunInterruptResponse,
  validateAgentChildRunPausedUpdateRequest,
  validateAgentChildRunPausedUpdateResponse,
  validateAgentChildRunSteerRequest,
  validateAgentChildRunStopAllRequest,
  validateAgentChildRunStopAllResponse,
  validateChildStopOutcome,
  validateChildStoppedState,
} from "../checks/run/children.js";
