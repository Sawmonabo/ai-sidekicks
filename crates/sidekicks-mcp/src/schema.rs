//! The MCP part of the daemon's schema: the command receipts, the two-phase record that keeps a
//! side-effecting tool call from running twice across a restart, and the handle a task-augmented
//! call is resumed by.

use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::sql_list_of_every;

use crate::client::tasks::McpTaskGeneration;
use crate::client::tasks::recorder::MCP_TASK_ID_MAX_LENGTH;
use crate::command_receipts::{CommandAcceptance, CommandOutcome};

/// The provider drivers' list and the command receipts' own part.
pub fn schema_parts() -> SchemaParts {
    sidekicks_provider::driver::schema::schema_parts().with_part(SchemaPart::new(
        "command_receipts",
        command_receipts_schema_sql(),
    ))
}

// The command receipts' table and indexes.
fn command_receipts_schema_sql() -> String {
    let receipt_statuses = format!(
        "{}, {}",
        sql_list_of_every::<CommandAcceptance>(),
        sql_list_of_every::<CommandOutcome>()
    );
    let task_generations = sql_list_of_every::<McpTaskGeneration>();
    format!(
        "
-- ---------------------------------------------------------------------------
-- Command receipts.
-- ---------------------------------------------------------------------------
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
"
    )
}
