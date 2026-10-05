// The child runs this window's log names, summarized: the row projection's half of the seam
// `dispatches/child-run-entries.ts` reads. A run whose `run.queued` creation row names a
// parent is a child run, said by the daemon; the summary is stamped on that one row per
// child, the only row naming both, so it takes a fresh object each pass.

import type { ChildRunSummary } from "@ai-sidekicks/contracts/transcript/child-run-summary";
import type { RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import {
  RUN_INITIAL_STATE,
  RUN_QUEUED_EVENT_KIND,
  runStateForTransitionKind,
} from "@renderer/store/session-events/run/state-kinds.js";
import { readWireString } from "@renderer/lib/wire/strings.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { attributedRunIdOf } from "./run-attribution.js";

/**
 * Every child run this log names, keyed by the event id of the row it is stamped on.
 *
 * `state` is read from the newest lifecycle beat's kind, `eventCount` counts this window's
 * rows attributed to the child, and `completeness` is `complete` because the log keeps every
 * row a child wrote and no child-run detail fetch happens here. A pure fold, which the
 * caller's memo depends on.
 */
export function deriveChildRunSummaries(
  events: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, ChildRunSummary> {
  const readingsByRunId = new Map<string, ChildRunReading>();
  for (const event of events) {
    const runId = attributedRunIdOf(event.payload);
    if (runId === undefined) {
      continue;
    }
    if (event.kind === RUN_QUEUED_EVENT_KIND) {
      admitChildRun(readingsByRunId, event, runId);
    }
    const reading = readingsByRunId.get(runId);
    if (reading === undefined) {
      // Not a child run, or a row that arrived before its creation row: nothing to summarize.
      continue;
    }
    reading.eventCount += 1;
    const announcedState = runStateForTransitionKind(event.kind);
    if (announcedState !== undefined) {
      reading.state = announcedState;
    }
  }
  return composedSummaries(readingsByRunId);
}

/** What one pass has learned about one child run, before it is composed. */
interface ChildRunReading {
  /** The row the summary is stamped on — this child's own creation row. */
  readonly creationEventId: string;
  readonly parentRunId: string;
  state: RunState;
  eventCount: number;
}

/**
 * Records a creation row that names a parent, or leaves the run unrecorded.
 *
 * A row naming no parent, or one whose parent is not a string, produces no reading.
 */
function admitChildRun(
  readingsByRunId: Map<string, ChildRunReading>,
  event: ProjectedSessionEvent,
  runId: string,
): void {
  const payload = event.payload;
  const parentRunId = readWireString(payload?.["parentRunId"]);
  if (parentRunId === undefined || readingsByRunId.has(runId)) {
    return;
  }
  readingsByRunId.set(runId, {
    creationEventId: event.id,
    parentRunId,
    state: RUN_INITIAL_STATE,
    eventCount: 0,
  });
}

/**
 * Turns the readings into summaries keyed by the stamped row, dropping a run that names itself
 * as its parent: that makes the lineage graph cyclic and every walk of it non-terminating.
 * This is the check a schema would do; nothing on this path was parsed.
 */
function composedSummaries(
  readingsByRunId: ReadonlyMap<string, ChildRunReading>,
): ReadonlyMap<string, ChildRunSummary> {
  const summariesByEventId = new Map<string, ChildRunSummary>();
  for (const [runId, reading] of readingsByRunId) {
    if (runId === reading.parentRunId) {
      continue;
    }
    summariesByEventId.set(reading.creationEventId, {
      runId: runId as RunId,
      parentRunId: reading.parentRunId as RunId,
      state: reading.state,
      eventCount: reading.eventCount,
      completeness: { state: "complete" },
    });
  }
  return summariesByEventId;
}
