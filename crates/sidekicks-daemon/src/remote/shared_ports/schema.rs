//! The shared-ports table of the daemon's one schema: the ports this machine shares with the
//! person's other devices, kept across restarts.

/// The SQL of the shared-ports table, run as part of the daemon schema's script.
pub(crate) const SHARED_PORTS_SCHEMA_SQL: &str = "
-- ---------------------------------------------------------------------------
-- shared_ports: the ports this machine forwards to its own loopback for the person's other
-- devices; a row stays until its port stops being shared.
-- ---------------------------------------------------------------------------
CREATE TABLE shared_ports (
  port      INTEGER PRIMARY KEY CHECK(port BETWEEN 1 AND 65535),
  -- When it was shared, strictly later than every row before it, so this order is the order added.
  added_at  TEXT NOT NULL
) STRICT;
";
