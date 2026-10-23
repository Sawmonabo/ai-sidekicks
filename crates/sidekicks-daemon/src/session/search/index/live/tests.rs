use std::fmt::Debug;
use std::path::Path;
use std::sync::Arc;

use rstest::rstest;
use sidekicks_search::index::{SearchIndex, SearchQuery};
use tokio::sync::{Notify, watch};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

use super::test_services::TestDaemonServices;
use super::{LiveIndexShared, LiveIndexState, OpenIndex, catch_up, delete_applied, follow_commits};
use crate::database::connection::writer_open::SEARCH_INDEX_FOLDER_NAME;
use crate::database::writer::test_file::TestDatabase;
use crate::session::search::index::applier::SearchIndexApplier;
use crate::session::search::index::outbox::{AppliedOutbox, OutboxReader, delete_applied_outbox};
use crate::session::search::index::rebuild::{
    SearchIndexOpening, make_index_at, open_search_index,
};
use crate::session::search::index::schema::add_titled_session;
use crate::session::search::rowid_floors::RowidFloorLog;

// A database of `session_count` titled sessions, beside an index whose newest commit records the
// first session's outbox rows, opened as a start opens it; and the outbox's highest id. Past one
// session the last is deleted, so the floor log holds an entry.
async fn index_behind_its_database(
    database: &TestDatabase,
    services: &TestDaemonServices,
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
    let index_folder = folder.join(SEARCH_INDEX_FOLDER_NAME);
    make_index_at(&index_folder, committed_id);
    let SearchIndexOpening::Opened(index) = open_search_index(index_folder, highest_id_given)
        .await
        .expect("the index opens")
    else {
        panic!("an index at an id the outbox gave serves");
    };
    let reads = Arc::clone(&services.reads);
    let shared = LiveIndexShared::new(Arc::clone(&reads), Arc::clone(&services.scheduler));
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
    let services = TestDaemonServices::open(&database).await;
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (shared, open, highest_id_given) =
        index_behind_its_database(&database, &services, folder.path(), 3).await;
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
    let services = TestDaemonServices::open(&database).await;
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (shared, open, _) = index_behind_its_database(&database, &services, folder.path(), 3).await;
    // A first page that read the applier's floor before the catch-up and is still being read.
    let in_flight = shared.enter_search(&open);
    let (deletes, _applied) = watch::channel(None);

    catch_up(&shared, &open, &deletes, &Notify::new())
        .await
        .expect("the index catches up");
    let applied = (*deletes.borrow()).expect("the catch-up reports its newest commit");
    delete_applied_outbox(&services.writer, applied)
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
    let services = TestDaemonServices::open(&database).await;
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (shared, open, highest_id_given) =
        index_behind_its_database(&database, &services, folder.path(), session_count).await;
    let (deletes, applied) = watch::channel(None);
    let deleting = tokio::spawn(delete_applied(Arc::clone(&services.writer), applied));

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

// Wakes `wake` each time the test's thread logs an event whose message is `message`.
struct LogWake {
    message: &'static str,
    wake: Arc<Notify>,
}

struct LogMessage(Option<String>);

impl Visit for LogMessage {
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        if field.name() == "message" {
            self.0 = Some(format!("{value:?}"));
        }
    }
}

impl<S: Subscriber> Layer<S> for LogWake {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let mut message = LogMessage(None);
        event.record(&mut message);
        if message.0.as_deref() == Some(self.message) {
            self.wake.notify_one();
        }
    }
}

// How many sessions a search for the titles' word ranks in `index` as it is now.
fn sessions_found(index: &SearchIndex) -> usize {
    let query = SearchQuery {
        words: vec!["billing".to_owned()],
        last_word_is_prefix: false,
    };
    index
        .open_search(Vec::new(), 16, Some(&query))
        .expect("the search opens")
        .sessions_at(0, 16)
        .expect("the sessions rank")
        .len()
}

// An apply after the open whose outbox read fails leaves the index at its last durable commit,
// which a search goes on answering from, and the following goes on: once the read can run again,
// the next commit of the writer applies what waited. Killed by a failed apply that ends the
// following, and by one that fails the index.
#[tokio::test]
async fn a_failed_apply_keeps_the_last_commit_served_and_applies_at_the_next_commit() {
    let database = TestDatabase::new();
    let services = TestDaemonServices::open(&database).await;
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (shared, open, _) = index_behind_its_database(&database, &services, folder.path(), 1).await;
    let (deletes, mut applied) = watch::channel(None);
    let index_commits = Notify::new();
    catch_up(&shared, &open, &deletes, &index_commits)
        .await
        .expect("the index catches up");
    applied.borrow_and_update();
    let failed = Arc::new(Notify::new());
    let _logs = tracing::subscriber::set_default(tracing_subscriber::registry().with(LogWake {
        message: "search_index_apply_failed",
        wake: Arc::clone(&failed),
    }));
    let connection = database.opener()().expect("the test opens its database");
    let (commit, mut commits) = watch::channel(0_u64);

    let following = follow_commits(&shared, &open, &mut commits, &deletes, &index_commits);
    let driving = async {
        add_titled_session(&connection, "session-2");
        commit.send_replace(1);
        applied
            .changed()
            .await
            .expect("the following reports its commits");
        let served_id = open.index.last_applied_outbox_id();
        assert_eq!(sessions_found(&open.index), 1);

        let waiting_id = add_titled_session(&connection, "session-3");
        connection
            .execute_batch("ALTER TABLE session_search_outbox RENAME TO outbox_away")
            .expect("the outbox is renamed");
        commit.send_replace(2);
        failed.notified().await;
        assert_eq!(open.index.last_applied_outbox_id(), served_id);
        assert_eq!(sessions_found(&open.index), 1);

        connection
            .execute_batch("ALTER TABLE outbox_away RENAME TO session_search_outbox")
            .expect("the outbox is named back");
        commit.send_replace(3);
        applied
            .changed()
            .await
            .expect("the following reports its commits");
        assert_eq!(open.index.last_applied_outbox_id(), waiting_id);
        assert_eq!(sessions_found(&open.index), 2);
        assert!(!matches!(*shared.state.borrow(), LiveIndexState::Failed(_)));
        shared.stop.cancel();
    };
    tokio::join!(following, driving);
    open.index.close().expect("the index closes");
}
