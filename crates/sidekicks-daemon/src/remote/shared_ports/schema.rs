//! The shared-ports table, the last part of the daemon's schema, and the daemon's whole list of
//! parts: the ports this machine shares with the person's other devices, kept across restarts.

use sidekicks_store::database::schema::{SchemaPart, SchemaParts};

/// The daemon's whole schema: the approvals', the workflows' and the plans' lists, then the
/// shared-ports table.
pub fn schema_parts() -> SchemaParts {
    sidekicks_approval::schema::schema_parts()
        .with_parts(sidekicks_workflow::schema::schema_parts())
        .with_parts(sidekicks_artifact::plans::schema::schema_parts())
        .with_part(SchemaPart::new("shared_ports", SHARED_PORTS_SCHEMA_SQL))
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use sidekicks_store::database::connection::writer_open::open_database;

    use super::schema_parts;

    /// The daemon's whole schema opens with every foreign key naming a table it holds and nothing
    /// dangling. Mutation: misspell a `REFERENCES` target.
    #[test]
    fn the_whole_schema_opens_with_every_reference_resolved() {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let connection = open_database(
            &folder.path().join("daemon.db"),
            &schema_parts().into_schema(),
        )
        .expect("the fresh file opens");

        let tables: BTreeSet<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .expect("the table list prepares")
            .query_map([], |row| row.get(0))
            .expect("the table list reads")
            .collect::<rusqlite::Result<_>>()
            .expect("each table name reads");
        let referenced: BTreeSet<String> = tables
            .iter()
            .flat_map(|table| {
                connection
                    .prepare("SELECT \"table\" FROM pragma_foreign_key_list(?)")
                    .expect("the foreign key list prepares")
                    .query_map([table], |row| row.get::<_, String>(0))
                    .expect("the foreign key list reads")
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .expect("each foreign key reads")
            })
            .collect();
        assert!(!referenced.is_empty(), "the schema declares foreign keys");
        assert!(
            referenced.is_subset(&tables),
            "unresolved: {:?}",
            referenced.difference(&tables).collect::<Vec<_>>()
        );
        let dangling: i64 = connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("the foreign key check runs");
        assert_eq!(dangling, 0);
    }
}
