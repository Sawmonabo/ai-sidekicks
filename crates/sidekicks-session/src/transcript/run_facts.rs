//! The facts of the runs a transcript window names, folded from the whole log rather than the
//! window's rows, so a run whose creation or first actor lies outside the window still reads whole.
//! Each run costs three seeks: its creation, which names the account it was admitted under; its
//! first event naming an actor; and its state events newest first, read back only to the newest one
//! that set a state. Folding those in log order answers what folding every event of the run would.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, Row, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RUN_INITIAL_STATE;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::row::TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE;
use sidekicks_contracts::transcript::run_facts::{
    FoldedThroughSequence, RUN_STATE_EVENT_TYPES, TranscriptRunBeat, TranscriptRunFacts,
    UNFOLDED_TRANSCRIPT_RUN_FACTS, USER_MESSAGE_EVENT_TYPE, fold_transcript_run_facts,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{
    json_object_column, optional_text_column, safe_int_column,
};
use sidekicks_store::events::session::read::{readable_event_sql, session_read_bound};

const BEAT_COLUMNS_SQL: &str = "sequence, type, actor, payload";

// Through the run-and-type index.
static SELECT_CREATION_SQL: LazyLock<String> = LazyLock::new(|| {
    let creation_type = RUN_STATE_EVENT_TYPES
        .iter()
        .find(|event_type| event_type.state() == RUN_INITIAL_STATE)
        .expect("every run state has its event type")
        .session_event_type()
        .as_str();
    format!(
        "SELECT {BEAT_COLUMNS_SQL} FROM session_events AS event
  WHERE session_id = @session_id AND type = '{creation_type}' AND run_id = @run_id
    AND {}
  ORDER BY sequence
  LIMIT 1",
        readable_event_sql("event")
    )
});

// Through the run-and-actor index; a person's message steering the run is not the run's own.
static SELECT_FIRST_ACTOR_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {BEAT_COLUMNS_SQL} FROM session_events AS event
  WHERE session_id = @session_id AND run_id = @run_id AND actor IS NOT NULL
    AND type <> '{USER_MESSAGE_EVENT_TYPE}' AND {}
  ORDER BY sequence
  LIMIT 1",
        readable_event_sql("event")
    )
});

// Through the run-and-type index, one seek per type. The unary `+` keeps the planner from walking
// the session's whole log down its sequence index to skip sorting the run's few state events.
static SELECT_STATE_BEATS_NEWEST_FIRST_SQL: LazyLock<String> = LazyLock::new(|| {
    let state_beat_types = sql_list_of(
        RUN_STATE_EVENT_TYPES
            .iter()
            .map(|event_type| event_type.session_event_type().as_str())
            .chain([TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE]),
    );
    format!(
        "SELECT {BEAT_COLUMNS_SQL} FROM session_events AS event
  WHERE session_id = @session_id AND type IN ({state_beat_types}) AND run_id = @run_id
    AND {}
  ORDER BY +sequence DESC",
        readable_event_sql("event")
    )
});

/// Reads the facts of a window's runs on the daemon's read-only connection. A read fails with
/// `rusqlite::Error::FromSqlConversionFailure` when a stored payload is not a JSON object, an
/// actor is not event text or a sequence is not a safe integer, and with SQLite's error otherwise.
pub(crate) struct TranscriptRunFactsReader<'reader, DamagedFrom> {
    reader: &'reader Connection,
    read_damaged_from_sequence: DamagedFrom,
}

impl<'reader, DamagedFrom> TranscriptRunFactsReader<'reader, DamagedFrom>
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

    /// The facts of each of `run_ids`, in that order, folded through `head_sequence`, the newest
    /// event of the snapshot the caller reads in.
    pub(crate) fn read(
        &self,
        session_id: &SessionId,
        run_ids: &[RunId],
        head_sequence: FoldedThroughSequence,
    ) -> rusqlite::Result<Vec<TranscriptRunFacts>> {
        let read_bound = session_read_bound(&self.read_damaged_from_sequence, session_id, None);
        run_ids
            .iter()
            .map(|run_id| {
                let run_id_text = run_id.text();
                let mut beats = Vec::new();
                for sql in [&*SELECT_CREATION_SQL, &*SELECT_FIRST_ACTOR_SQL] {
                    let beat = self
                        .reader
                        .prepare_cached(sql)?
                        .query_row(
                            named_params! {
                                "@session_id": session_id.text().as_str(),
                                "@run_id": run_id_text.as_str(),
                                "@read_bound": read_bound,
                            },
                            StoredBeat::from_row,
                        )
                        .optional()?;
                    beats.extend(beat);
                }
                beats.extend(self.read_state_beats_from_newest_setting(
                    session_id,
                    run_id_text.as_str(),
                    read_bound,
                )?);
                beats.sort_by_key(|beat| beat.sequence);
                let folded = beats
                    .iter()
                    .fold(UNFOLDED_TRANSCRIPT_RUN_FACTS, |facts, beat| {
                        fold_transcript_run_facts(&facts, &beat.as_beat())
                    });
                Ok(TranscriptRunFacts {
                    run_id: *run_id,
                    actor: folded.actor,
                    admitted_provider_account_id: folded.admitted_provider_account_id,
                    state_event_type: folded.state_event_type,
                    is_rewound: folded.is_rewound,
                    folded_through_sequence: head_sequence,
                })
            })
            .collect()
    }

    // The run's state events back to the newest that set a state, newest first: the events before
    // it can no longer change the state or the rewind.
    fn read_state_beats_from_newest_setting(
        &self,
        session_id: &SessionId,
        run_id: &str,
        read_bound: i64,
    ) -> rusqlite::Result<Vec<StoredBeat>> {
        let mut statement = self
            .reader
            .prepare_cached(&SELECT_STATE_BEATS_NEWEST_FIRST_SQL)?;
        let mut rows = statement.query(named_params! {
            "@session_id": session_id.text().as_str(),
            "@run_id": run_id,
            "@read_bound": read_bound,
        })?;
        let mut newest_first = Vec::new();
        while let Some(row) = rows.next()? {
            let beat = StoredBeat::from_row(row)?;
            let sets_state =
                fold_transcript_run_facts(&UNFOLDED_TRANSCRIPT_RUN_FACTS, &beat.as_beat())
                    .state_event_type
                    .is_some();
            newest_first.push(beat);
            if sets_state {
                break;
            }
        }
        Ok(newest_first)
    }
}

/// One stored event as the fold reads it, owned so the fold can borrow it as a beat.
struct StoredBeat {
    sequence: SafeInt<0>,
    event_type: String,
    actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    payload: Map<String, Value>,
}

impl StoredBeat {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            sequence: safe_int_column(row, 0)?,
            event_type: row.get(1)?,
            actor: optional_text_column(row, 2, FreeFormText::new)?,
            payload: json_object_column(row, 3)?,
        })
    }

    fn as_beat(&self) -> TranscriptRunBeat<'_> {
        TranscriptRunBeat {
            event_type: &self.event_type,
            sequence: self.sequence,
            actor: self.actor.as_ref(),
            payload: Some(&self.payload),
        }
    }
}
