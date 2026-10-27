//! The event log's part of the daemon's schema: `session_events`, the append-only truth every
//! session projection is rebuilt from, its indexes and the triggers that hold a terminal row, a
//! turn start and a turn end to their keys, and `session_snapshots`, a cache of a session's state
//! at a sequence that the log can always rebuild.

use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::transcript::run_facts::RunStateEventType;
use sidekicks_contracts::transcript::turn_attribution::{
    TURN_END_EVENT_TYPES, TURN_STARTED_EVENT_TYPE,
};
use strum::VariantArray as _;

use crate::database::schema::SESSION_EVENTS_TABLE;
use crate::database::sql_list::sql_list_of;
use crate::events::session::skipped_ranges::DAMAGED_EVENTS_SKIPPED_TYPE;

/// The event log's tables, indexes and triggers, in foreign-key order.
pub(super) fn event_log_schema_sql() -> String {
    let run_lifecycle = EventCategory::RunLifecycle.as_str();
    let skipped_type = DAMAGED_EVENTS_SKIPPED_TYPE.as_str();
    // The event types that enter a terminal run state, the same rule the run engine reads.
    let terminal_types = sql_list_of(
        RunStateEventType::VARIANTS
            .iter()
            .filter(|event_type| event_type.state().is_terminal())
            .map(|event_type| event_type.session_event_type().as_str()),
    );
    let turn_end_types = sql_list_of(TURN_END_EVENT_TYPES);
    format!(
        "
-- ---------------------------------------------------------------------------
-- {SESSION_EVENTS_TABLE}: the append-only event log.
-- ---------------------------------------------------------------------------
CREATE TABLE {SESSION_EVENTS_TABLE} (
  -- The rowid, declared so a VACUUM keeps it: the search index keys its rows on it.
  rowid             INTEGER PRIMARY KEY,
  id                TEXT NOT NULL UNIQUE,
  -- A session's id, or a reserved daemon-scope id for a daemon-scope event; no foreign key.
  session_id        TEXT NOT NULL,
  sequence          INTEGER NOT NULL,             -- monotonic per session
  occurred_at       TEXT NOT NULL,                -- RFC 3339 UTC, ms precision; display and audit
  -- Nanoseconds since the daemon's start at emit; ordering within one daemon only.
  monotonic_ns      INTEGER NOT NULL,
  category          TEXT NOT NULL,
  type              TEXT NOT NULL,
  actor             TEXT,                         -- the payload's actor; NULL when it names none
  payload           TEXT NOT NULL DEFAULT '{{}}', -- JSON
  -- Machine-authored prose kept beside the payload, so a read fetches it on demand: UTF-8 bytes,
  -- or zstd when the payload says so. NULL on every row whose type carries none.
  content_payload   BLOB,
  correlation_id    TEXT,
  causation_id      TEXT,
  -- 'MAJOR.MINOR'. The GLOB is only a smoke check; the writer parses the real shape. Text,
  -- because a comparison parses the parts.
  version           TEXT NOT NULL DEFAULT '1.0'
                    CHECK(version GLOB '[0-9]*.[0-9]*'),
  -- The run the event belongs to and the run's progression counter it was written at, written by
  -- the append for every type that carries a run; NULL otherwise.
  run_id            TEXT,
  run_version       INTEGER,
  -- The turn's number within its run, from 1, written beside run_id for the turn start and the
  -- three turn ends; NULL otherwise.
  turn_number       INTEGER,
  -- The provider message and block a run's reply or reasoning piece belongs to; on a tool
  -- completion that names patched files and on each stored part of them, the completion's id;
  -- NULL otherwise.
  join_key          TEXT,
  -- On a piece or stored part that continues an earlier row, the sequence of the row's first
  -- piece; NULL on the first piece and on every other event.
  joins_sequence    INTEGER,
  -- The run an event is filed under without being that run's own event, an intervention's
  -- target among them; NULL on an event of a run and on a session-level one.
  target_run_id     TEXT,
  -- The tool call a run's tool completion completes; NULL on its stored parts and on every other
  -- event.
  tool_call_id      TEXT,
  -- On a stored part of a tool completion's patched files, which is no event of its own, the
  -- file's place in the completion's list; NULL on every event.
  patch_file_index  INTEGER,
  -- On a stored part of a file's text, the UTF-8 offset in the text of its first byte; NULL on
  -- every other row.
  patch_text_offset INTEGER,
  UNIQUE (session_id, sequence)
) STRICT;

CREATE INDEX idx_session_events_type ON {SESSION_EVENTS_TABLE}(session_id, type);
-- The sessions that skipped a damaged range, few or none, so a read over many sessions' rows
-- probes the skipped ranges of those sessions alone.
CREATE INDEX idx_session_events_skipped ON {SESSION_EVENTS_TABLE}(session_id)
  WHERE type = '{skipped_type}';
-- One run's events of one type in log order, for the reads that seed a run's turns and that find
-- a live run's agent and newest touch.
CREATE INDEX idx_session_events_run ON {SESSION_EVENTS_TABLE}(session_id, type, run_id, sequence)
  WHERE run_id IS NOT NULL;
-- One run's events in log order, read beside the events filed under it.
CREATE INDEX idx_session_events_run_sequence ON {SESSION_EVENTS_TABLE}(session_id, run_id, sequence)
  WHERE run_id IS NOT NULL;
-- The events filed under a run that are not its own, in log order.
CREATE INDEX idx_session_events_target_run
  ON {SESSION_EVENTS_TABLE}(session_id, target_run_id, sequence)
  WHERE target_run_id IS NOT NULL;
-- A tool call's completions, newest last, for the read of the patches it left out.
CREATE INDEX idx_session_events_tool_call
  ON {SESSION_EVENTS_TABLE}(session_id, tool_call_id, sequence)
  WHERE tool_call_id IS NOT NULL;
-- A run's newest piece of one type under one message and block, which a later piece joins.
CREATE INDEX idx_session_events_join_key
  ON {SESSION_EVENTS_TABLE}(session_id, run_id, type, join_key, sequence, joins_sequence)
  WHERE join_key IS NOT NULL;
-- Every piece continuing a row, by the row's first piece, in log order.
CREATE INDEX idx_session_events_joins
  ON {SESSION_EVENTS_TABLE}(session_id, joins_sequence, sequence)
  WHERE joins_sequence IS NOT NULL;
-- A completion's stored parts by file and text offset, so a patch read finds the parts of one
-- range of one file without reading the rest.
CREATE INDEX idx_session_events_patch_parts
  ON {SESSION_EVENTS_TABLE}(
    session_id, joins_sequence, patch_file_index, patch_text_offset, sequence
  )
  WHERE patch_file_index IS NOT NULL;
-- One run's events that name an actor, in log order, for the read that finds who acts for a run.
CREATE INDEX idx_session_events_run_actor ON {SESSION_EVENTS_TABLE}(session_id, run_id, sequence)
  WHERE run_id IS NOT NULL AND actor IS NOT NULL;
CREATE INDEX idx_session_events_correlation ON {SESSION_EVENTS_TABLE}(correlation_id)
  WHERE correlation_id IS NOT NULL;
-- At most one terminal event per run version. A NULL key would pass a UNIQUE index, so the
-- triggers below refuse one.
CREATE UNIQUE INDEX idx_session_events_run_terminal_once
  ON {SESSION_EVENTS_TABLE}(run_id, run_version)
  WHERE category = '{run_lifecycle}' AND type IN ({terminal_types});
-- Every started turn gets exactly one end; a late turn end is the one row a run's log takes after
-- its terminal row. A NULL key would pass a UNIQUE index, so the triggers below refuse one.
CREATE UNIQUE INDEX idx_session_events_turn_end_once
  ON {SESSION_EVENTS_TABLE}(run_id, turn_number)
  WHERE category = '{run_lifecycle}' AND type IN ({turn_end_types});
-- A turn number starts once in its run: a start that raced another to the same number is refused
-- and numbered again. A NULL key would pass a UNIQUE index, so the triggers below refuse one.
CREATE UNIQUE INDEX idx_session_events_turn_start_once
  ON {SESSION_EVENTS_TABLE}(run_id, turn_number)
  WHERE category = '{run_lifecycle}' AND type = '{TURN_STARTED_EVENT_TYPE}';

-- A terminal insert must carry its run's key.
CREATE TRIGGER trg_run_terminal_key_insert BEFORE INSERT ON {SESSION_EVENTS_TABLE}
WHEN NEW.category = '{run_lifecycle}'
  AND NEW.type IN ({terminal_types})
  AND (NEW.run_id IS NULL OR NEW.run_version IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a terminal run row requires a run_id and a run_version');
END;

-- A committed terminal row keeps its key and cannot be moved out of the index's predicate. IS NOT,
-- not <>, so a NULL operand still yields true or false.
CREATE TRIGGER trg_run_terminal_key_update
BEFORE UPDATE OF run_id, run_version, category, type ON {SESSION_EVENTS_TABLE}
WHEN OLD.category = '{run_lifecycle}'
  AND OLD.type IN ({terminal_types})
  AND (NEW.run_id IS NOT OLD.run_id OR NEW.run_version IS NOT OLD.run_version
    OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'a terminal run row keeps its run_id, run_version, category and type');
END;

-- Terminal rows are insert-only: no update may promote a row into the index.
CREATE TRIGGER trg_run_terminal_key_promote
BEFORE UPDATE OF category, type ON {SESSION_EVENTS_TABLE}
WHEN NOT (OLD.category = '{run_lifecycle}' AND OLD.type IN ({terminal_types}))
  AND NEW.category = '{run_lifecycle}'
  AND NEW.type IN ({terminal_types})
BEGIN
  SELECT RAISE(ABORT, 'a row cannot become a terminal run row by UPDATE; terminal rows are \
         insert-only');
END;

-- A turn-end insert must carry its turn's key.
CREATE TRIGGER trg_turn_end_key_insert BEFORE INSERT ON {SESSION_EVENTS_TABLE}
WHEN NEW.category = '{run_lifecycle}'
  AND NEW.type IN ({turn_end_types})
  AND (NEW.run_id IS NULL OR NEW.turn_number IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a turn end row requires a run_id and a turn_number');
END;

-- A committed turn end keeps its key and cannot be moved out of the index's predicate.
CREATE TRIGGER trg_turn_end_key_update
BEFORE UPDATE OF run_id, turn_number, category, type ON {SESSION_EVENTS_TABLE}
WHEN OLD.category = '{run_lifecycle}'
  AND OLD.type IN ({turn_end_types})
  AND (NEW.run_id IS NOT OLD.run_id OR NEW.turn_number IS NOT OLD.turn_number
    OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'a turn end row keeps its run_id, turn_number, category and type');
END;

-- Turn ends are insert-only: no update may promote a row into the index.
CREATE TRIGGER trg_turn_end_key_promote
BEFORE UPDATE OF category, type ON {SESSION_EVENTS_TABLE}
WHEN NOT (OLD.category = '{run_lifecycle}' AND OLD.type IN ({turn_end_types}))
  AND NEW.category = '{run_lifecycle}'
  AND NEW.type IN ({turn_end_types})
BEGIN
  SELECT RAISE(ABORT, 'a row cannot become a turn end row by UPDATE; turn end rows are \
         insert-only');
END;

-- A turn-start insert must carry its turn's key.
CREATE TRIGGER trg_turn_start_key_insert BEFORE INSERT ON {SESSION_EVENTS_TABLE}
WHEN NEW.category = '{run_lifecycle}'
  AND NEW.type = '{TURN_STARTED_EVENT_TYPE}'
  AND (NEW.run_id IS NULL OR NEW.turn_number IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a turn start row requires a run_id and a turn_number');
END;

-- A committed turn start keeps its key and cannot be moved out of the index's predicate.
CREATE TRIGGER trg_turn_start_key_update
BEFORE UPDATE OF run_id, turn_number, category, type ON {SESSION_EVENTS_TABLE}
WHEN OLD.category = '{run_lifecycle}'
  AND OLD.type = '{TURN_STARTED_EVENT_TYPE}'
  AND (NEW.run_id IS NOT OLD.run_id OR NEW.turn_number IS NOT OLD.turn_number
    OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'a turn start row keeps its run_id, turn_number, category and type');
END;

-- Turn starts are insert-only: no update may promote a row into the index.
CREATE TRIGGER trg_turn_start_key_promote
BEFORE UPDATE OF category, type ON {SESSION_EVENTS_TABLE}
WHEN NOT (OLD.category = '{run_lifecycle}' AND OLD.type = '{TURN_STARTED_EVENT_TYPE}')
  AND NEW.category = '{run_lifecycle}'
  AND NEW.type = '{TURN_STARTED_EVENT_TYPE}'
BEGIN
  SELECT RAISE(ABORT, 'a row cannot become a turn start row by UPDATE; turn start rows are \
         insert-only');
END;

CREATE TABLE session_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  as_of_sequence  INTEGER NOT NULL,             -- reflects events up to this sequence
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES {SESSION_EVENTS_TABLE}(session_id, sequence)
) STRICT;

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);
"
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use rusqlite::{Connection, ffi};
    use sidekicks_contracts::event::envelope::EventCategory;
    use sidekicks_contracts::transcript::run_facts::RunStateEventType;
    use sidekicks_contracts::transcript::turn_attribution::{
        TURN_END_EVENT_TYPES, TURN_STARTED_EVENT_TYPE,
    };

    use super::event_log_schema_sql;
    use crate::database::schema::SESSION_EVENTS_TABLE;

    // A unique index whose key the triggers hold, by the event type it covers and the key column
    // beside `run_id`.
    #[derive(Clone, Copy, Debug)]
    enum KeyedIndex {
        RunTerminal,
        TurnStart,
        TurnEnd,
    }

    impl KeyedIndex {
        fn event_type(self) -> &'static str {
            match self {
                Self::RunTerminal => RunStateEventType::Completed.session_event_type().as_str(),
                Self::TurnStart => TURN_STARTED_EVENT_TYPE,
                Self::TurnEnd => TURN_END_EVENT_TYPES[0],
            }
        }

        fn key_column(self) -> &'static str {
            match self {
                Self::RunTerminal => "run_version",
                Self::TurnStart | Self::TurnEnd => "turn_number",
            }
        }
    }

    // One column of an index's key: `run_id`, or the column the index pairs with it.
    #[derive(Clone, Copy, Debug)]
    enum KeyColumn {
        RunId,
        Paired,
    }

    impl KeyColumn {
        fn name(self, index: KeyedIndex) -> &'static str {
            match self {
                Self::RunId => "run_id",
                Self::Paired => index.key_column(),
            }
        }
    }

    // A write against a log holding one keyed row of the index (`keyed`) and one run row outside
    // it with no key (`unkeyed`).
    #[derive(Clone, Copy, Debug)]
    enum Write {
        InsertWithNullKey(KeyColumn),
        UpdateNullingKey(KeyColumn),
        UpdateRekeying(KeyColumn),
        PromoteAnotherRow,
        UpdateMovingOut,
        UpdateMovingOutByCategory,
        InsertWithKey,
    }

    // `run_id` and `key` are SQL literals.
    fn insert_sql(index: KeyedIndex, id: &str, sequence: u32, run_id: &str, key: &str) -> String {
        format!(
            "INSERT INTO {SESSION_EVENTS_TABLE}
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, run_id,
                {column})
             VALUES ('{id}', 'session-1', {sequence}, '2026-01-01T00:00:00.000Z', {sequence},
               '{category}', '{event_type}', {run_id}, {key})",
            column = index.key_column(),
            category = EventCategory::RunLifecycle.as_str(),
            event_type = index.event_type(),
        )
    }

    fn write_sql(index: KeyedIndex, write: Write) -> String {
        match write {
            Write::InsertWithNullKey(KeyColumn::RunId) => {
                insert_sql(index, "added", 3, "NULL", "2")
            }
            Write::InsertWithNullKey(KeyColumn::Paired) => {
                insert_sql(index, "added", 3, "'run-1'", "NULL")
            }
            Write::UpdateNullingKey(column) => format!(
                "UPDATE {SESSION_EVENTS_TABLE} SET {} = NULL WHERE id = 'keyed'",
                column.name(index)
            ),
            Write::UpdateRekeying(column) => {
                let value = match column {
                    KeyColumn::RunId => "'run-2'",
                    KeyColumn::Paired => "2",
                };
                format!(
                    "UPDATE {SESSION_EVENTS_TABLE} SET {} = {value} WHERE id = 'keyed'",
                    column.name(index)
                )
            }
            Write::PromoteAnotherRow => format!(
                "UPDATE {SESSION_EVENTS_TABLE} SET type = '{}' WHERE id = 'unkeyed'",
                index.event_type()
            ),
            Write::UpdateMovingOut => format!(
                "UPDATE {SESSION_EVENTS_TABLE} SET type = '{}' WHERE id = 'keyed'",
                RunStateEventType::Queued.session_event_type().as_str()
            ),
            Write::UpdateMovingOutByCategory => format!(
                "UPDATE {SESSION_EVENTS_TABLE} SET category = '{}' WHERE id = 'keyed'",
                EventCategory::AgentOutput.as_str()
            ),
            Write::InsertWithKey => insert_sql(index, "added", 3, "'run-1'", "2"),
        }
    }

    // Each refused write slips past the unique index without its trigger: a NULL key is distinct
    // from every other, and a re-key, a promote or a move out leaves no duplicate. So the refusal
    // must be the trigger's own.
    #[rstest]
    #[case::insert_with_a_null_run_id(Write::InsertWithNullKey(KeyColumn::RunId), false)]
    #[case::insert_with_a_null_paired_key(Write::InsertWithNullKey(KeyColumn::Paired), false)]
    #[case::update_nulling_a_committed_run_id(Write::UpdateNullingKey(KeyColumn::RunId), false)]
    #[case::update_nulling_a_committed_paired_key(
        Write::UpdateNullingKey(KeyColumn::Paired),
        false
    )]
    #[case::update_rekeying_a_committed_run_id(Write::UpdateRekeying(KeyColumn::RunId), false)]
    #[case::update_rekeying_a_committed_paired_key(Write::UpdateRekeying(KeyColumn::Paired), false)]
    #[case::promote_of_another_row(Write::PromoteAnotherRow, false)]
    #[case::update_moving_a_committed_row_out(Write::UpdateMovingOut, false)]
    #[case::update_moving_a_committed_row_out_by_category(Write::UpdateMovingOutByCategory, false)]
    #[case::insert_with_its_key(Write::InsertWithKey, true)]
    fn the_key_triggers_hold_each_unique_index_to_its_key(
        #[values(KeyedIndex::RunTerminal, KeyedIndex::TurnStart, KeyedIndex::TurnEnd)]
        index: KeyedIndex,
        #[case] write: Write,
        #[case] is_admitted: bool,
    ) {
        let connection = Connection::open_in_memory().expect("an in-memory database opens");
        connection
            .execute_batch(&event_log_schema_sql())
            .expect("the event log's schema runs");
        connection
            .execute_batch(&insert_sql(index, "keyed", 1, "'run-1'", "1"))
            .expect("a keyed row is admitted");
        connection
            .execute_batch(&format!(
                "INSERT INTO {SESSION_EVENTS_TABLE}
                   (id, session_id, sequence, occurred_at, monotonic_ns, category, type)
                 VALUES ('unkeyed', 'session-1', 2, '2026-01-01T00:00:00.000Z', 2, '{}', '{}')",
                EventCategory::RunLifecycle.as_str(),
                RunStateEventType::Queued.session_event_type().as_str(),
            ))
            .expect("a run row outside the index is admitted");
        // `None` is any failure other than a trigger's refusal, such as a unique index's.
        let outcome = match connection.execute_batch(&write_sql(index, write)) {
            Ok(()) => Some(true),
            Err(error) => error
                .sqlite_error()
                .is_some_and(|failure| failure.extended_code == ffi::SQLITE_CONSTRAINT_TRIGGER)
                .then_some(false),
        };
        assert_eq!(outcome, Some(is_admitted));
    }
}
