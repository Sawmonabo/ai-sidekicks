//! The event log a test of the live-run count opens: its writer counts the live runs after each
//! commit.

use sidekicks_store::database::writer::DatabaseWriterOptions;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log_with};
use tokio::sync::watch;

use super::count_live_runs_after_commits;

/// The event log on a fresh database, its writer counting the live runs after each commit, and
/// that count.
pub async fn counted_log(database: &TestDatabase) -> (TestLog, watch::Receiver<u32>) {
    let (after_commit, live_runs) = count_live_runs_after_commits();
    let options = DatabaseWriterOptions {
        after_commits: vec![after_commit],
        ..DatabaseWriterOptions::default()
    };
    (open_log_with(database, options).await, live_runs)
}
