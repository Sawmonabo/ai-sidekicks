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
  id                TEXT PRIMARY KEY,
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
-- and numbered again. A NULL key would pass a UNIQUE index, so the trigger below refuses one.
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
  AND (NEW.run_id IS NULL OR NEW.run_version IS NULL
    OR NEW.run_id IS NOT OLD.run_id OR NEW.run_version IS NOT OLD.run_version
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
  AND (NEW.run_id IS NULL OR NEW.turn_number IS NULL
    OR NEW.run_id IS NOT OLD.run_id OR NEW.turn_number IS NOT OLD.turn_number
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
