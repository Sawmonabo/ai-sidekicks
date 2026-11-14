// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's work in its provider's own cloud: a task with attempts, or a cloud session.

import type { NonBlankText } from "./internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { ProviderId } from "./provider/id.js";
import type { SessionId } from "./session/id.js";

/** The longest cloud task id the daemon accepts. */
export const CLOUD_TASK_ID_MAX_LEN = 256 as const;

/** The longest cloud environment label the daemon accepts. */
export const CLOUD_ENVIRONMENT_LABEL_MAX_LEN = 256 as const;

/** The most attempts one cloud task runs: its provider's own bound. */
export const CLOUD_TASK_ATTEMPTS_MAX = 4 as const;

/** Every reason an account is not entitled to the cloud, for the session menu that shows why. */
export const CLOUD_ACCOUNT_NOT_ENTITLED_REASONS = [
  "signInKindNotEntitled",
  "subscriptionRequired",
] as const;

/**
 * The id the provider gave its cloud work: a task's id, or a cloud session's id.
 */
export type CloudTaskId = string & { readonly __brand: "CloudTaskId" };
/**
 * Why the account is not entitled to the provider's cloud: it is signed in a way that lacks it,
 * or it lacks the subscription it needs.
 */
export type CloudAccountNotEntitledReason = "signInKindNotEntitled" | "subscriptionRequired";
/**
 * What the provider reported when a task's attempt was applied to the session's folder: all of
 * it, part of it with the paths it skipped and the paths in conflict, or an error in the
 * provider's own words.
 */
export type CloudBringBack =
  | {
      outcome: "applied";
    }
  | {
      outcome: "partial";
      /**
       * The paths it skipped.
       */
      skippedPaths: string[];
      /**
       * The paths in conflict.
       */
      conflictingPaths: string[];
    }
  | {
      outcome: "error";
      /**
       * The provider's message.
       */
      message: string;
    };
/**
 * A state of a cloud task its provider reported without an error.
 */
export type CloudTaskState = "pending" | "ready" | "applied";
/**
 * One piece of a session's cloud work, with only the state its provider reported.
 */
export type CloudWork =
  | {
      /**
       * Always `task`.
       */
      kind: "task";
      /**
       * The task.
       */
      taskId: CloudTaskId;
      /**
       * The session that sent it.
       */
      sessionId: SessionId;
      /**
       * The provider whose cloud runs it.
       */
      provider: ProviderId;
      /**
       * The environment it runs in.
       */
      environment: string;
      /**
       * How many attempts it runs.
       */
      attempts: number;
      /**
       * The last bring-back of this task, or `null` before the first.
       */
      bringBack: CloudBringBack | null;
      /**
       * Its state.
       */
      state: CloudTaskState;
    }
  | {
      /**
       * Always `task`.
       */
      kind: "task";
      /**
       * The task.
       */
      taskId: CloudTaskId;
      /**
       * The session that sent it.
       */
      sessionId: SessionId;
      /**
       * The provider whose cloud runs it.
       */
      provider: ProviderId;
      /**
       * The environment it runs in.
       */
      environment: string;
      /**
       * How many attempts it runs.
       */
      attempts: number;
      /**
       * The last bring-back of this task, or `null` before the first.
       */
      bringBack: CloudBringBack | null;
      /**
       * Always `error`.
       */
      state: "error";
      /**
       * The provider's own message.
       */
      errorMessage: string;
    }
  | {
      /**
       * Always `session`.
       */
      kind: "session";
      /**
       * The cloud session.
       */
      taskId: CloudTaskId;
      /**
       * The session that sent it.
       */
      sessionId: SessionId;
      /**
       * The provider whose cloud holds it.
       */
      provider: ProviderId;
      /**
       * Always `submitted`.
       */
      state: "submitted";
      /**
       * Its address on the provider's site.
       */
      url: string;
    };
/**
 * What bringing cloud work back did: for a task, what the apply reported; for a cloud session,
 * the new session the returned work opened as.
 */
export type CloudTaskApplyResponse =
  | {
      kind: "task";
      /**
       * What the apply reported.
       */
      bringBack: CloudBringBack;
    }
  | {
      kind: "session";
      /**
       * The new session.
       */
      sessionId: SessionId;
    };

/**
 * The `cloud.accountNotEntitled` refusal's details: why, and the session's provider, so the
 * screen draws that provider's own sentence and remedy.
 */
export interface CloudAccountNotEntitledDetails {
  /**
   * Why.
   */
  reason: CloudAccountNotEntitledReason;
  /**
   * The session's provider.
   */
  provider: ProviderId;
}
/**
 * `cloud.task.start`: sends one message to the session's provider's cloud instead of to the
 * agent. `environment` and `attempts` belong to a task with attempts: the environment's label and
 * how many attempts to run.
 */
export interface CloudTaskStartRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The message.
   */
  prompt: NonBlankText;
  /**
   * The environment's label.
   */
  environment?: string;
  /**
   * How many attempts to run.
   */
  attempts?: number;
}
/**
 * The new work's id.
 */
export interface CloudTaskStartResponse {
  /**
   * The new work.
   */
  taskId: CloudTaskId;
}
/**
 * `cloud.task.subscribe`: the session whose cloud work the subscription follows.
 */
export interface CloudTaskSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The session's whole set of cloud work, sent first on subscribing and again on each change, so a
 * subscriber never composes changes into a set of its own.
 */
export interface CloudTaskSubscribeFrame {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Its cloud work.
   */
  tasks: CloudWork[];
}
/**
 * `cloud.task.read`: the cloud work to read.
 */
export interface CloudTaskReadRequest {
  /**
   * The work.
   */
  taskId: CloudTaskId;
}
/**
 * `cloud.task.diff.read` and `cloud.task.apply`: one task's attempt, `attempt` picking one of a
 * task's several; for `cloud.task.apply` on a cloud session, the session to pull back.
 */
export interface CloudTaskAttemptRequest {
  /**
   * The work.
   */
  taskId: CloudTaskId;
  /**
   * The attempt.
   */
  attempt?: number;
}
/**
 * The attempt's diff as the provider prints it, for the review pane to show read-only.
 */
export interface CloudTaskDiffReadResponse {
  /**
   * The task.
   */
  taskId: CloudTaskId;
  /**
   * The attempt.
   */
  attempt: number;
  /**
   * Its diff.
   */
  diff: string;
}
/**
 * The `cloud.task.updated` payload: cloud work was sent, its provider reported a new state, or it
 * was brought back. It carries the whole work as it now stands, so the session's record of its
 * cloud work is the latest of these per id.
 */
export interface CloudTaskUpdatedPayload {
  /**
   * The work.
   */
  task: CloudWork;
}

export {
  validateCloudBringBack,
  validateCloudTaskId,
  validateCloudTaskState,
  validateCloudTaskUpdatedPayload,
  validateCloudWork,
} from "./checks/cloud.js";

/** The methods of {@link CLOUD_METHOD_DESCRIPTORS}, each with its kind. */
export interface CloudMethodDescriptors {
  readonly "cloud.task.start": {
    readonly method: "cloud.task.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "cloud.task.subscribe": {
    readonly method: "cloud.task.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "cloud.task.read": {
    readonly method: "cloud.task.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "cloud.task.diff.read": {
    readonly method: "cloud.task.diff.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "cloud.task.apply": {
    readonly method: "cloud.task.apply";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link CLOUD_METHOD_DESCRIPTORS}. */
export interface CloudMethodTypes {
  readonly "cloud.task.start": {
    readonly params: CloudTaskStartRequest;
    readonly result: CloudTaskStartResponse;
  };
  readonly "cloud.task.subscribe": {
    readonly params: CloudTaskSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: CloudTaskSubscribeFrame;
  };
  readonly "cloud.task.read": { readonly params: CloudTaskReadRequest; readonly result: CloudWork };
  readonly "cloud.task.diff.read": {
    readonly params: CloudTaskAttemptRequest;
    readonly result: CloudTaskDiffReadResponse;
  };
  readonly "cloud.task.apply": {
    readonly params: CloudTaskAttemptRequest;
    readonly result: CloudTaskApplyResponse;
  };
}
/** The `cloud.*` methods. */
export const CLOUD_METHOD_DESCRIPTORS: CloudMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "cloud.task.start": /* @__PURE__ */ Object.freeze({
    method: "cloud.task.start",
    procedureType: "mutation",
    mutating: true,
  }),
  "cloud.task.subscribe": /* @__PURE__ */ Object.freeze({
    method: "cloud.task.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "cloud.task.read": /* @__PURE__ */ Object.freeze({
    method: "cloud.task.read",
    procedureType: "query",
    mutating: false,
  }),
  "cloud.task.diff.read": /* @__PURE__ */ Object.freeze({
    method: "cloud.task.diff.read",
    procedureType: "query",
    mutating: false,
  }),
  "cloud.task.apply": /* @__PURE__ */ Object.freeze({
    method: "cloud.task.apply",
    procedureType: "mutation",
    mutating: true,
  }),
});
