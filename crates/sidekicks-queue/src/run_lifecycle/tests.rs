//! The run lifecycle's read of a run's limit trigger, against the log's own indexes.

use sidekicks_contracts::run::id::RunId;

use super::SELECT_INTERRUPT_TRIGGER_SQL;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::tests::open_log;

// The trigger read seeks the session's interrupted events of the run through the run index, with
// no scan of the log and no sort. Killed by dropping the session from the read, which scans the
// index and sorts the rows.
#[tokio::test]
async fn the_trigger_read_searches_the_run_index() {
    let database = TestDatabase::new(schema_parts());
    // The log's schema is made by its writer.
    let _log = open_log(&database, None).await;
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");

    let plan: Vec<String> = database
        .reader()
        .prepare(&format!(
            "EXPLAIN QUERY PLAN {}",
            *SELECT_INTERRUPT_TRIGGER_SQL
        ))
        .expect("the plan reads")
        .query_map(
            [session_id.text().as_str(), run_id.text().as_str()],
            |row| row.get(3),
        )
        .expect("the plan's rows read")
        .collect::<Result<_, _>>()
        .expect("each step reads");

    assert!(
        plan.iter()
            .any(|step| step
                .starts_with("SEARCH session_events USING INDEX idx_session_events_run ")),
        "{plan:?}"
    );
    assert!(
        plan.iter()
            .all(|step| !step.starts_with("SCAN") && !step.contains("TEMP B-TREE")),
        "{plan:?}"
    );
}
