//! The attention tables of the daemon's one schema: one row per entry an event raised, what became
//! of each entry's banner and web-address message, how far the person has seen each subject, and
//! the change counts a subscriber follows.
//!
//! The entries are a projection of the session events, written in each event's own write and
//! rebuilt from the log; the deliveries, the seen marks and the counts are the daemon's own
//! writes, which a rebuild leaves alone. No table refers to another, so a purge deletes them in any
//! order.

use sidekicks_contracts::attention::{
    AttentionBannerState, AttentionSeverity, AttentionTrigger, AttentionWebAddressState,
};
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::sql_list_of_every;

/// The runs' list, which a run's end reads to raise an entry only for a lead run, and the attention
/// tables' own part.
pub fn schema_parts() -> SchemaParts {
    crate::run::schema::schema_parts()
        .with_part(SchemaPart::new("attention", attention_schema_sql()))
}

fn attention_schema_sql() -> String {
    let triggers = sql_list_of_every::<AttentionTrigger>();
    let severities = sql_list_of_every::<AttentionSeverity>();
    let banner_states = sql_list_of_every::<AttentionBannerState>();
    let web_address_states = sql_list_of_every::<AttentionWebAddressState>();
    format!(
        "
-- One row per entry: a wait on the person, a run's or workflow run's end, or a Notify step's
-- notice. Its id is the event that raised it, or a Notify step's moment id. Rebuilt from the log,
-- the Notify rows apart, which their step's own write keeps.
CREATE TABLE attention_entries (
  id                TEXT PRIMARY KEY,
  moment_id         TEXT NOT NULL,             -- what a later state of it replaces
  session_id        TEXT NOT NULL,
  run_id            TEXT,                      -- an agent run's wait or end, or a plan's run
  workflow_run_id   TEXT,                      -- a workflow run's end, step wait or Notify
  plan_id           TEXT,                      -- a plan's wait on its card
  -- A workflow step's whole key: its node, attempt and execution; a Notify step has no attempt.
  node_id           TEXT,
  attempt           INTEGER,
  execution_index   INTEGER,
  trigger           TEXT NOT NULL CHECK(trigger IN ({triggers})),
  severity          TEXT NOT NULL CHECK(severity IN ({severities})),
  notice_text       TEXT,                      -- a Notify step's notice; NULL on every other
  -- The event that raised it, whose sequence the seen mark and the retention cut compare.
  source_event_id   TEXT NOT NULL,
  created_at        TEXT NOT NULL,             -- the raising event's instant
  resolved_at       TEXT                       -- the resolving event's instant; NULL while open
) STRICT;

CREATE INDEX idx_attention_entries_session ON attention_entries(session_id, resolved_at);
-- A deleted workflow run's entries, and a step's wait as its step resolves.
CREATE INDEX idx_attention_entries_workflow_run ON attention_entries(workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
-- The open entries of a moment, which the moment's next state resolves.
CREATE INDEX idx_attention_entries_open_moment ON attention_entries(moment_id)
  WHERE resolved_at IS NULL;

-- What became of an entry's banner and web-address message, decided once per entry. No row, or
-- a NULL banner_state, is an undecided banner.
CREATE TABLE attention_deliveries (
  entry_id                   TEXT PRIMARY KEY,
  banner_state               TEXT CHECK(banner_state IS NULL OR banner_state IN ({banner_states})),
  -- The entry whose banner this one merged into; it is decided when that entry resolves.
  merged_into                TEXT,
  web_address_state          TEXT
                             CHECK(web_address_state IS NULL
                                   OR web_address_state IN ({web_address_states})),
  web_address_attempt_count  INTEGER CHECK(web_address_attempt_count IS NULL
                                           OR web_address_attempt_count >= 0),
  digested_at                TEXT,             -- when an email digest carried it
  muted_at_decision          TEXT,             -- the session's mute when it was decided
  CHECK((web_address_state IS NULL) = (web_address_attempt_count IS NULL))
) STRICT;

-- The undecided entries a resolving entry hands its banner back to.
CREATE INDEX idx_attention_deliveries_merged_into ON attention_deliveries(merged_into)
  WHERE merged_into IS NOT NULL;

-- How far the person has seen each subject, as the session's newest event sequence when they
-- looked: a session's own row has run_id '', a workflow run's names the run.
CREATE TABLE attention_seen (
  session_id             TEXT NOT NULL,
  run_id                 TEXT NOT NULL DEFAULT '',
  seen_through_sequence  INTEGER NOT NULL,
  PRIMARY KEY (session_id, run_id)
) STRICT, WITHOUT ROWID;

-- A count per scope that every attention change raises, '' for the whole machine and a session's
-- id for its own, and the sequence up to which a session's entries are past keeping.
CREATE TABLE attention_versions (
  scope_key                  TEXT PRIMARY KEY,
  version                    INTEGER NOT NULL CHECK(version >= 1),
  retained_through_sequence  INTEGER
) STRICT;
"
    )
}
