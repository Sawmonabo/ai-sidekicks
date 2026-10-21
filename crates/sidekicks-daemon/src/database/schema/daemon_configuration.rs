//! The service's machine-wide configuration and its two retention bounds: one row, which the
//! configuration store writes whole the first time it opens and then changes one value at a time.

use sidekicks_contracts::daemon::config::{
    RUN_TIME_LIMIT_MINUTES, WORKFLOW_CHAIN_ASK_AFTER_RUNS_STEPS,
};
use sidekicks_contracts::daemon::retention::DEFAULT_KEEP_DIAGNOSTIC_LOGS_DAYS;

/// The configuration's table. A `NULL` is a setting's own unbounded state: `No limit`,
/// `Never ask`, `Unlimited` or no cap.
pub(super) fn daemon_configuration_schema_sql() -> String {
    let run_time_limits = integer_list(RUN_TIME_LIMIT_MINUTES);
    let chain_steps = integer_list(WORKFLOW_CHAIN_ASK_AFTER_RUNS_STEPS);
    format!(
        "
-- ---------------------------------------------------------------------------
-- The service's configuration: one row, written whole the first time the
-- configuration store opens; each update changes one value.
-- ---------------------------------------------------------------------------
CREATE TABLE daemon_configuration (
  singleton                      INTEGER PRIMARY KEY CHECK (singleton = 1),
  keep_diagnostic_logs_days      INTEGER NOT NULL DEFAULT {DEFAULT_KEEP_DIAGNOSTIC_LOGS_DAYS}
                                 CHECK (keep_diagnostic_logs_days >= 1),
  keep_sessions_days             INTEGER NOT NULL DEFAULT 90 CHECK (keep_sessions_days >= 1),
  -- Written at the daemon's one default listener port, never a free port picked then.
  workflow_listener_port         INTEGER NOT NULL
                                 CHECK (workflow_listener_port BETWEEN 1 AND 65535),
  run_time_limit_minutes         INTEGER CHECK (run_time_limit_minutes IN ({run_time_limits})),
  workflow_chain_ask_after_runs  INTEGER DEFAULT 100
                                 CHECK (workflow_chain_ask_after_runs IN ({chain_steps})),
  max_steps_per_turn             INTEGER CHECK (max_steps_per_turn >= 1),
  spend_limit_usd_micros         INTEGER CHECK (spend_limit_usd_micros >= 0),
  tokens_per_run                 INTEGER CHECK (tokens_per_run >= 1),
  tool_memory_cap_bytes          INTEGER CHECK (tool_memory_cap_bytes >= 1),
  package_cache_limit_bytes      INTEGER CHECK (package_cache_limit_bytes >= 1),
  record_traces                  INTEGER NOT NULL DEFAULT 0 CHECK (record_traces IN (0, 1)),
  record_provider_messages       INTEGER NOT NULL DEFAULT 0
                                 CHECK (record_provider_messages IN (0, 1))
) STRICT;
"
    )
}

fn integer_list(steps: &[u16]) -> String {
    steps
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}
