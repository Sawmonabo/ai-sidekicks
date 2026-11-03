//! The agents' part of the daemon's schema: one row per agent in a session, at the binding it runs
//! on now, with the switch it has pending.

use sidekicks_store::database::schema::{SchemaPart, SchemaParts};

/// The runs' list and the agents' own part.
pub fn schema_parts() -> SchemaParts {
    crate::run::schema::schema_parts().with_part(SchemaPart::new("agents", AGENTS_SCHEMA_SQL))
}

const AGENTS_SCHEMA_SQL: &str = "
-- One row per agent in a session, rebuilt from session.created, agent.run.queued and
-- agent.providerBinding.changed; pending_switch is the daemon's own, which a rebuild keeps.
CREATE TABLE agents (
  id                          TEXT PRIMARY KEY,
  session_id                  TEXT NOT NULL,
  name                        TEXT NOT NULL,
  provider_name               TEXT NOT NULL,
  model_id                    TEXT NOT NULL,
  -- The account the binding pins, never the one a switch landed on; NULL follows the provider's
  -- current account.
  provider_account_id         TEXT,
  effort                      TEXT,  -- the reasoning effort; NULL for the driver's default
  options                     TEXT,  -- the session options set, a JSON list of {id, value}
  output_speed                TEXT,  -- the output speed picked; NULL for the provider's default
  larger_window               INTEGER, -- the larger window in tokens; NULL for the model's default
  instructions                TEXT,  -- the instructions as applied, from its saved definition
  resolved_from_definition_id TEXT,  -- the saved definition it was resolved from, never a key
  -- NULL, or the JSON of the switch accepted and not applied, with its device and its interrupt's
  -- dispatch.
  pending_switch              TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_agents_session ON agents(session_id);
";
