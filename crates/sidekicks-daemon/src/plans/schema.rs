//! The plan table of the daemon's one schema, run after the artifact tables, since a plan names the
//! artifact that keeps its text.
//!
//! A plan's row is a projection of the `plan.*` events, written in each event's own write and
//! rebuilt from the log. The artifact is never changed; the plan's state word lives here, and the
//! artifact list reads it.

use sidekicks_contracts::plan::PlanState;

use crate::database::schema::{SchemaPart, SchemaParts};
use crate::database::sql_list::sql_list_of_every;

/// The artifacts' list and the plan table's own part.
pub(crate) fn schema_parts() -> SchemaParts {
    crate::artifacts::schema::schema_parts().with_part(SchemaPart::new("plans", plan_schema_sql()))
}

fn plan_schema_sql() -> String {
    let states = sql_list_of_every::<PlanState>();
    let waiting = <&'static str>::from(PlanState::Waiting);
    let handed_off = <&'static str>::from(PlanState::HandedOff);
    format!(
        "
-- One row per plan, rebuilt from plan.proposed, plan.accepted, plan.handedOff, plan.kept and
-- plan.hold.ended.
CREATE TABLE plans (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,             -- the planning session
  run_id            TEXT NOT NULL,
  artifact_id       TEXT NOT NULL REFERENCES artifact_manifests(id),
  title             TEXT NOT NULL,             -- the plan's first heading
  -- Whether a held provider request waits on the verdict.
  holds_request     INTEGER NOT NULL CHECK(holds_request IN (0, 1)),
  state             TEXT NOT NULL DEFAULT '{waiting}' CHECK(state IN ({states})),
  fresh_session_id  TEXT,                      -- set exactly when the plan was handed off
  -- The device whose verdict landed; NULL while it waits and after a lost hold reopened it.
  resolved_by       TEXT,
  resolved_at       TEXT,
  created_at        TEXT NOT NULL,
  CHECK((state = '{handed_off}') = (fresh_session_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_plans_session ON plans(session_id);
CREATE INDEX idx_plans_fresh_session ON plans(fresh_session_id) WHERE fresh_session_id IS NOT NULL;
-- A run's end reads the plans it still holds.
CREATE INDEX idx_plans_waiting_run ON plans(run_id) WHERE state = '{waiting}';
"
    )
}
