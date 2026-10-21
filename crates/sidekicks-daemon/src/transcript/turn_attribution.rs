//! Which turn of its run each event belongs to. Folding a run's events in log order, a turn
//! boundary moves the run to its next position, and an accepted rollback ends the epoch it rewound
//! and opens the next at its point. Any other event takes the turn of its own execution: the source
//! stamped on a row appended after a cut, else the turn its tool call opened in, else the turn the
//! run stands at. A run first met partway through the log, or met again after its fold ended at a
//! terminal event, is seeded from its log before that event.

use std::collections::HashMap;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::run::control::AgentRunRolledBackEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::row::{TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE, TranscriptRunStamp};
use sidekicks_contracts::transcript::run_attribution::transcript_run_id_of;
use sidekicks_contracts::transcript::turn_attribution::{
    EpochPosition, RUN_START_POSITION, SupersededTurns, TOOL_CALL_OPENING_EVENT_TYPE,
    TURN_STARTED_EVENT_TYPE, add_superseding_cut, stamped_source_of, standing_after_rollback,
    standing_after_turn_started, transcript_run_stamp_at, transcript_tool_call_id_of,
};
use sidekicks_contracts::wire::id::IdError;

use crate::database::stored_column::json_object_column;
use crate::events::session::read::{readable_event_sql, session_read_bound};
use crate::session::run::superseded::{
    StoredRollbackMismatchError, SupersededTurnsReadError, parse_stored_rollback,
    read_superseded_turns,
};
use crate::session::run::transitions::is_run_terminal_event_type;

/// Why an event could not be attributed to its turn.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TurnAttributionError {
    /// SQLite refused a read of the run's log, or a stored payload is not a JSON object.
    #[error("a read of a run's turns failed")]
    Database(#[from] rusqlite::Error),
    /// An `agent.run.rolledBack` does not match its contract.
    #[error(transparent)]
    Rollback(#[from] StoredRollbackMismatchError),
    /// The run's superseded turns could not be read.
    #[error(transparent)]
    SupersededTurns(#[from] SupersededTurnsReadError),
    /// An event's payload names its run by text that is not a run id, which only a write outside
    /// the append path can leave.
    #[error("the event at sequence {sequence} names its run by text that is not a run id")]
    PayloadRunId {
        /// The event's sequence.
        sequence: u64,
        /// Why the text is not a run id.
        #[source]
        cause: IdError,
    },
}

/// One event of a run, attributed: the run, the stamp its row carries and, on a
/// `agent.run.rolledBack`, the rollback read into its contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunEventAttribution {
    /// The run the event belongs to.
    pub(crate) run_id: RunId,
    /// The stamp its row carries.
    pub(crate) stamp: TranscriptRunStamp,
    /// The rollback, on an `agent.run.rolledBack`.
    pub(crate) rollback: Option<AgentRunRolledBackEvent>,
}

/// One run's place in the fold.
struct RunFold {
    standing: EpochPosition,
    turns: SupersededTurns,
    // The turn each tool call opened in, held until a later row of the call reads it or the run
    // ends; a row after that reads the opening from the log, so the map holds only calls still
    // open.
    opened_tool_calls: HashMap<String, EpochPosition>,
}

// Each read seeks the run's rows of one type through the event log's run-and-type index, bounded
// strictly before the event being seeded, and reads only rows the log can read.
static SELECT_ROLLBACKS_BEFORE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sequence, payload FROM session_events AS event
  WHERE session_id = @session_id AND type = @type AND sequence < @before_sequence
    AND run_id = @run_id AND {}
  ORDER BY sequence",
        readable_event_sql("event")
    )
});

static SELECT_TURNS_BETWEEN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT payload FROM session_events AS event
  WHERE session_id = @session_id AND type = @type
    AND sequence > @after_sequence AND sequence < @before_sequence
    AND run_id = @run_id AND {}
  ORDER BY sequence",
        readable_event_sql("event")
    )
});

// The latest opening wins: a provider may reuse a call's key after a cut.
static SELECT_TOOL_CALL_OPENING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sequence, payload FROM session_events AS event
  WHERE session_id = @session_id AND type = @type AND sequence < @before_sequence
    AND run_id = @run_id AND {}
    AND json_extract(payload, '$.toolCallId') = @tool_call_id
  ORDER BY sequence DESC
  LIMIT 1",
        readable_event_sql("event")
    )
});

/// The log reads that seed a run's fold on the daemon's read-only connection, none reading past a
/// damaged session's last good point or in a range it skipped. Each fails with
/// [`TurnAttributionError`] when SQLite refuses it or a stored rollback does not match its
/// contract.
pub(crate) struct RunTurnReads<'reader, DamagedFrom> {
    reader: &'reader Connection,
    read_damaged_from_sequence: DamagedFrom,
}

impl<'reader, DamagedFrom> RunTurnReads<'reader, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    /// The reads on `reader`; `read_damaged_from_sequence` answers the sequence a damaged
    /// session's reads stop before, `None` for a session that reads whole.
    pub(crate) fn new(
        reader: &'reader Connection,
        read_damaged_from_sequence: DamagedFrom,
    ) -> Self {
        Self {
            reader,
            read_damaged_from_sequence,
        }
    }

    /// The epoch and turn the run stands at just before `before_sequence`.
    pub(crate) fn read_standing_before(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        before_sequence: i64,
    ) -> Result<EpochPosition, TurnAttributionError> {
        let read_bound = session_read_bound(&self.read_damaged_from_sequence, session_id, None);
        let mut standing = RUN_START_POSITION;
        let mut last_rollback_sequence = START_OF_LOG_POSITION;
        let mut rollbacks = self.reader.prepare_cached(&SELECT_ROLLBACKS_BEFORE_SQL)?;
        let mut rollback_rows = rollbacks.query(named_params! {
            "@session_id": session_id.text().as_str(),
            "@type": TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
            "@run_id": run_id.text().as_str(),
            "@before_sequence": before_sequence,
            "@read_bound": read_bound,
        })?;
        while let Some(row) = rollback_rows.next()? {
            let sequence: i64 = row.get(0)?;
            let payload = json_object_column(row, 1)?;
            let rollback = parse_stored_rollback(&payload, session_id, sequence)?;
            standing = standing_after_rollback(standing, rollback.target_position);
            last_rollback_sequence = sequence;
        }
        // Turns before the last rollback do not move the run: the rollback set its position.
        let mut turns = self.reader.prepare_cached(&SELECT_TURNS_BETWEEN_SQL)?;
        let mut turn_rows = turns.query(named_params! {
            "@session_id": session_id.text().as_str(),
            "@type": TURN_STARTED_EVENT_TYPE,
            "@run_id": run_id.text().as_str(),
            "@after_sequence": last_rollback_sequence,
            "@before_sequence": before_sequence,
            "@read_bound": read_bound,
        })?;
        while let Some(row) = turn_rows.next()? {
            let payload = json_object_column(row, 0)?;
            standing = standing_after_turn_started(standing, &payload);
        }
        Ok(standing)
    }

    /// The epoch and turn the run's latest call `tool_call_id` opened in before `before_sequence`,
    /// or `None` when no such call opened.
    pub(crate) fn read_tool_call_opening_before(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        tool_call_id: &str,
        before_sequence: i64,
    ) -> Result<Option<EpochPosition>, TurnAttributionError> {
        let read_bound = session_read_bound(&self.read_damaged_from_sequence, session_id, None);
        let opening = self
            .reader
            .prepare_cached(&SELECT_TOOL_CALL_OPENING_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.text().as_str(),
                    "@type": TOOL_CALL_OPENING_EVENT_TYPE,
                    "@run_id": run_id.text().as_str(),
                    "@tool_call_id": tool_call_id,
                    "@before_sequence": before_sequence,
                    "@read_bound": read_bound,
                },
                |row| Ok((row.get::<_, i64>(0)?, json_object_column(row, 1)?)),
            )
            .optional()?;
        let Some((opening_sequence, payload)) = opening else {
            return Ok(None);
        };
        match stamped_source_of(&payload) {
            Some(source) => Ok(Some(source)),
            None => self
                .read_standing_before(session_id, run_id, opening_sequence)
                .map(Some),
        }
    }

    /// A run's fold seeded from its log before `before_sequence`: where it stands, and its turns
    /// every rollback of it the log holds superseded.
    fn read_seed(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        before_sequence: i64,
    ) -> Result<RunFold, TurnAttributionError> {
        Ok(RunFold {
            standing: self.read_standing_before(session_id, run_id, before_sequence)?,
            turns: read_superseded_turns(
                self.reader,
                &self.read_damaged_from_sequence,
                session_id,
                run_id,
            )?,
            opened_tool_calls: HashMap::new(),
        })
    }
}

/// Attributes one session's events to the turns of their runs. Feed it one ascending stretch of
/// the log in sequence order, a window read or a stream's deliveries; each run is seeded from the
/// log on first sight and after its terminal event, and marked against every rollback of it the
/// log holds by then. It holds one fold per run until that run's terminal event.
pub(crate) struct SessionTurnAttribution {
    session_id: SessionId,
    fold_by_run_id: HashMap<RunId, RunFold>,
}

impl SessionTurnAttribution {
    /// An attribution of `session_id`'s events holding no fold yet.
    pub(crate) fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            fold_by_run_id: HashMap::new(),
        }
    }

    /// The attribution of an event of a run, or `None` for an event naming none, seeding the run
    /// through `reads` when it holds no fold of it. Fails with [`TurnAttributionError`] when a seed
    /// read fails, an `agent.run.rolledBack` does not match its contract or the payload's run id is
    /// not one.
    pub(crate) fn attribute<DamagedFrom>(
        &mut self,
        reads: &RunTurnReads<'_, DamagedFrom>,
        event: &EventEnvelope,
    ) -> Result<Option<RunEventAttribution>, TurnAttributionError>
    where
        DamagedFrom: Fn(&SessionId) -> Option<i64>,
    {
        let event_type = event.event_type.as_str();
        let sequence = i64::from(event.sequence);
        if event_type == TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE {
            return self.attribute_rollback(reads, event).map(Some);
        }
        let Some(payload_run_id) = transcript_run_id_of(Some(&event.payload)) else {
            return Ok(None);
        };
        let run_id =
            RunId::new(payload_run_id).map_err(|cause| TurnAttributionError::PayloadRunId {
                sequence: event.sequence.get(),
                cause,
            })?;
        let mut fold = self.take_fold(reads, &run_id, sequence)?;
        let stamp = if event_type == TURN_STARTED_EVENT_TYPE {
            fold.standing = standing_after_turn_started(fold.standing, &event.payload);
            transcript_run_stamp_at(&fold.turns, fold.standing)
        } else {
            let tool_call_id = transcript_tool_call_id_of(Some(event.category), &event.payload);
            match tool_call_id {
                Some(tool_call_id) if event_type == TOOL_CALL_OPENING_EVENT_TYPE => {
                    let opening = stamped_source_of(&event.payload).unwrap_or(fold.standing);
                    fold.opened_tool_calls
                        .insert(tool_call_id.to_owned(), opening);
                    transcript_run_stamp_at(&fold.turns, opening)
                }
                Some(_) | None => {
                    let source = self.source_of(reads, event, &run_id, &mut fold, tool_call_id)?;
                    transcript_run_stamp_at(&fold.turns, source)
                }
            }
        };
        // A terminal event is stamped from the fold and frees it; a later event, after a resume,
        // reseeds the run from the log.
        if !is_run_terminal_event_type(event_type) {
            self.fold_by_run_id.insert(run_id, fold);
        }
        Ok(Some(RunEventAttribution {
            run_id,
            stamp,
            rollback: None,
        }))
    }

    fn attribute_rollback<DamagedFrom>(
        &mut self,
        reads: &RunTurnReads<'_, DamagedFrom>,
        event: &EventEnvelope,
    ) -> Result<RunEventAttribution, TurnAttributionError>
    where
        DamagedFrom: Fn(&SessionId) -> Option<i64>,
    {
        let sequence = i64::from(event.sequence);
        let rollback = parse_stored_rollback(&event.payload, &self.session_id, sequence)?;
        let mut fold = self.take_fold(reads, &rollback.run_id, sequence)?;
        let rewound_epoch = fold.standing.epoch;
        // A rollback the seeding read already counted holds its cut.
        if usize::try_from(rewound_epoch.0.get()).is_ok_and(|epoch| epoch == fold.turns.cuts.len())
        {
            fold.turns = add_superseding_cut(&fold.turns, rollback.target_position);
        }
        let boundary = EpochPosition {
            epoch: rewound_epoch,
            position: rollback.target_position,
        };
        fold.standing = standing_after_rollback(fold.standing, rollback.target_position);
        let stamp = transcript_run_stamp_at(&fold.turns, boundary);
        self.fold_by_run_id.insert(rollback.run_id, fold);
        Ok(RunEventAttribution {
            run_id: rollback.run_id,
            stamp,
            rollback: Some(rollback),
        })
    }

    // The turn a row of the run belongs to. A row of a tool call ends its held opening, since a
    // call closes with its one result or error; a later row of that call reads the opening from the
    // log.
    fn source_of<DamagedFrom>(
        &self,
        reads: &RunTurnReads<'_, DamagedFrom>,
        event: &EventEnvelope,
        run_id: &RunId,
        fold: &mut RunFold,
        tool_call_id: Option<&str>,
    ) -> Result<EpochPosition, TurnAttributionError>
    where
        DamagedFrom: Fn(&SessionId) -> Option<i64>,
    {
        let stamped_source = stamped_source_of(&event.payload);
        let Some(tool_call_id) = tool_call_id else {
            return Ok(stamped_source.unwrap_or(fold.standing));
        };
        let held = fold.opened_tool_calls.remove(tool_call_id);
        if let Some(source) = stamped_source.or(held) {
            return Ok(source);
        }
        Ok(reads
            .read_tool_call_opening_before(
                &self.session_id,
                run_id,
                tool_call_id,
                i64::from(event.sequence),
            )?
            .unwrap_or(fold.standing))
    }

    // The run's held fold, taken out of the map, or one seeded from the log before `sequence`.
    fn take_fold<DamagedFrom>(
        &mut self,
        reads: &RunTurnReads<'_, DamagedFrom>,
        run_id: &RunId,
        sequence: i64,
    ) -> Result<RunFold, TurnAttributionError>
    where
        DamagedFrom: Fn(&SessionId) -> Option<i64>,
    {
        match self.fold_by_run_id.remove(run_id) {
            Some(held) => Ok(held),
            None => reads.read_seed(&self.session_id, run_id, sequence),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::event::envelope::EventEnvelope;
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;

    use super::{RunTurnReads, SessionTurnAttribution};
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    fn run_event(
        session_id: &SessionId,
        sequence: u64,
        event_type: SessionEventType,
        run_id: &RunId,
    ) -> EventEnvelope {
        serde_json::from_value(json!({
            "id": mint_uuid_v7().to_string(),
            "sessionId": session_id,
            "sequence": sequence,
            "occurredAt": "2026-10-14T09:00:00.000Z",
            "category": event_type.category().as_str(),
            "type": event_type.as_str(),
            "payload": { "runId": run_id },
            "version": "1.0",
        }))
        .expect("the test's envelope reads")
    }

    #[test]
    fn a_run_terminal_event_frees_its_fold() {
        let database = TestDatabase::new();
        database.opener()().expect("the test creates its database");
        let reader = database.reader();
        let no_damage = |_: &SessionId| None;
        let reads = RunTurnReads::new(&reader, no_damage);
        let session_id = test_session_id();
        let run_id = RunId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is a run id");
        let mut attribution = SessionTurnAttribution::new(session_id);

        attribution
            .attribute(
                &reads,
                &run_event(&session_id, 0, SessionEventType::AgentRunRunning, &run_id),
            )
            .expect("a running run's event is attributed");
        assert!(attribution.fold_by_run_id.contains_key(&run_id));

        attribution
            .attribute(
                &reads,
                &run_event(&session_id, 1, SessionEventType::AgentRunCompleted, &run_id),
            )
            .expect("a run's terminal event is attributed");
        assert!(!attribution.fold_by_run_id.contains_key(&run_id));
    }
}
