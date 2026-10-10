// The child runs this window's log names, summarized: the row projection's half of the seam
// `dispatches/child-run-entries.ts` reads. A run whose `run.queued` creation row names a
// parent is a child run, said by the daemon; the summary is stamped on that one row per
// child, the only row naming both.

import type { ChildRunSummary } from "@ai-sidekicks/contracts/transcript/child-run-summary";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { RUN_INITIAL_STATE, type RunState } from "@ai-sidekicks/contracts/run/state";
import { transcriptRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";
import {
  RUN_QUEUED_EVENT_KIND,
  runStateForTransitionKind,
} from "#renderer/store/session/events/run/state-kinds.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/**
 * The child runs a log names, folded one event at a time, so an appended event costs only the
 * child it names. Each summary keeps its object until its child moves, so a row carrying it keeps
 * its identity while nothing about the child changed.
 */
export class ChildRunSummaries {
  readonly #readingsByRunId = new Map<string, ChildRunReading>();
  /** Each child's summary as last composed, by the creation event it is stamped on. */
  readonly #summaryByEventId = new Map<string, ChildRunSummary>();

  /**
   * Fold one event in, in log order. Answers the creation event id whose summary the event moved,
   * or `undefined` when it moved none.
   *
   * `state` is read from the newest lifecycle beat's kind, `eventCount` counts the log's events
   * attributed to the child, and `completeness` is `complete` because the log keeps every event a
   * child wrote and no child-run detail fetch happens here.
   */
  public admit(event: ProjectedSessionEvent): string | undefined {
    const runId = transcriptRunIdOf(event.payload);
    if (runId === undefined) {
      return undefined;
    }
    if (event.kind === RUN_QUEUED_EVENT_KIND) {
      admitChildRun(this.#readingsByRunId, event, runId);
    }
    const reading = this.#readingsByRunId.get(runId);
    if (reading === undefined) {
      // Not a child run, or an event that arrived before its creation event: nothing to summarize.
      return undefined;
    }
    reading.eventCount += 1;
    const announcedState = runStateForTransitionKind(event.kind);
    if (announcedState !== undefined) {
      reading.state = announcedState;
    }
    // A run that names itself as its parent makes the lineage graph cyclic and every walk of it
    // non-terminating, so it is never summarized. This is the check a schema would do; nothing on
    // this path was parsed.
    if (runId === reading.parentRunId) {
      return undefined;
    }
    this.#summaryByEventId.set(reading.creationEventId, {
      runId: runId as RunId,
      parentRunId: reading.parentRunId as RunId,
      state: reading.state,
      eventCount: reading.eventCount,
      completeness: { state: "complete" },
    });
    return reading.creationEventId;
  }

  /** The summary stamped on one creation event, or `undefined` for an event carrying none. */
  public summaryOf(eventId: string): ChildRunSummary | undefined {
    return this.#summaryByEventId.get(eventId);
  }

  /** Every summary, keyed by the creation event it is stamped on, in the order children arrived. */
  public summaries(): ReadonlyMap<string, ChildRunSummary> {
    return this.#summaryByEventId;
  }
}

/** Every child run one log names, keyed by the event id of the row it is stamped on. */
export function deriveChildRunSummaries(
  events: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, ChildRunSummary> {
  const childRunSummaries = new ChildRunSummaries();
  for (const event of events) {
    childRunSummaries.admit(event);
  }
  return childRunSummaries.summaries();
}

/** What the fold has learned about one child run, before it is composed. */
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
