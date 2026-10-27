//! The runs' part of the daemon's schema. `runs` is a projection written in the same write as each
//! run event that moves it, so it always equals a rebuild from the log. The admission queue and the
//! interventions are truth their own writes keep: what waits to be delivered, and the saved answer
//! a retried request returns.

use sidekicks_contracts::run::intervention::{InterventionState, InterventionType};
use sidekicks_contracts::run::queue::{QueueItemNotDeliveredKind, QueueItemState};
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;

use crate::run::transitions::RUN_TERMINAL_STATES_SQL;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::{sql_list_of, sql_list_of_every};

/// The search index's list and the runs' own part.
pub(crate) fn schema_parts() -> SchemaParts {
    crate::search::index::schema::schema_parts()
        .with_part(SchemaPart::new("runs", runs_schema_sql()))
}

// The runs' tables and indexes.
fn runs_schema_sql() -> String {
    let queue_states = sql_list_of_every::<QueueItemState>();
    let queued = <&'static str>::from(QueueItemState::Queued);
    let not_delivered = <&'static str>::from(QueueItemState::NotDelivered);
    let not_delivered_reasons = sql_list_of_every::<QueueItemNotDeliveredKind>();
    let refused_by_hook = <&'static str>::from(QueueItemNotDeliveredKind::RefusedByHook);
    let intervention_types = sql_list_of_every::<InterventionType>();
    let intervention_states = sql_list_of_every::<InterventionState>();
    let requested = <&'static str>::from(InterventionState::Requested);
    let pending_choices = sql_list_of_every::<InterruptPendingChoice>();
    let unresolved_intervention_states = sql_list_of(
        [InterventionState::Requested, InterventionState::Accepted].map(<&'static str>::from),
    );
    let reached_by = sql_list_of_every::<ChildRunProvenance>();
    let run_states = sql_list_of_every::<RunState>();
    let terminal_states = &*RUN_TERMINAL_STATES_SQL;
    format!(
        "
-- ---------------------------------------------------------------------------
-- The admission queue and interventions.
-- ---------------------------------------------------------------------------
-- A queued item's body, a person's send or an orchestration-authored prompt, rides payload as
-- plain text. Every column the drain selects on is its own column.
CREATE TABLE queue_items (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT '{queued}' CHECK(state IN ({queue_states})),
  -- Why a not-delivered item was not delivered: it waited past the daemon's delivery timeout, its
  -- delivery failed outright, or the person's own prompt hook refused it once handed.
  not_delivered_reason   TEXT CHECK(not_delivered_reason IN ({not_delivered_reasons})),
  -- The hook's own words, present exactly on an item the person's prompt hook refused.
  not_delivered_words    TEXT,
  payload                TEXT NOT NULL DEFAULT '{{}}', -- JSON
  -- The run the item is delivered into; NULL on an orchestration-authored item, which is admitted
  -- as a new run.
  target_run_id          TEXT,
  -- The device a person's send came from, found from the connection; NULL on the system's own.
  device_id              TEXT,
  -- The child whose queue holds it; NULL on the lead's.
  child_handle           TEXT,
  -- The item's place in its queue's order, lowest first: send order until a reorder replaces it,
  -- and an edit takes the place of the item it supersedes.
  position               INTEGER NOT NULL CHECK(position >= 0),
  -- The send's own key, so a retried send returns the saved item; NULL on the system's own.
  client_idempotency_key TEXT,
  -- The mark of the `Send now` in force that handed the item ahead of what its provider held: the
  -- id its answer carries. NULL on every other item, and once a later order moves the item off
  -- first place.
  send_now_id            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK((state = '{not_delivered}') = (not_delivered_reason IS NOT NULL)),
  CHECK((not_delivered_reason IS '{refused_by_hook}') = (not_delivered_words IS NOT NULL)),
  -- SQLite treats each NULL as distinct, so only sends dedupe.
  UNIQUE (session_id, client_idempotency_key)
) STRICT;

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_target_run ON queue_items(target_run_id)
  WHERE target_run_id IS NOT NULL;

-- Each key a person's `Send now` spent on a run, with the message it handed and the id its first
-- answer carried, kept for the run's life whatever later becomes of the message's mark, so a
-- retried `Send now` answers what the first did.
CREATE TABLE send_now_requests (
  target_run_id           TEXT NOT NULL,
  client_idempotency_key  TEXT NOT NULL,
  queue_item_id           TEXT NOT NULL,
  intervention_id         TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  PRIMARY KEY (target_run_id, client_idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE interventions (
  id                      TEXT PRIMARY KEY,
  target_run_id           TEXT NOT NULL,
  type                    TEXT NOT NULL CHECK(type IN ({intervention_types})),
  state                   TEXT NOT NULL DEFAULT '{requested}'
                          CHECK(state IN ({intervention_states})),
  -- JSON: the request's own fields. A message sent mid-turn is a queue send, never here.
  payload                 TEXT NOT NULL DEFAULT '{{}}',
  expected_run_version    INTEGER NOT NULL,           -- the fail-closed comparand
  client_idempotency_key  TEXT NOT NULL,              -- the requester's own key
  -- The admitting connection's device; NULL when the daemon itself wrote the row.
  device_id               TEXT,
  -- Why a request was rejected, so a retry's saved reply carries the same reason.
  rejection_reason        TEXT,
  -- The fallback a degraded intervention took; NULL in every other state.
  fallback_action         TEXT,
  -- What a failed dispatch threw, or why it never completed or was never sent, so a retry's saved
  -- reply carries the same reason.
  failure_reason          TEXT,
  -- What a person's interrupt chose for the run's waiting messages when the release of its queue
  -- hold failed to settle them, and the message it put first; NULL once settled, so the queue's
  -- next hold of the session, or the daemon's next start, settles it again.
  unreleased_choice       TEXT CHECK(unreleased_choice IN ({pending_choices})),
  unreleased_deliver_first TEXT,
  created_at              TEXT NOT NULL,
  resolved_at             TEXT,
  CHECK(unreleased_choice IS NOT NULL OR unreleased_deliver_first IS NULL),
  -- An identical retry returns the saved result; a reused key with a different payload is
  -- refused.
  UNIQUE (target_run_id, client_idempotency_key)
) STRICT;

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
-- The releases left unsettled, which every hold of a session's queue reads.
CREATE INDEX idx_interventions_unreleased ON interventions(target_run_id)
  WHERE unreleased_choice IS NOT NULL;
CREATE INDEX idx_interventions_state ON interventions(state)
  WHERE state IN ({unresolved_intervention_states});

-- ---------------------------------------------------------------------------
-- Run state: one row per run, the read every run write guards against.
-- ---------------------------------------------------------------------------
-- run_version counts every progression of the run, a state change or an applied intervention.
CREATE TABLE runs (
  run_id         TEXT NOT NULL PRIMARY KEY,
  session_id     TEXT NOT NULL,
  parent_run_id  TEXT,                          -- NULL on a lead run
  -- How a child run was reached; NULL on a lead run.
  reached_by     TEXT CHECK(reached_by IS NULL OR reached_by IN ({reached_by})),
  -- 1 on a run whose turn runs in a process of its own; such a run is never the lead run.
  is_apart       INTEGER NOT NULL DEFAULT 0 CHECK(is_apart IN (0, 1)),
  state          TEXT NOT NULL CHECK(state IN ({run_states})),
  run_version    INTEGER NOT NULL CHECK(run_version >= 0)
) STRICT;

CREATE INDEX idx_runs_session ON runs(session_id);
CREATE INDEX idx_runs_parent ON runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
-- The runs not yet ended, which a restart settles; the session id lets the writer's count of live
-- runs read only the index.
CREATE INDEX idx_runs_live ON runs(state, session_id) WHERE state NOT IN ({terminal_states});
"
    )
}
