//! The budget table of the daemon's one schema: one row per session holding its two limits.
//!
//! The row is the daemon's own truth, written when a limit is set and read back as written; it is
//! no projection of the event log, so a rebuild leaves it alone.

use sidekicks_store::database::schema::{SchemaPart, SchemaParts};

/// The runs' list and the budget table's own part.
pub fn schema_parts() -> SchemaParts {
    crate::run::schema::schema_parts().with_part(SchemaPart::new("session_budgets", BUDGET_SQL))
}

const BUDGET_SQL: &str = "
-- One row per session whose limits were set; a session with no row runs on the daemon's own.
CREATE TABLE session_budgets (
  session_id              TEXT PRIMARY KEY,
  spend_limit_usd_micros  INTEGER,  -- whole micro-dollars across every provider; NULL unlimited
  tokens_per_run          INTEGER,  -- input and output tokens together for one run; NULL unlimited
  updated_at              TEXT NOT NULL,
  CHECK(spend_limit_usd_micros IS NULL OR spend_limit_usd_micros >= 0),
  CHECK(tokens_per_run IS NULL OR tokens_per_run >= 1)
) STRICT;
";
