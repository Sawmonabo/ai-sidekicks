//! The shared-ports table, the last part of the daemon's schema: the ports this machine shares
//! with the person's other devices, kept across restarts.

use sidekicks_store::database::schema::SchemaPart;

/// The shared-ports table's part of the daemon's schema.
pub(crate) fn schema_part() -> SchemaPart {
    SchemaPart::new("shared_ports", SHARED_PORTS_SCHEMA_SQL)
}

// The shared-ports table.
const SHARED_PORTS_SCHEMA_SQL: &str = "
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
