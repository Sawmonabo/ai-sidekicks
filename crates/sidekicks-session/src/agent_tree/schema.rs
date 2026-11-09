//! The agent tree's table of the daemon's one schema: one row per helper a provider named in a
//! session, written in its run event's own write and rebuilt from the log. A node's state is read
//! from its newest own run.

use sidekicks_store::database::schema::{SchemaPart, SchemaParts};

/// The runs' list, whose `runs` a node's own run names, and the agent tree's own part.
pub fn schema_parts() -> SchemaParts {
    crate::run::schema::schema_parts().with_part(SchemaPart::new("agent_tree", AGENT_TREE_SQL))
}

const AGENT_TREE_SQL: &str = "
-- One row per helper a provider named in a session, keyed by the handle the daemon mints for it.
CREATE TABLE agent_tree_nodes (
  child_handle         TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  provider_name        TEXT NOT NULL,
  subagent_id          TEXT NOT NULL,           -- the helper's id in its provider
  parent_subagent_id   TEXT,                    -- its parent's provider id; NULL under the lead
  parent_child_handle  TEXT REFERENCES agent_tree_nodes(child_handle), -- NULL under the lead
  name                 TEXT,                    -- Codex's nickname; NULL on Claude
  role                 TEXT,                    -- Claude's subagent type or Codex's agent role
  provider_path        TEXT,                    -- the helper's path in Codex's tree; NULL on Claude
  ask                  TEXT,                    -- the ask its first start named
  model_id             TEXT,                    -- the model its first start named
  effort               TEXT,                    -- the effort its first start named
  -- The Claude call that started the newest own run, which an automatic resume names again; NULL
  -- on Codex.
  start_call_id        TEXT,
  own_run_id           TEXT NOT NULL,           -- the newest own run; its state
  started_at           TEXT NOT NULL,           -- the first own run's start
  updated_at           TEXT NOT NULL,           -- when its newest own run was bound
  UNIQUE (session_id, provider_name, subagent_id)
) STRICT;

CREATE INDEX idx_agent_tree_nodes_name ON agent_tree_nodes(session_id, name)
  WHERE name IS NOT NULL;
CREATE INDEX idx_agent_tree_nodes_provider_path ON agent_tree_nodes(session_id, provider_path)
  WHERE provider_path IS NOT NULL;
CREATE INDEX idx_agent_tree_nodes_own_run ON agent_tree_nodes(own_run_id);
-- A deleted node's children, which its foreign key looks up on every delete, the clear's included.
CREATE INDEX idx_agent_tree_nodes_parent ON agent_tree_nodes(parent_child_handle);
";
