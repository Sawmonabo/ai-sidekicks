//! The daemon's whole schema: every part its one database file holds, in the order they are
//! created.

use sidekicks_store::database::schema::SchemaParts;

/// The daemon's whole schema: the approvals', the workflows', the plans' and the attention lists,
/// then the shared-ports table.
pub fn schema_parts() -> SchemaParts {
    sidekicks_approval::schema::schema_parts()
        .with_parts(sidekicks_workflow::schema::schema_parts())
        .with_parts(sidekicks_artifact::plans::schema::schema_parts())
        .with_parts(sidekicks_session::attention::schema::schema_parts())
        .with_part(crate::remote::shared_ports::schema::schema_part())
}

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
