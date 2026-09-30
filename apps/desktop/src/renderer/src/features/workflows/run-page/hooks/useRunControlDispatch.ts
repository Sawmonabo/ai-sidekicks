// The two run controls as calls: what a press puts, and what the answer settles to. The
// calls are the caller's and a rejected call is not caught here. Nothing mutates the run:
// the pane shows the read it holds plus what the daemon answered, and a served act re-arms
// that read through `servedActCount` instead of splicing the reply in.

import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { type GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type SubjectScopedPublish } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import {
  IDLE_RUN_CONTROL_OUTCOME,
  WORKFLOW_RUN_RE_PARKED_STATE,
  actAlreadyInFlightRefusal,
  type WorkflowCancelControl,
  type WorkflowResumeDispatch,
  type WorkflowVersionRepin,
  type WorkflowRunControlAction,
  type WorkflowRunControlOutcome,
  type WorkflowRunControlRunState,
  type WorkflowRunCancelReply,
  type WorkflowRunResumeReply,
} from "../run-controls.js";
import type { RecordServedRunAct } from "../served-run-act.js";

/**
 * The two calls the controls put.
 *
 * Pass a stable object: a new identity discards both controls' outcomes and the served-act
 * count.
 */
export interface WorkflowRunControlCalls {
  readonly cancelRun: (request: {
    readonly workflowRunId: string;
    readonly reason?: string;
  }) => Promise<WorkflowRunCancelReply>;
  readonly resumeRun: (request: {
    readonly workflowRunId: string;
    readonly versionRepin?: WorkflowVersionRepin;
  }) => Promise<WorkflowRunResumeReply>;
}

/** Both controls for one run, and the re-arm round their settlements advance. */
export interface WorkflowRunControls {
  readonly cancel: WorkflowCancelControl;
  /**
   * The resume call and its outcome, and deliberately not the version chain.
   *
   * The chain is read for the version this hook's round re-reads, so taking it here would be
   * a cycle; the component that mounts the control joins the two.
   */
  readonly resume: WorkflowResumeDispatch;
  /** The run read's round. Advances by one per served act; see the state above. */
  readonly servedActCount: number;
  /**
   * Advance that round for a served act this dispatcher did not put, such as a human-form
   * submission. Does nothing on a pane naming no run, which has put no read to make stale.
   */
  readonly recordServedAct: RecordServedRunAct;
}

/** What one control's press settles to, once the call has answered. */
interface ServedActReading {
  readonly runState: WorkflowRunControlRunState;
  readonly detail: string;
}

/** Where each action stands, and how many acts on this run have been served. */
interface RunControlDispatchState {
  readonly outcomes: Readonly<Record<WorkflowRunControlAction, WorkflowRunControlOutcome>>;
  /**
   * How many acts on this run have come back served, human-form submissions included.
   *
   * The run read's re-arm round: a count, not a flag, since each settled act needs its own
   * read. The reply's state is never written into the snapshot.
   */
  readonly servedActCount: number;
}

/** Everything a press needs beyond the call it is about to put. */
interface RunControlRuntime {
  readonly latch: GenerationLatch;
  readonly calls: WorkflowRunControlCalls;
  readonly workflowRunId: string;
  readonly publish: SubjectScopedPublish<RunControlDispatchState>;
}

/** Both controls idle and nothing served yet — what a newly addressed run starts at. */
const IDLE_DISPATCH_STATE: RunControlDispatchState = {
  outcomes: { cancel: IDLE_RUN_CONTROL_OUTCOME, resume: IDLE_RUN_CONTROL_OUTCOME },
  servedActCount: 0,
};

/**
 * Offer both run controls for one run, dispatching each through the caller's calls.
 *
 * Both are always offered: eligibility is the daemon's and arrives as a typed refusal on
 * the press. Held against `(calls, run)`, so a retarget shows no other run's settlement.
 */
export function useRunControlDispatch(
  calls: WorkflowRunControlCalls,
  workflowRunId: string | undefined,
): WorkflowRunControls {
  const latch = useGenerationLatch();
  const { value, publish } = useSubjectScopedState<RunControlDispatchState>(
    calls,
    workflowRunId,
    () => IDLE_DISPATCH_STATE,
  );
  // A pane naming no run has nothing to address, so a press composes no call.
  const runtime: RunControlRuntime | undefined =
    workflowRunId === undefined ? undefined : { latch, calls, workflowRunId, publish };
  return {
    cancel: {
      cancel: (reason) => {
        if (runtime === undefined) {
          return;
        }
        void dispatchAct<WorkflowRunCancelReply>(
          runtime,
          "cancel",
          () =>
            calls.cancelRun({
              workflowRunId: runtime.workflowRunId,
              // Omitted rather than `undefined`: `reason` is optional under
              // `exactOptionalPropertyTypes`, and a cancel with no reason is legal.
              ...(reason === undefined ? {} : { reason }),
            }),
          readCancelReply,
        );
      },
      outcome: value.outcomes.cancel,
    },
    resume: {
      resume: (repin) => {
        if (runtime === undefined) {
          return;
        }
        void dispatchAct<WorkflowRunResumeReply>(
          runtime,
          "resume",
          () =>
            calls.resumeRun({
              workflowRunId: runtime.workflowRunId,
              ...(repin === undefined ? {} : { versionRepin: repin }),
            }),
          readResumeReply,
        );
      },
      outcome: value.outcomes.resume,
    },
    servedActCount: value.servedActCount,
    recordServedAct: () => {
      if (runtime === undefined) {
        return;
      }
      advanceServedActRound(runtime);
    },
  };
}

/**
 * Advance the re-arm round by one, leaving both controls' outcomes as they stand.
 *
 * Uses the publish this render captured, so an act recorded after a retarget writes nowhere.
 */
function advanceServedActRound(runtime: RunControlRuntime): void {
  runtime.publish((previous) => ({
    ...previous,
    servedActCount: previous.servedActCount + 1,
  }));
}

/**
 * Claim this act's key, put the call, and publish what comes back.
 *
 * A rejected or throwing call is not caught here: the `finally` gives the key back, so a
 * later press on this run is not refused as a duplicate of a call that ended.
 */
async function dispatchAct<TValue>(
  runtime: RunControlRuntime,
  action: WorkflowRunControlAction,
  call: () => Promise<TValue>,
  describe: (value: TValue) => ServedActReading,
): Promise<void> {
  // Single flight through the latch, not a rendered flag: two presses in one frame both read
  // the same idle render. `claim`, never `supersedeAndClaim`: the first call is outstanding.
  const claim = runtime.latch.claim(runtime.calls, actKey(action, runtime.workflowRunId));
  if (claim === undefined) {
    publishOutcome(runtime, action, {
      kind: "refused",
      refusal: actAlreadyInFlightRefusal(action),
    });
    return;
  }
  publishOutcome(runtime, action, { kind: "dispatching" });
  try {
    const outcome: WorkflowRunControlOutcome = { kind: "settled", ...describe(await call()) };
    // `settle` drops the answer once the round is retired; the publish captured at render
    // drops it once the pane was retargeted to another run.
    claim.settle(() => {
      publishOutcome(runtime, action, outcome);
    });
  } finally {
    claim.release();
  }
}

/**
 * One key per `(action, run)`. Cancel and resume are in flight independently, and a
 * retargeted pane must not inherit the previous run's key. The action set carries no colon.
 */
function actKey(action: WorkflowRunControlAction, workflowRunId: string): string {
  return `${action}:${workflowRunId}`;
}

/**
 * Write one action's outcome into the state this render is addressed at.
 *
 * A function-form publish, because both actions share one record and a closure's copy would
 * erase the other action's outcome. A settled outcome advances the round in the same write.
 */
function publishOutcome(
  runtime: RunControlRuntime,
  action: WorkflowRunControlAction,
  outcome: WorkflowRunControlOutcome,
): void {
  runtime.publish((previous) => ({
    outcomes: { ...previous.outcomes, [action]: outcome },
    servedActCount: previous.servedActCount + (outcome.kind === "settled" ? 1 : 0),
  }));
}

/** What a served cancel means for the operator, read off the reply and nothing else. */
function readCancelReply(value: WorkflowRunCancelReply): ServedActReading {
  return {
    runState: value.state,
    detail: value.alreadyCanceled
      ? "This run was already canceled; the background service replayed the first cancellation rather than performing a second."
      : "This run is canceled.",
  };
}

/** What a served resume means. `suspended` is an outcome here and not a failure. */
function readResumeReply(value: WorkflowRunResumeReply): ServedActReading {
  return {
    runState: value.state,
    detail:
      value.state === WORKFLOW_RUN_RE_PARKED_STATE
        ? "The run re-parked on its next dispatch, which is an outcome and not a failure."
        : "This run is running again.",
  };
}
