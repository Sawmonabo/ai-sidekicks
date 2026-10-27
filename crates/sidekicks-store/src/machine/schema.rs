//! This machine's part of the daemon's schema: its own record and its registration, truth minted at
//! the daemon's first start and kept the same at every later start.

/// This machine's tables.
pub(crate) const MACHINE_SCHEMA_SQL: &str = "
-- ---------------------------------------------------------------------------
-- This machine: its id and its owner's user id, both minted at the daemon's
-- first start, and the friendly name read then. One row.
-- ---------------------------------------------------------------------------
CREATE TABLE local_machine (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  machine_id     TEXT NOT NULL,
  -- A hosted account signed in to later attaches to it.
  owner_user_id  TEXT NOT NULL,
  name           TEXT NOT NULL,
  minted_at      TEXT NOT NULL                  -- RFC 3339 UTC, ms precision
) STRICT;

-- This machine's registration: one row per machine and owning user.
CREATE TABLE machine_trust_state (
  machine_id      TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  established_at  TEXT NOT NULL,                -- first registration; a re-registration keeps it
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (machine_id, owner_user_id)
) STRICT;
";
