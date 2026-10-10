// The one writer of a run entity's facts and the state its controls read: who acts for the run,
// the account it is billed to, the state it last entered and whether a rewind came after. Facts
// arrive three ways, each folded here: a window's reply serves them folded from the whole log, a
// read's record of a live run seeds them at the log position it was read at, and every admitted
// event of the run folds onto them. Whichever holds through the later position keeps the state;
// the actor and the account, which never change once named, are kept from either.

import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
import { transcriptOwnRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";
import {
  UNFOLDED_TRANSCRIPT_RUN_FACTS,
  foldTranscriptRunFacts,
  transcriptRunStateOf,
  type TranscriptRunFacts,
  type TranscriptRunFactsFold,
} from "@ai-sidekicks/contracts/transcript/run-facts";

import { payloadNamesSession } from "#renderer/lib/wire/session-attribution.js";
import { mergeUpsert, type SessionPartitions } from "../../entities/partitions.js";
import type { ProjectedSessionEvent, StoredEntity } from "../../entities/vocabulary.js";

/**
 * The run entity `facts` establish: the facts and the state they put the run's controls in, so
 * the two are written together and never disagree.
 */
export function runEntityOfFacts(runId: string, facts: TranscriptRunFactsFold): StoredEntity {
  const state = transcriptRunStateOf(facts);
  return { kind: "run", id: runId, runFacts: facts, ...(state === undefined ? {} : { state }) };
}

/**
 * The partitions with `facts` of run `runId`, served or seeded, merged over what they hold: the
 * facts holding through the later position keep the state, and an actor or account either names
 * is kept. Answers `partitions` itself when nothing changed.
 */
export function admitRunFacts(
  partitions: SessionPartitions,
  runId: string,
  facts: TranscriptRunFactsFold,
): SessionPartitions {
  const held = partitions.run[runId]?.runFacts;
  const merged = held === undefined ? facts : newerRunFacts(held, facts);
  return merged === held ? partitions : mergeUpsert(partitions, runEntityOfFacts(runId, merged));
}

/**
 * The partitions with one admitted event folded into the facts of the run it is its own. An
 * event naming no run, or naming another session, and one that changes no fact, answer
 * `partitions` itself.
 */
export function foldRunFactsOfEvent(
  partitions: SessionPartitions,
  event: ProjectedSessionEvent,
): SessionPartitions {
  const runId = transcriptOwnRunIdOf(event.payload);
  // The event folds into the store it was delivered into, so another session's run is refused.
  if (runId === undefined || !payloadNamesSession(event.payload, event.sessionId)) {
    return partitions;
  }
  const held = partitions.run[runId]?.runFacts;
  const folded = foldTranscriptRunFacts(held ?? UNFOLDED_TRANSCRIPT_RUN_FACTS, {
    type: event.kind,
    sequence: event.sequence,
    actor: event.actorId,
    payload: event.payload,
  });
  return folded === held || folded === UNFOLDED_TRANSCRIPT_RUN_FACTS
    ? partitions
    : mergeUpsert(partitions, runEntityOfFacts(runId, folded));
}

/**
 * The partitions with each of a window reply's `runs` admitted over them, as `admitRunFacts` does.
 */
export function admitServedRunFacts(
  partitions: SessionPartitions,
  runs: readonly TranscriptRunFacts[],
): SessionPartitions {
  let admitted = partitions;
  for (const { runId, ...facts } of runs) {
    admitted = admitRunFacts(admitted, runId, facts);
  }
  return admitted;
}

/**
 * The partitions a replay starts from with the facts of every run `kept` holds admitted under
 * them: each standing below every row the replay sends, so those rows fold over it, while the
 * actor and account it names, and the state of a run no row sent names, are kept.
 */
export function admitKeptRunFacts(
  partitions: SessionPartitions,
  kept: SessionPartitions,
): SessionPartitions {
  let admitted = partitions;
  for (const [runId, entity] of Object.entries(kept.run)) {
    if (entity.runFacts !== undefined) {
      admitted = admitRunFacts(admitted, runId, {
        ...entity.runFacts,
        foldedThroughSequence: START_OF_LOG_POSITION,
      });
    }
  }
  return admitted;
}

// The facts holding through the later position, with the actor and account the other names when
// they name none; `held` wins a tie, so the same facts served again change nothing.
function newerRunFacts(
  held: TranscriptRunFactsFold,
  incoming: TranscriptRunFactsFold,
): TranscriptRunFactsFold {
  const isIncomingNewer = incoming.foldedThroughSequence > held.foldedThroughSequence;
  const newer = isIncomingNewer ? incoming : held;
  const older = isIncomingNewer ? held : incoming;
  const actor = newer.actor ?? older.actor;
  const admittedProviderAccountId =
    newer.admittedProviderAccountId ?? older.admittedProviderAccountId;
  if (actor === newer.actor && admittedProviderAccountId === newer.admittedProviderAccountId) {
    return newer;
  }
  return {
    ...newer,
    ...(actor === undefined ? {} : { actor }),
    ...(admittedProviderAccountId === undefined ? {} : { admittedProviderAccountId }),
  };
}
