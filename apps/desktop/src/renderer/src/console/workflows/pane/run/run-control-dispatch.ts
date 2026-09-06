// The two run controls as CALLS: what a press puts on the growth port, what may be
// dispatched at all, and what the answer settles to.
//
// WHY THIS EXISTS AT ALL. The pane used to mount both controls as hand-composed
// refusals saying the operation was "not on the bridge yet". That sentence was false:
// `bridge/growth-operations/workflows.ts` carries `workflowRunCancel` and
// `workflowRunResume`, and `bridge/growth-port.ts` composes the refusal a build whose
// bridge cannot serve one deserves — naming the wire and who owes it. A mount site
// that composes its own refusal bypasses the port and asserts a wire fact nobody
// checked; the honest shape is that the press REACHES the port and renders whatever
// the port says, which is the same treatment every other console surface gives an
// unbuilt wire.
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
// THE KEY IS `(action, run)` AND THE SUBJECT IS THE PORT. Cancelling and resuming are
// separately grantable and separately in flight — an outstanding resume must not
// refuse a cancel — so each action takes its own key, and the run is in the key
// because this pane is RETARGETED IN PLACE: run A's outstanding call must not refuse
// run B's first press. The subject is the port because the fixture's scenario switch
// replaces the bridge and keeps the run id, and a call made through the previous
// bridge is retired by that replacement.
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

import {
  settleGrowthRead,
  type GrowthPort,
  type GrowthUnavailable,
  type SettledReadRefusal,
} from "../../../bridge/index.js";
import {
  useGenerationLatch,
  useSubjectScopedState,
  type GenerationLatch,
  type SubjectScopedPublish,
} from "../../../store/index.js";
import {
  IDLE_RUN_CONTROL_OUTCOME,
  WORKFLOW_RUN_RE_PARKED_STATE,
  actAlreadyInFlightRefusal,
  type WorkflowCancelControl,
  type WorkflowResumeDispatch,
  type WorkflowRunControlAction,
  type WorkflowRunControlOutcome,
  type WorkflowRunControlRunState,
  type WorkflowRunCancelReply,
  type WorkflowRunResumeReply,
} from "./run-controls.js";

/** What one control's press settles to, once the port has answered. */
interface ServedActReading {
  readonly runState: WorkflowRunControlRunState;
  readonly detail: string;
}

/**
 * How a growth call for one of these two operations can end.
 *
 * Three arms and not two: the port's own refusal for a wire this build cannot serve,
 * the read seam's reading of a REJECTION — a scripted daemon refusal is thrown
 * verbatim, and the live seam will throw the same shape — and the served value. Both
 * refusals carry `status: "unavailable"`, so one narrowing covers them.
 */
type ControlSettlement<TValue> =
  | { readonly status: "served"; readonly value: TValue }
  | GrowthUnavailable
  | SettledReadRefusal;

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
   */
  readonly servedActCount: number;
}

/** Everything a press needs beyond the call it is about to put. */
interface RunControlRuntime {
  readonly latch: GenerationLatch;
  readonly growth: GrowthPort;
  readonly workflowRunId: string;
  readonly publish: SubjectScopedPublish<RunControlDispatchState>;
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
}

/** Both controls idle and nothing served yet — what a newly addressed run starts at. */
const IDLE_DISPATCH_STATE: RunControlDispatchState = {
  outcomes: { cancel: IDLE_RUN_CONTROL_OUTCOME, resume: IDLE_RUN_CONTROL_OUTCOME },
  servedActCount: 0,
};

/**
 * Offer both run controls for one run, dispatching each through the growth port.
 *
 * BOTH ARE OFFERED, ALWAYS, because nothing in this console can adjudicate either one
 * before it asks. Eligibility is the daemon's and arrives as a typed refusal on the
 * press, and nothing here reads a run status to decide in advance.
 *
 * Held against `(port, run)` exactly as the pane's own read is: a bridge swapped
 * underneath and a pane retargeted at another run each re-seed this state during the
 * render that brings them, so no frame shows one run's settlement under another's
 * address.
 */
export function useRunControlDispatch(
  growth: GrowthPort,
  workflowRunId: string | undefined,
): WorkflowRunControls {
  const latch = useGenerationLatch();
  const { value, publish } = useSubjectScopedState<RunControlDispatchState>(
    growth,
    workflowRunId,
    () => IDLE_DISPATCH_STATE,
  );
  // WHETHER THERE IS A CALL TO PUT AT ALL, decided once and where the request is
  // formed — the answer `run-snapshot.ts` gives at this same seam. Both requests carry
  // a required run id, so a pane naming none has nothing to address and the press
  // composes nothing rather than sending a fabricated id. That arm is unrenderable
  // besides: the pane returns its empty and misaddressed bodies above these controls.
  const runtime: RunControlRuntime | undefined =
    workflowRunId === undefined ? undefined : { latch, growth, workflowRunId, publish };
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
            growth.workflowRunCancel({
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
            growth.workflowRunResume({
              workflowRunId: runtime.workflowRunId,
              ...(repin === undefined ? {} : { versionRepin: repin }),
            }),
          readResumeReply,
        );
      },
      outcome: value.outcomes.resume,
    },
    servedActCount: value.servedActCount,
  };
}

/**
 * Claim this act's key, put the call, and settle whatever comes back.
 *
 * `settleGrowthRead` and not a bare `await`, because a growth call can also REJECT: a
 * scenario that scripts a daemon refusal throws it verbatim and the live seam will
 * throw the same shape once the wire lands. A fulfilment handler alone would leave
 * the control reading `dispatching` for the life of the pane over an answer that had
 * already arrived — the one shape a dispatched act must never take.
 */
async function dispatchAct<TValue>(
  runtime: RunControlRuntime,
  action: WorkflowRunControlAction,
  call: () => Promise<ControlSettlement<TValue>>,
  describe: (value: TValue) => ServedActReading,
): Promise<void> {
  const claim = runtime.latch.claim(runtime.growth, actKey(action, runtime.workflowRunId));
  if (claim === undefined) {
    publishOutcome(runtime, action, {
      kind: "refused",
      refusal: actAlreadyInFlightRefusal(action),
    });
    return;
  }
  publishOutcome(runtime, action, { kind: "dispatching" });
  try {
    const outcome = outcomeOf(await settleGrowthRead(call()), describe);
    claim.settle(() => {
      publishOutcome(runtime, action, outcome);
    });
    // The key goes back whatever happened, a `publish` that threw included: a key held
    // for the life of the subject would refuse every later press on this run.
  } finally {
    claim.release();
  }
}

/**
 * What one settlement means for the control that asked.
 *
 * A refusal is carried VERBATIM — never re-worded and never re-coded here. The port's
 * own `wire-unregistered` sentence names the wire and who owes it, and a daemon's
 * `workflow.*` code is its own adjudication; a console that paraphrased either would
 * be a second vocabulary for one fact.
 */
function outcomeOf<TValue>(
  settlement: ControlSettlement<TValue>,
  describe: (value: TValue) => ServedActReading,
): WorkflowRunControlOutcome {
  return settlement.status === "served"
    ? { kind: "settled", ...describe(settlement.value) }
    : { kind: "refused", refusal: settlement };
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
    detail: value.alreadyCancelled
      ? "This run was already cancelled; the daemon replayed the first cancellation rather than performing a second."
      : "This run is cancelled.",
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
