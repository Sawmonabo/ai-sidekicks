// The run facts a test's scripted log implies, built by the same folds production runs: the facts a
// `transcript.read` reply serves for the runs its entries name, and the run entities a session
// store holds once it has admitted a log's events.

import type { TranscriptReadRow } from "@ai-sidekicks/contracts/transcript/row";
import { transcriptOwnRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";
import type { TranscriptRunFacts } from "@ai-sidekicks/contracts/transcript/run-facts";

import type { RunEntitiesByRunId } from "#renderer/features/transcript/runs/groups.js";
import {
  runBeatsOf,
  servedRunFactsOf,
} from "#renderer/services/daemon/scenario/transcript-read.fixture.js";
import {
  emptyPartitions,
  type ProjectedSessionEvent,
} from "#renderer/store/session/entities/vocabulary.js";
import { foldRunFactsOfEvent } from "#renderer/store/session/events/run/facts.js";
import type { SessionPartitions } from "#renderer/store/session/entities/partitions.js";

/**
 * The facts a reply carrying `entries` serves: one for each run they name, folded over `log`, the
 * whole scripted log oldest first, through its newest row.
 */
export function runFactsServedFor(
  entries: readonly TranscriptReadRow[],
  log: readonly TranscriptReadRow[],
): TranscriptRunFacts[] {
  const namedRunIds = new Set(
    entries.flatMap((row) => (row.kind === "general" ? [] : [row.runId])),
  );
  // A scripted row may leave its run out of its payload, which the daemon's log always names.
  const beats = log.map((row) => ({
    type: row.type,
    sequence: row.sequence,
    actor: row.actor,
    payload: row.kind === "general" ? row.payload : { runId: row.runId, ...row.payload },
  }));
  return servedRunFactsOf(beats, namedRunIds);
}

/**
 * The facts a read opening on `window`, the store's events, serves: one for each run they name,
 * folded over `log`, every event oldest first through the newest the read was taken at.
 */
export function runFactsOpenedWith(
  window: readonly ProjectedSessionEvent[],
  log: readonly ProjectedSessionEvent[],
): TranscriptRunFacts[] {
  const namedRunIds = new Set(window.flatMap((event) => transcriptOwnRunIdOf(event.payload) ?? []));
  return servedRunFactsOf(runBeatsOf(log), namedRunIds);
}

/** The run entities a session store holds once it has admitted `events`, in log order. */
export function runEntitiesOf(events: readonly ProjectedSessionEvent[]): RunEntitiesByRunId {
  let partitions: SessionPartitions = emptyPartitions();
  for (const event of events) {
    partitions = foldRunFactsOfEvent(partitions, event);
  }
  return partitions.run;
}
