// Which runs the two run-addressed diagnostics reads are about.
//
// `health.stuckRunInspect` and `health.failureDetailRead` each take ONE run id, and
// nothing in the corpus enumerates the runs a node is worried about — there is no
// stuck-run list, no failed-run list, and no health subscription this page is allowed
// to use. So the page asks about the runs it can see: the ones in the session this
// window has open, which the console's own store already holds.
//
// TWO SUBJECTS AND NOT ONE, because the two reads answer about different runs and
// asking one question about both would produce an answer about neither. Only a run
// that is still moving can have stopped moving, and only a run that has failed has a
// failure to detail — so a page that inspected the same run twice would either put a
// stall question to a finished run or a failure question to a running one, and the
// daemon would rightly refuse whichever came second.
//
// PICKING A SUBJECT IS NOT DERIVING A VERDICT. What this module chooses is which
// question to put; whether the run is stuck is the daemon's answer to it, and the
// page renders that answer and never this module's reason for asking. The rule the
// section states — never derive a health verdict of its own — is about the reply.
//
// THE NARROWNESS IS STATED ON SCREEN RATHER THAN HIDDEN. A node runs work for
// sessions this window has never opened, and none of it is reachable from here. The
// page says so beside the readings, because a stall region that found nothing in one
// session must not read as a machine with nothing stuck on it.

import type { RunState } from "@ai-sidekicks/contracts";

import { isLiveRunState, readRunState } from "../../../../bridge/index.js";
import type { ConsoleEntity } from "../../../../store/index.js";
import { byNewestTouchedEntity } from "../../../shared/run-recency.js";

/** The run state a failure detail can be read for. The wire's own word, once. */
const FAILED_RUN_STATE = "failed";

/**
 * The two run ids the page addresses, each `undefined` where there is none.
 *
 * `undefined` is a real answer and reaches the surface as an absence with its own
 * sentence, never as a read that was put and came back empty.
 */
export interface DiagnosticsRunSubjects {
  /** The newest-touched run still moving — the only kind that can have stalled. */
  readonly stalledCandidateRunId: string | undefined;
  /** The newest-touched run that failed — the only kind with a failure to detail. */
  readonly failedCandidateRunId: string | undefined;
}

/** No session open, or a session holding no run this page can address. */
export const NO_DIAGNOSTICS_RUN_SUBJECTS: DiagnosticsRunSubjects = {
  stalledCandidateRunId: undefined,
  failedCandidateRunId: undefined,
};

/**
 * Resolve both subjects from one session's `run` partition.
 *
 * The state on a stored entity is a wire-verbatim string, so it goes back through
 * `readRunState` before either predicate sees it: a word this build has never heard
 * is neither treated as moving nor asserted to have failed, and the run is simply not
 * a candidate. That is the fail-closed reading — an unknown state produces no
 * question rather than a question about the wrong run.
 */
export function resolveDiagnosticsRunSubjects(
  runs: Readonly<Record<string, ConsoleEntity>>,
): DiagnosticsRunSubjects {
  const ordered = Object.values(runs).sort(byNewestTouchedEntity);
  const stalledCandidate = ordered.find((run) => {
    const state = runStateOf(run);
    return state !== undefined && isLiveRunState(state);
  });
  const failedCandidate = ordered.find((run) => runStateOf(run) === FAILED_RUN_STATE);
  return {
    stalledCandidateRunId: stalledCandidate?.id,
    failedCandidateRunId: failedCandidate?.id,
  };
}

/** The entity's state as the wire's own vocabulary, or `undefined` if unreadable. */
function runStateOf(run: ConsoleEntity): RunState | undefined {
  return run.state === undefined ? undefined : readRunState(run.state);
}
