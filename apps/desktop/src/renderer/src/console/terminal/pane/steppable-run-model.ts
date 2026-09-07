// Whether this session has a run a person could step into.
//
// `Spec-023 §Console Design (Meridian)` 8.9 puts one aside under the lease line — that
// stepping in pauses a run and hands you the conversation, and that it never moves the
// keyboard. An aside is a clarification, and a clarification about a control nobody
// can reach right now is noise on every terminal pane that is not running anything.
// So the sentence renders when there is something to step into and not otherwise.
//
// WHY THIS FAMILY FOLDS IT AT ALL. The runs family owns run rendering, and one view
// family never imports another — so a boolean this pane needs cannot be taken from
// there. What it can do is read the same log everything else reads, which is the
// shape `node-presence-model.ts` already takes for the holding node: a narrow fold
// beside the lease, answering one question, over registered event kinds only.
//
// AND IT IS NARROW ON PURPOSE. A steppable run is a RUNNING one. Stepping in pauses a
// run, and a queued run has not started, a paused one is already stopped, a run
// waiting on an approval or an input is stopped on something a step-in does not
// supply, and a finished run cannot be paused at all. Every one of those is a state
// the log names, so the answer is read rather than guessed — and the direction it errs
// in is silence, which is the honest one for a sentence about a control.
//
// TOTAL AND PURE, on `lease-model.ts`'s discipline: given the same events, the same
// answer, so a replayed prefix reads the same as a live stream.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../../store/index.js";

/**
 * The one event kind that puts a run into a state a step-in can act on.
 *
 * Written as a `SessionEventType`, so a kind this console invents — or one a later
 * release renames — is a compile error rather than an arm that silently matches
 * nothing. That is `node-presence-model.ts`'s rule and the reason it is worth the
 * import: a fold keyed on a string nobody checks reports "nothing is running"
 * forever, and reads exactly like a session with no runs in it.
 */
const RUN_ENTERS_STEPPABLE_EVENT_KINDS = [
  "run.running",
] as const satisfies readonly SessionEventType[];

/**
 * The kinds that take a run back out of it.
 *
 * The five terminals plus the three live-but-stopped states. `run.queued` and
 * `run.starting` are absent for a different reason than the ones here: they precede
 * `run.running` rather than following it, so a run that reached neither was never
 * steppable and there is nothing for them to clear. Listing them would be harmless
 * and would also say something false about what they mean.
 */
const RUN_LEAVES_STEPPABLE_EVENT_KINDS = [
  "run.paused",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.completed",
  "run.interrupted",
  "run.failed",
  "run.rolled_back",
  "run.worker_shutdown",
] as const satisfies readonly SessionEventType[];

/** The run identity every run-scoped payload carries, or nothing. */
function runIdOf(event: ConsoleSessionEvent): string | undefined {
  const runId = event.payload?.["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

/** One run's newest word, and the position that word was written at. */
interface SteppableReading {
  readonly isSteppable: boolean;
  readonly sequence: number;
}

/**
 * Whether the log's newest word on any run says it is running.
 *
 * Newest write wins PER RUN rather than across the session, because a session runs
 * several agents at once: a fold that kept one flag would have one run's completion
 * silence the aside while another run was still going.
 *
 * AND "NEWEST" IS THE LOG'S POSITION, not the order this loop happened to see the
 * events in. The store's timeline is ordered today, so the comparison below changes
 * nothing about a healthy stream — but a healed gap re-appends a prefix, and a fold
 * that took the last entry it saw would answer with a superseded word for exactly as
 * long as that prefix sat at the end. `foldProducedArtifacts` keeps the same rule for
 * the same reason, and two folds over one log disagreeing about which write is newer
 * is the drift worth spending three lines to avoid.
 *
 * A run-scoped event whose payload names no run is skipped rather than counted. The
 * registered shapes all carry `runId`, so a payload without one is not a payload the
 * daemon could have emitted — and admitting it would mean keying the fold on
 * something, which here could only be the session.
 */
export function hasSteppableRun(timeline: readonly ConsoleSessionEvent[]): boolean {
  const readingByRunId = new Map<string, SteppableReading>();
  for (const event of timeline) {
    const entersSteppable = (RUN_ENTERS_STEPPABLE_EVENT_KINDS as readonly string[]).includes(
      event.kind,
    );
    const leavesSteppable = (RUN_LEAVES_STEPPABLE_EVENT_KINDS as readonly string[]).includes(
      event.kind,
    );
    if (!entersSteppable && !leavesSteppable) {
      continue;
    }
    const runId = runIdOf(event);
    if (runId === undefined) {
      continue;
    }
    const held = readingByRunId.get(runId);
    if (held !== undefined && held.sequence > event.sequence) {
      continue;
    }
    readingByRunId.set(runId, { isSteppable: entersSteppable, sequence: event.sequence });
  }
  for (const reading of readingByRunId.values()) {
    if (reading.isSteppable) {
      return true;
    }
  }
  return false;
}
