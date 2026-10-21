//! The runs' part of the daemon's schema. `runs` is a projection written in the same write as each
//! run event that moves it, so it always equals a rebuild from the log. The admission queue, the
//! interventions and the command receipts are truth their own writes keep: what waits to be
//! delivered, the saved answer a retried request returns, and the two-phase record that keeps a
//! command from running twice across a restart.

use sidekicks_contracts::run::intervention::{InterventionState, InterventionType};
use sidekicks_contracts::run::queue::{QueueItemNotDeliveredReason, QueueItemState};
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;

use crate::command_receipts::{CommandAcceptance, CommandOutcome};
use crate::database::sql_list::{sql_list_of, sql_list_of_every};
use crate::mcp::task_handle_recorder::MCP_TASK_ID_MAX_LENGTH;
use crate::mcp::tool_calls::McpTaskGeneration;
use crate::session::run::transitions::RUN_TERMINAL_STATES_SQL;

/// The runs' tables and indexes.
pub(super) fn runs_schema_sql() -> String {
    let queue_states = sql_list_of_every::<QueueItemState>();
    let queued = <&'static str>::from(QueueItemState::Queued);
    let not_delivered = <&'static str>::from(QueueItemState::NotDelivered);
    let not_delivered_reasons = sql_list_of_every::<QueueItemNotDeliveredReason>();
    let intervention_types = sql_list_of_every::<InterventionType>();
    let intervention_states = sql_list_of_every::<InterventionState>();
    let requested = <&'static str>::from(InterventionState::Requested);
    let unresolved_intervention_states = sql_list_of(
        [InterventionState::Requested, InterventionState::Accepted].map(<&'static str>::from),
    );
    let receipt_statuses = format!(
        "{}, {}",
        sql_list_of_every::<CommandAcceptance>(),
        sql_list_of_every::<CommandOutcome>()
    );
    let task_generations = sql_list_of_every::<McpTaskGeneration>();
    let reached_by = sql_list_of_every::<ChildRunProvenance>();
    let run_states = sql_list_of_every::<RunState>();
    let terminal_states = &*RUN_TERMINAL_STATES_SQL;
    format!(
        "
-- ---------------------------------------------------------------------------
-- The admission queue, interventions and command receipts.
-- ---------------------------------------------------------------------------
-- A queued item's body, a person's send or an orchestration-authored prompt, rides payload as
-- plain text. Every column the drain selects on is its own column.
CREATE TABLE queue_items (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT '{queued}' CHECK(state IN ({queue_states})),
  -- Why a not-delivered item was not delivered: it waited past the daemon's delivery timeout, or
  -- its delivery failed outright.
  not_delivered_reason   TEXT CHECK(not_delivered_reason IN ({not_delivered_reasons})),
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
  -- The key of the `Send now` that handed the item ahead of what its provider held, and the id its
  -- answer carries, so a retried `Send now` answers what the first did; NULL on every other item.
  send_now_key           TEXT,
  send_now_id            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK((state = '{not_delivered}') = (not_delivered_reason IS NOT NULL)),
  CHECK((send_now_key IS NULL) = (send_now_id IS NULL)),
  -- SQLite treats each NULL as distinct, so only sends dedupe.
  UNIQUE (session_id, client_idempotency_key),
  UNIQUE (session_id, send_now_key)
) STRICT;

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_target_run ON queue_items(target_run_id)
  WHERE target_run_id IS NOT NULL;

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
  created_at              TEXT NOT NULL,
  resolved_at             TEXT,
  -- An identical retry returns the saved result; a reused key with a different payload is
  -- refused.
  UNIQUE (target_run_id, client_idempotency_key)
) STRICT;

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state)
  WHERE state IN ({unresolved_intervention_states});

CREATE TABLE command_receipts (
  id                   TEXT PRIMARY KEY,
  command_id           TEXT NOT NULL UNIQUE,      -- the client-supplied idempotency key
  run_id               TEXT,
  status               TEXT NOT NULL CHECK(status IN ({receipt_statuses})),
  -- The two-phase commit: started_at is set once by the claim's compare-and-set, completed_at by
  -- the terminal write. Claimed and not completed is in flight.
  started_at           TEXT,
  completed_at         TEXT,
  -- The receiver-generated task id from a task-augmented call's acceptance, the one handle the
  -- call is resumed by after a restart. NULL until the acceptance is stored, so a crash before it
  -- leaves the call halted, never run again. Untrusted peer output, bounded in code points.
  mcp_task_id          TEXT
                       CHECK(mcp_task_id IS NULL OR (length(mcp_task_id) > 0
                         AND length(mcp_task_id) <= {MCP_TASK_ID_MAX_LENGTH}
                         AND instr(mcp_task_id, char(0)) = 0)),
  -- The task's protocol generation, set exactly when mcp_task_id is and in the same statement,
  -- since a task is resumed by its generation.
  mcp_task_generation  TEXT CHECK(mcp_task_generation IN ({task_generations})),
  -- 1 once a task-augmented call's result has reached the conversation, so a result that arrives
  -- after a restart is delivered once.
  delivered            INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0, 1)),
  created_at           TEXT NOT NULL,
  CHECK((mcp_task_generation IS NULL) = (mcp_task_id IS NULL))
) STRICT;

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;
-- The in-flight receipts the restart's sweep reads.
CREATE INDEX idx_command_receipts_inflight ON command_receipts(run_id)
  WHERE started_at IS NOT NULL AND completed_at IS NULL;

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
-- The runs not yet ended, which a restart settles.
CREATE INDEX idx_runs_live ON runs(state) WHERE state NOT IN ({terminal_states});
"
    )
}
