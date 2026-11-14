// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The plan record and the one call that answers it.

import type { SchemaCheck } from "../schema-check.js";
import type { ArtifactId } from "./artifacts/id.js";
import { validatePlanResolveRequest, validatePlanResolveResponse } from "./checks/plan.js";
import type { ProviderId } from "./provider/id.js";
import type { RunId } from "./run/id.js";
import type { PermissionLevel } from "./session/controls/methods.js";
import type { SessionId } from "./session/id.js";
import type { DeviceId } from "./trust-statement.js";

/**
 * The daemon-minted id of one plan record, stable across a reload and every device.
 */
export type PlanId = string & { readonly __brand: "PlanId" };
/**
 * Where a plan stands: `waiting` while its card is up, `accepted` after it is built here,
 * `handedOff` after it is built in a fresh session, and `open` after the person keeps planning,
 * which answers the held request and leaves the plan as a record the next plan replaces.
 */
export type PlanState = "waiting" | "accepted" | "handedOff" | "open";
/**
 * Why a plan's hold ended with no verdict: its turn was interrupted, the provider withdrew its
 * request, its run ended (a restart of the background service among the ways a run ends), a newer
 * plan of the same session took its place, or the fresh session it was handed to was archived,
 * closed or purged before its first turn was admitted.
 */
export type PlanHoldEndedReason =
  | "interrupted"
  | "withdrawn"
  | "runEnded"
  | "superseded"
  | "freshSessionGone";
/**
 * A step of a hand-off after the plan reads handed off, in the order they run: the fresh
 * session's birth, its folder's bind, the planning transcript's file, the plan's copy into the
 * fresh session, its activation, and the plan sent as its first message.
 */
export type PlanHandOffStep =
  | "birth"
  | "bind"
  | "transcriptFile"
  | "seedPlan"
  | "activation"
  | "seedMessage";
/**
 * `plan.resolve`: the verdict on one plan, keep planning, build here, or build in a fresh
 * session; only `fresh` names the session to mint.
 */
export type PlanResolveRequest =
  | {
      verdict: "keep";
      /**
       * The plan.
       */
      planId: PlanId;
    }
  | {
      verdict: "build";
      /**
       * The plan.
       */
      planId: PlanId;
    }
  | {
      verdict: "fresh";
      /**
       * The plan.
       */
      planId: PlanId;
      /**
       * The session to mint.
       */
      fresh: PlanFreshSession;
    };
/**
 * The `plan.resolve` result: the plan's state after the verdict, or the state an earlier verdict
 * settled, never `waiting`; only a handed-off plan names its fresh session, so the caller switches
 * to it without another read.
 */
export type PlanResolveResponse =
  | {
      state: "accepted";
      /**
       * The plan.
       */
      planId: PlanId;
    }
  | {
      state: "handedOff";
      /**
       * The plan.
       */
      planId: PlanId;
      /**
       * The fresh session.
       */
      freshSessionId: SessionId;
    }
  | {
      state: "open";
      /**
       * The plan.
       */
      planId: PlanId;
    };

/**
 * `plan.proposed`: the plan as the agent wrote it, never read off the disk, with the daemon's
 * count of its top-level steps and the files it names, and the artifact that keeps it, written
 * before this event. `planFilePath` is present only where the provider wrote the plan as a file;
 * `holdsRequest` says a held provider request waits on the verdict.
 */
export interface PlanProposedPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run that proposed it.
   */
  runId: RunId;
  /**
   * Its title.
   */
  title: string;
  /**
   * Its text.
   */
  text: string;
  /**
   * How many top-level steps it has.
   */
  stepCount: number;
  /**
   * How many files it names.
   */
  fileCount: number;
  /**
   * The file the provider wrote it to.
   */
  planFilePath?: string;
  /**
   * The artifact that keeps the plan.
   */
  artifactId: ArtifactId;
  /**
   * Whether a held provider request waits on the verdict.
   */
  holdsRequest: boolean;
}
/**
 * `plan.accepted`: the plan is being built in its own session.
 */
export interface PlanAcceptedPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The device whose verdict it was.
   */
  deviceId: DeviceId;
}
/**
 * `plan.kept`: the person kept planning; the provider went back to planning and the plan stays a
 * record.
 */
export interface PlanKeptPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The device whose verdict it was.
   */
  deviceId: DeviceId;
}
/**
 * `plan.hold.ended`: the plan's hold ended with no verdict. The plan settles `open`, its card
 * closing on every device and the plan staying readable, except after `freshSessionGone`, where it
 * waits again with its card up.
 */
export interface PlanHoldEndedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * Why the hold ended.
   */
  reason: PlanHoldEndedReason;
}
/**
 * `plan.handedOff`: the plan seeded a fresh session, which the system message opens.
 */
export interface PlanHandedOffPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The planning session.
   */
  sessionId: SessionId;
  /**
   * The session it seeded.
   */
  freshSessionId: SessionId;
  /**
   * The device whose verdict it was.
   */
  deviceId: DeviceId;
}
/**
 * `plan.handOff.failed`: a hand-off step did not finish; the plan stays handed off, and the next
 * `fresh` verdict runs the unfinished steps again.
 */
export interface PlanHandOffFailedPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The fresh session.
   */
  freshSessionId: SessionId;
  /**
   * The step that did not finish.
   */
  step: PlanHandOffStep;
  /**
   * Why the step did not finish, in the words of its failure.
   */
  cause: string;
}
/**
 * The details a `plan.handOffUnfinished` refusal carries: the fresh session and the step that did
 * not finish.
 */
export interface PlanHandOffUnfinishedDetails {
  /**
   * The fresh session.
   */
  freshSessionId: SessionId;
  /**
   * The step that did not finish.
   */
  step: PlanHandOffStep;
}
/**
 * The session a `fresh` verdict mints: the provider it runs and the level it starts at, the
 * planning session's level or, where that provider cannot give it, one of that provider's levels
 * the person picks. The rest is the planning session's: the same project and worktree, the
 * provider's current account, and the plan as the seed.
 */
export interface PlanFreshSession {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * The level.
   */
  level: PermissionLevel;
}

export {
  validatePlanAcceptedPayload,
  validatePlanFreshSession,
  validatePlanHandOffFailedPayload,
  validatePlanHandOffStep,
  validatePlanHandedOffPayload,
  validatePlanHoldEndedPayload,
  validatePlanHoldEndedReason,
  validatePlanId,
  validatePlanKeptPayload,
  validatePlanProposedPayload,
  validatePlanResolveRequest,
  validatePlanResolveResponse,
  validatePlanState,
} from "./checks/plan.js";

/** The methods of {@link PLAN_METHOD_DESCRIPTORS}, each with its checks. */
export interface PlanMethodDescriptors {
  readonly "plan.resolve": {
    readonly method: "plan.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PlanResolveRequest>;
    readonly responseCheck: SchemaCheck<PlanResolveResponse>;
  };
}
/** The `plan.*` methods a client calls. */
export const PLAN_METHOD_DESCRIPTORS: PlanMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "plan.resolve": /* @__PURE__ */ Object.freeze({
    method: "plan.resolve",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePlanResolveRequest,
    responseCheck: validatePlanResolveResponse,
  }),
});
