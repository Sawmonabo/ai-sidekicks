use std::path::Path;
use std::sync::Arc;

use rstest::rstest;
use sidekicks_platforms::WallClockTimer;
use sidekicks_search::index::SearchIndex;
use tokio::sync::{Notify, watch};

use super::{LiveIndexShared, OpenIndex, catch_up, delete_applied};
use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::session::search::index::applier::SearchIndexApplier;
use crate::session::search::index::outbox::{
    AppliedOutbox, OUTBOX_STATEMENT_CAPACITY, OutboxReader, delete_applied_outbox,
};
use crate::session::search::index::rebuild::{
    SearchIndexOpening, make_index_at, open_search_index,
};
use crate::session::search::index::schema::add_titled_session;
use crate::session::search::rowid_floors::RowidFloorLog;

// The daemon's scheduler on the system's wall-clock timer.
fn scheduler() -> Arc<Scheduler> {
    Arc::new(Scheduler::start(
        Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
        None,
    ))
}

// A writer on the test's file.
async fn writer_on(database: &TestDatabase) -> DatabaseWriter {
    DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database")
}

// A database of `session_count` titled sessions, beside an index whose newest commit records the
// first session's outbox rows, opened as a start opens it; and the outbox's highest id. Past one
// session the last is deleted, so the floor log holds an entry.
async fn index_behind_its_database(
    database: &TestDatabase,
    folder: &Path,
    session_count: usize,
) -> (Arc<LiveIndexShared>, OpenIndex, u64) {
    let connection = database.opener()().expect("the test creates its database");
    let committed_id = add_titled_session(&connection, "session-1");
    for number in 2..=session_count {
        add_titled_session(&connection, &format!("session-{number}"));
    }
    if session_count > 1 {
        connection
            .execute(
                "DELETE FROM sessions WHERE id = ?",
                [format!("session-{session_count}")],
            )
            .expect("the session is deleted");
    }
    let highest_id_given = OutboxReader::new(&connection)
        .highest_id_given()
        .expect("the outbox's highest id reads");
    let index_folder = folder.join("search-index");
    make_index_at(&index_folder, committed_id);
    let SearchIndexOpening::Opened(index) = open_search_index(index_folder, highest_id_given)
        .await
        .expect("the index opens")
    else {
        panic!("an index at an id the outbox gave serves");
    };
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        OUTBOX_STATEMENT_CAPACITY,
    ));
    let shared = LiveIndexShared::new(Arc::clone(&reads), scheduler());
    let index: Arc<SearchIndex> = Arc::from(index);
    let open = OpenIndex {
        applier: Arc::new(SearchIndexApplier::new(Arc::clone(&index), reads)),
        index,
    };
    (shared, open, highest_id_given)
}

#[tokio::test]
async fn the_start_reports_the_newest_commit_before_it_applies_what_waits() {
    let database = TestDatabase::new();
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (shared, open, highest_id_given) =
        index_behind_its_database(&database, folder.path(), 3).await;
    let (deletes, _applied) = watch::channel(None);

    catch_up(&shared, &open, &deletes, &Notify::new())
        .await
        .expect("the index catches up");

    assert!(
        open.applier.floor_position() > 0,
        "the delete logged a floor the applier reads"
    );
    assert_eq!(
        *deletes.borrow(),
        Some(AppliedOutbox {
            last_outbox_id: highest_id_given,
            kept_floor_position: open.applier.floor_position(),
        }),
        "the last rows reported are the newest applied, with the applier's floor kept"
    );
    open.index.close().expect("the index closes");
}

#[tokio::test]
async fn a_delete_during_a_first_page_s_read_keeps_the_floor_it_reads_from() {
    let database = TestDatabase::new();
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (shared, open, _) = index_behind_its_database(&database, folder.path(), 3).await;
    let writer = writer_on(&database).await;
    // A first page that read the applier's floor before the catch-up and is still being read.
    let in_flight = shared.enter_search(&open);
    let (deletes, _applied) = watch::channel(None);

    catch_up(&shared, &open, &deletes, &Notify::new())
        .await
        .expect("the index catches up");
    let applied = (*deletes.borrow()).expect("the catch-up reports its newest commit");
    delete_applied_outbox(&writer, applied)
        .await
        .expect("the applied rows are deleted");

    assert!(
        open.applier.floor_position() > in_flight.position(),
        "the applier moved past the page's floor"
    );
    assert!(
        RowidFloorLog::new(&database.reader())
            .held_row_check(in_flight.position())
            .expect("the floor log reads")
            .is_some(),
        "the floor log keeps the entry the page in flight reads"
    );
    drop(in_flight);
    open.index.close().expect("the index closes");
}

// A restart finds the outbox rows of its index's newest commit still there, the run before it cut
// off before its delete, and maybe rows its index never applied: the first are deleted, the others
// applied, then deleted once the index has them.
#[rstest]
#[case::nothing_waits(1)]
#[case::rows_wait(3)]
#[tokio::test]
async fn a_restart_deletes_what_its_index_holds_and_applies_what_it_does_not(
    #[case] session_count: usize,
) {
    let database = TestDatabase::new();
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (shared, open, highest_id_given) =
        index_behind_its_database(&database, folder.path(), session_count).await;
    let writer = Arc::new(writer_on(&database).await);
    let (deletes, applied) = watch::channel(None);
    let deleting = tokio::spawn(delete_applied(Arc::clone(&writer), applied));

    catch_up(&shared, &open, &deletes, &Notify::new())
        .await
        .expect("the index catches up");
    drop(deletes);
    deleting.await.expect("the deletes end");

    let outbox_rows: i64 = database
        .reader()
        .query_row("SELECT count(*) FROM session_search_outbox", [], |row| {
            row.get(0)
        })
        .expect("the outbox counts");
    assert_eq!(outbox_rows, 0, "every row the index holds is deleted");
    assert_eq!(open.index.last_applied_outbox_id(), highest_id_given);
    open.index.close().expect("the index closes");
}
