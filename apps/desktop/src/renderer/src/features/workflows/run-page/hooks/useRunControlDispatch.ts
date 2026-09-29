// The two run controls as CALLS: what a press puts, what may be dispatched at all, and
// what the answer settles to.
//
// The calls are the caller's. This hook keeps the single flight, the per-run state and
// the served-act round, and a rejected call is not caught here.
//
// SINGLE FLIGHT IS THE LATCH'S AND NOT A FLAG'S, and the distinction is a real defect
// rather than a preference. A `dispatching` value read inside a press handler is the
// one from the render that produced that handler, so two presses in one frame both
// find the control idle and both dispatch — two cancellations for one intended act,
// and two replies racing to decide which settlement is shown. `store/
// generation-latch.ts` decides inside the handler's own tick, and it is `claim` and
// never `supersedeAndClaim`: the newest intent does NOT win here. A run control is not
// a durable write being re-typed; the first press is already outstanding against the
// daemon and cannot be recalled, so the honest answer to the second is no — said out
// loud on the control, rather than queued or dropped.
//
// THE KEY IS `(action, run)` AND THE SUBJECT IS THE CALLS. Canceling and resuming are
// separately grantable and separately in flight — an outstanding resume must not
// refuse a cancel — so each action takes its own key, and the run is in the key
// because this pane is RETARGETED IN PLACE: run A's outstanding call must not refuse
// run B's first press. The subject is the calls because replacing them retires a call
// made through the previous ones.
//
// TWO GUARDS ON THE SETTLEMENT, AND THEY ANSWER DIFFERENT QUESTIONS. The claim's
// `settle` asks whether this round is still the live one — the unmount and teardown
// path, where `supersedeAll` retires every key. The publisher asks whether the pane is
// still addressed at the run this call was made about; captured at render, it carries
// its own addressing, so an answer arriving after a retarget installs nowhere rather
// than settling run A's cancellation under run B. Neither subsumes the other.
//
// NOTHING HERE MUTATES THE RUN. There is no optimistic state: what the pane shows is
// the read it holds plus what the daemon actually answered. A served act does re-ARM
// that read, which is a different thing — see `servedActCount`.
//
// AND THAT ROUND IS THE RUN'S RATHER THAN THESE TWO CONTROLS'. Answering a phase parked
// on a person moves the run exactly as canceling it does, and the surface that does it
// is a body mounted in a seat with no dispatcher in reach — so the count is published
// here and its advance is offered through `served-run-act.ts`, which states why the seam
// is a context. One counter reached from two surfaces, and not a second number the pane
// would have to sum.

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
   * The chain is a read addressed by the version the run's snapshot reports, and that
   * snapshot is put at the round this hook publishes — so a chain taken as a parameter
   * here would have to be resolved before the value it is resolved from exists. The
   * surface that mounts the control is where the two producers meet, and
   * `run-controls.ts` states the split on the pair of interfaces it declares for it.
   */
  readonly resume: WorkflowResumeDispatch;
  /** The run read's round. Advances by one per served act; see the state above. */
  readonly servedActCount: number;
  /**
   * Advance that round for a served act this dispatcher did not put.
   *
   * The pane's parked phases are answered through the human-form mount point, which is a body
   * mounted in a seat and reaches no dispatcher — and a submission the daemon recorded
   * moved the run exactly as a served cancel did. So the advance is offered rather than
   * a second count being kept next door: `served-run-act.ts` is the seam the pane hands
   * this across, and states why it is a context rather than a member on the mount.
   *
   * Does nothing on a pane naming no run, which is the arm both controls above take —
   * such a pane has put no read, so there is no answer for an act to make stale.
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
   * How many acts on this run have come back SERVED.
   *
   * The run read's re-arm round, and the reason it is a count rather than a flag: a
   * cancel followed by nothing and a cancel followed by a resume are two different
   * numbers of settled acts, and the read has to be put again for each. The pane feeds
   * it to `useWorkflowRunSnapshot`, whose subject key it joins — so one settled act
   * puts exactly one further read. That is a re-arm and not a poll: nothing here arms
   * a timer, and no read is put by anything but a settled act. Nor is the state the
   * reply reported ever written into the snapshot — the daemon is asked again rather
   * than believed twice, so the phases on screen are always one answer and not a
   * splice of two.
   *
   * ACTS ON THIS RUN, AND NOT ONLY THIS DISPATCHER'S TWO. A served human-form
   * submission is one of them and reaches this count through
   * {@link WorkflowRunControls.recordServedAct}.
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
  // WHETHER THERE IS A CALL TO PUT AT ALL, decided once and where the request is
  // formed — the answer `run-snapshot.ts` gives at this same seam. Both requests carry
  // a required run id, so a pane naming none has nothing to address and the press
  // composes nothing rather than sending a fabricated id. That arm is unrenderable
  // besides: the pane returns its empty and misaddressed bodies above these controls.
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
              // Spread on the arm that has one rather than passed as an explicit
              // `undefined`: the request's `reason` is optional under
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
 * The FUNCTION form of publish for {@link publishOutcome}'s own reason — one held record
 * carries both — and the outcomes are carried through untouched because an act performed
 * on another surface settles neither control here. The publish is the one this render
 * captured, so an act recorded after the pane was retargeted writes nowhere rather than
 * re-reading the run the person moved to.
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
  const claim = runtime.latch.takeShell(runtime.calls, actKey(action, runtime.workflowRunId));
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
    claim.settle(() => {
      publishOutcome(runtime, action, outcome);
    });
  } finally {
    claim.release();
  }
}

/** One key per `(action, run)`. The action set is closed and carries no colon. */
function actKey(action: WorkflowRunControlAction, workflowRunId: string): string {
  return `${action}:${workflowRunId}`;
}

/**
 * Write one action's outcome into the state this render is addressed at.
 *
 * The FUNCTION form of publish rather than a value, because the two actions share one
 * held record and a settlement composed from a closure's copy of it would drop the
 * other action's outcome — a resume settling while a cancel refusal was on screen
 * would erase the refusal. The re-arm round advances from the outcome itself rather
 * than from a second parameter, so a settled act and an advanced round cannot come
 * apart.
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
