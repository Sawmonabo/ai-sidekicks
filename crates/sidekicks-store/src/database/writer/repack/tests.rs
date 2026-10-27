//! The repack: a `VACUUM` the store refuses, a repack a run going live cancels, and a cancel that
//! comes after the repack's first check.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use rusqlite::Connection;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use sidekicks_std::scheduler::budget::{BudgetTerm, JobBudget};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::{RepackEnd, RepackJobDeps, read_pages, repack, repack_job};
use crate::database::connection::writer_open::open_database;
use crate::database::schema::schema_parts;
use crate::database::wal_truncation::WriteAheadLogTruncation;
use crate::database::writer::jobs::StoreWorkUnit;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};

const WAIT: Duration = Duration::from_secs(10);

// A budget the tests' repacks are metered against; no test reads what it allows.
const TEST_REPACK_BUDGET: JobBudget<StoreWorkUnit> = JobBudget::new(&[BudgetTerm {
    figure: Duration::from_secs(1),
    per: 256 * 1024 * 1024,
    unit: StoreWorkUnit::StoreBytes,
}]);

// A store holding free pages and live rows, the later half of a filler table deleted, so a `VACUUM`
// copies thousands of instructions' worth of rows.
fn store_with_free_pages() -> TestDatabase {
    let database = TestDatabase::new(schema_parts());
    let connection =
        open_database(&database.path(), &schema_parts().into_schema()).expect("the store opens");
    connection
        .execute_batch(
            "CREATE TABLE filler (id INTEGER PRIMARY KEY, body BLOB);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
             INSERT INTO filler SELECT i, zeroblob(1000) FROM n;
             DELETE FROM filler WHERE id > 1000;",
        )
        .expect("the filler is written and half deleted");
    connection
        .close()
        .map_err(|(_connection, failure)| failure)
        .expect("the store closes");
    database
}

fn freelist_count(database: &TestDatabase) -> i64 {
    database
        .reader()
        .pragma_query_value(None, "freelist_count", |row| row.get(0))
        .expect("the test reads the free pages")
}

fn repack_deps(
    database: &TestDatabase,
    writer: &Arc<DatabaseWriter>,
    live_runs: watch::Receiver<u32>,
) -> Arc<RepackJobDeps> {
    Arc::new(RepackJobDeps {
        writer: Arc::clone(writer),
        truncation: Arc::new(WriteAheadLogTruncation::new(Arc::clone(writer))),
        database_path: database.path(),
        read_volume_free_bytes: |_| Ok(u64::MAX),
        live_runs,
        budget: TEST_REPACK_BUDGET,
    })
}

// A `VACUUM` the store refuses ends the job without failing it and changes nothing, so the next
// purge's repack tries again. Killed by a refused repack failing the job.
#[tokio::test]
async fn a_refused_vacuum_ends_the_job_and_changes_nothing() {
    let database = store_with_free_pages();
    let free_before = freelist_count(&database);
    assert!(free_before > 0);
    let path = database.path();
    let schema = schema_parts().into_schema();
    let writer = Arc::new(
        DatabaseWriter::open(
            move || {
                let connection: Connection = open_database(&path, &schema)?;
                connection
                    .pragma_update(None, "query_only", true)
                    .expect("the test makes the connection refuse writes");
                Ok::<_, sidekicks_std::cleanup_failures::CleanupFailures<_, rusqlite::Error>>(
                    connection,
                )
            },
            DatabaseWriterOptions::default(),
        )
        .await
        .expect("the writer opens"),
    );
    let live_runs = watch::Sender::new(0);

    let mut repack = repack_job(repack_deps(&database, &writer, live_runs.subscribe()));
    tokio::time::timeout(WAIT, repack(CancellationToken::new()))
        .await
        .expect("the job ends")
        .expect("a refused repack does not fail the job");

    assert_eq!(freelist_count(&database), free_before);
}

// A run going live while the repack waits on the writer cancels it, so its `VACUUM` never runs.
// Killed by the live count not followed, which repacks once the writer lets go.
#[tokio::test]
async fn a_run_going_live_cancels_a_waiting_repack() {
    let database = store_with_free_pages();
    let free_before = freelist_count(&database);
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens"),
    );
    let (held, is_held) = oneshot::channel();
    let (release, released) = oneshot::channel::<()>();
    let holder = Arc::clone(&writer);
    let hold = tokio::spawn(async move {
        holder
            .hold_while(|| async move {
                held.send(()).expect("the test waits for the hold");
                released.await.expect("the test lets the hold go");
            })
            .await;
    });
    is_held.await.expect("the writer holds its writes");
    let live_runs = watch::Sender::new(0);
    let mut repack = repack_job(repack_deps(&database, &writer, live_runs.subscribe()));
    let mut running = Box::pin(repack(CancellationToken::new()));
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut running)
            .await
            .is_err(),
        "the repack waits out the hold"
    );

    live_runs.send_replace(1);
    // One poll lets the job see the count and cancel before the writer lets the repack go.
    assert!(futures::poll!(&mut running).is_pending());
    release.send(()).expect("the hold waits");

    tokio::time::timeout(WAIT, running)
        .await
        .expect("the job ends")
        .expect("a canceled repack does not fail the job");
    hold.await.expect("the hold ends");
    assert_eq!(freelist_count(&database), free_before);
}

// The truncation before the `VACUUM`, which runs after the repack's first check.
fn is_truncation(action: &AuthAction<'_>) -> bool {
    matches!(
        action,
        AuthAction::Pragma {
            pragma_name: "wal_checkpoint",
            ..
        }
    )
}

// The `VACUUM`'s attach of its new file, which it makes once it is running.
fn is_vacuum_running(action: &AuthAction<'_>) -> bool {
    matches!(action, AuthAction::Attach { .. })
}

// A cancel that comes after the repack's first check, before its `VACUUM` begins or while it runs,
// stops the `VACUUM`, which rolls back and leaves the file's pages and free pages as they were.
// No queue interrupts this connection, so only the `VACUUM`'s own read of its cancel stops it.
// Killed by the progress handler left out.
#[rstest]
#[case::before_the_vacuum_begins(is_truncation)]
#[case::while_the_vacuum_runs(is_vacuum_running)]
fn a_cancel_after_the_first_check_stops_the_vacuum(
    #[case] is_cancel_point: fn(&AuthAction<'_>) -> bool,
) {
    let database = store_with_free_pages();
    let connection =
        open_database(&database.path(), &schema_parts().into_schema()).expect("the store opens");
    let cancel = CancellationToken::new();
    let canceled = cancel.clone();
    connection
        .authorizer(Some(move |context: AuthContext<'_>| {
            if is_cancel_point(&context.action) {
                canceled.cancel();
            }
            Authorization::Allow
        }))
        .expect("the test watches the statements");
    let before = read_pages(&connection).expect("the pages read");
    assert!(before.freelist_count > 0);

    let ended = repack(&connection, &cancel).expect("the repack ends");

    assert_eq!(ended, RepackEnd::Interrupted);
    assert!(cancel.is_cancelled());
    assert_eq!(read_pages(&connection).expect("the pages read"), before);
}
