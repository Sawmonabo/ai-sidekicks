use std::borrow::Cow;

use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::attention_changes_after_commits;
use crate::attention::projection::BUMP_ALWAYS_SQL;
use crate::attention::schema::schema_parts;

// A write in session A raises A's count and the machine's, and leaves B's alone, so a session's
// subscriber wakes only for its own session. Killed by raising only the machine's count and by
// raising every followed session's.
#[tokio::test]
async fn a_write_in_one_session_raises_its_count_and_the_machines_only() {
    let database = TestDatabase::new(schema_parts());
    let (after_commit, changes) = attention_changes_after_commits();
    let writer = DatabaseWriter::open(
        database.opener(),
        DatabaseWriterOptions {
            after_commits: vec![after_commit],
            ..DatabaseWriterOptions::default()
        },
    )
    .await
    .expect("the writer opens its database");
    let session_a = test_session_id();
    let session_b = test_session_id();
    let machine_count = changes.follow(None);
    let a_count = changes.follow(Some(session_a));
    let b_count = changes.follow(Some(session_b));

    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(BUMP_ALWAYS_SQL.as_str()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@session_id",
                &session_a.to_string(),
            )]),
            expected_row_count: None,
        }])
        .await
        .expect("the bump commits");

    assert!(
        machine_count.has_changed().expect("the count is open"),
        "the machine's count moves"
    );
    assert!(
        a_count.has_changed().expect("the count is open"),
        "the written session's count moves"
    );
    assert!(
        !b_count.has_changed().expect("the count is open"),
        "another session's count stays"
    );
}
