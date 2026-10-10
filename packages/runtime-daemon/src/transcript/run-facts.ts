// The facts of the runs a transcript window names, folded from the whole log rather than the
// window's rows, so a run whose creation or first actor lies outside the window still reads whole.
// Each run costs three seeks: its creation, which names the account it was admitted under; its
// first event naming an actor; and its state events newest first, read back only to the newest one
// that set a state. Folding those in log order answers what folding every event of the run would.

import type { Database, Statement } from "better-sqlite3";

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { RUN_INITIAL_STATE } from "@ai-sidekicks/contracts/run/state";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "@ai-sidekicks/contracts/transcript/row";
import {
  RUN_STATE_EVENT_TYPES,
  UNFOLDED_TRANSCRIPT_RUN_FACTS,
  foldTranscriptRunFacts,
  type TranscriptRunBeat,
  type TranscriptRunFacts,
} from "@ai-sidekicks/contracts/transcript/run-facts";

import { sessionReadBound, type DamagedFromSequenceReader } from "../events/session/read.js";
import { outsideSkippedRangesSql } from "../events/session/skipped-ranges.js";

interface StoredBeatRow {
  readonly sequence: number;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: string;
}

interface RunBeatParameters {
  readonly sessionId: SessionId;
  readonly runId: string;
  readonly readBound: number;
}

// Only rows the log can read: none past a damaged session's last good point or in a range it
// skipped.
const READABLE_ROW_SQL = `sequence < @readBound AND ${outsideSkippedRangesSql("event")}`;

const BEAT_COLUMNS_SQL = "sequence, type, actor, payload";

// Through the run-and-type index.
const SELECT_CREATION_SQL = `SELECT ${BEAT_COLUMNS_SQL} FROM session_events AS event
  WHERE session_id = @sessionId AND type = '${`run.${RUN_INITIAL_STATE}`}' AND run_id = @runId
    AND ${READABLE_ROW_SQL}
  ORDER BY sequence
  LIMIT 1`;

const USER_MESSAGE_EVENT_TYPE: SessionEventType = "user.message";

// Through the run-and-actor index; a person's message steering the run is not the run's own.
const SELECT_FIRST_ACTOR_SQL = `SELECT ${BEAT_COLUMNS_SQL} FROM session_events AS event
  WHERE session_id = @sessionId AND run_id = @runId AND actor IS NOT NULL
    AND type <> '${USER_MESSAGE_EVENT_TYPE}' AND ${READABLE_ROW_SQL}
  ORDER BY sequence
  LIMIT 1`;

const STATE_BEAT_TYPES_SQL = [...RUN_STATE_EVENT_TYPES, TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE]
  .map((type) => `'${type}'`)
  .join(", ");

// Through the run-and-type index, one seek per type. The unary `+` keeps the planner from walking
// the session's whole log down its sequence index to skip sorting the run's few state events.
const SELECT_STATE_BEATS_NEWEST_FIRST_SQL = `SELECT ${BEAT_COLUMNS_SQL} FROM session_events AS event
  WHERE session_id = @sessionId AND type IN (${STATE_BEAT_TYPES_SQL}) AND run_id = @runId
    AND ${READABLE_ROW_SQL}
  ORDER BY +sequence DESC`;

/** Reads the facts of a window's runs from the daemon's read-only connection. */
export class TranscriptRunFactsReader {
  readonly #readDamagedFromSequence: DamagedFromSequenceReader;
  readonly #selectCreation: Statement<RunBeatParameters, StoredBeatRow>;
  readonly #selectFirstActor: Statement<RunBeatParameters, StoredBeatRow>;
  readonly #selectStateBeatsNewestFirst: Statement<RunBeatParameters, StoredBeatRow>;

  /** `readDamagedFromSequence` says where a damaged session's reads stop. */
  constructor(reader: Database, readDamagedFromSequence: DamagedFromSequenceReader) {
    this.#readDamagedFromSequence = readDamagedFromSequence;
    this.#selectCreation = reader.prepare(SELECT_CREATION_SQL);
    this.#selectFirstActor = reader.prepare(SELECT_FIRST_ACTOR_SQL);
    this.#selectStateBeatsNewestFirst = reader.prepare(SELECT_STATE_BEATS_NEWEST_FIRST_SQL);
  }

  /**
   * The facts of each of `runIds`, in that order, folded through `headSequence`, the newest event
   * of the snapshot the caller reads in. Throws when a stored payload is not JSON.
   */
  read(sessionId: SessionId, runIds: readonly RunId[], headSequence: number): TranscriptRunFacts[] {
    const readBound = sessionReadBound(this.#readDamagedFromSequence, sessionId);
    return runIds.map((runId) => {
      const parameters: RunBeatParameters = { sessionId, runId, readBound };
      const beats = [
        ...[this.#selectCreation.get(parameters), this.#selectFirstActor.get(parameters)].flatMap(
          (row) => (row === undefined ? [] : [beatOf(row)]),
        ),
        ...this.#stateBeatsFromNewestSetting(parameters),
      ];
      const folded = beats
        .sort((older, newer) => older.sequence - newer.sequence)
        .reduce(foldTranscriptRunFacts, UNFOLDED_TRANSCRIPT_RUN_FACTS);
      return { runId, ...folded, foldedThroughSequence: headSequence };
    });
  }

  // The run's state events back to the newest that set a state, newest first: the events before
  // it can no longer change the state or the rewind.
  #stateBeatsFromNewestSetting(parameters: RunBeatParameters): TranscriptRunBeat[] {
    const newestFirst: TranscriptRunBeat[] = [];
    for (const row of this.#selectStateBeatsNewestFirst.iterate(parameters)) {
      const beat = beatOf(row);
      newestFirst.push(beat);
      if (
        foldTranscriptRunFacts(UNFOLDED_TRANSCRIPT_RUN_FACTS, beat).stateEventType !== undefined
      ) {
        break;
      }
    }
    return newestFirst;
  }
}

function beatOf(row: StoredBeatRow): TranscriptRunBeat {
  return {
    sequence: row.sequence,
    type: row.type,
    actor: row.actor,
    payload: JSON.parse(row.payload) as Readonly<Record<string, unknown>>,
  };
}
