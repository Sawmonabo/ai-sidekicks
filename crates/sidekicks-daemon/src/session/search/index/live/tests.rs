use std::fmt::Debug;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rstest::rstest;
use rusqlite::Connection;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_search::index::{SearchIndex, SearchQuery};
use tokio::sync::{Notify, watch};
use tokio::time::{Instant, timeout, timeout_at};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

use super::test_services::TestDaemonServices;
use super::{LiveIndexShared, LiveIndexState, OpenIndex, catch_up, delete_applied, follow_commits};
use crate::database::connection::writer_open::SEARCH_INDEX_FOLDER_NAME;
use crate::database::writer::test_file::TestDatabase;
use crate::session::directory::test_rows::insert_session_row;
use crate::session::search::index::applier::SearchIndexApplier;
use crate::session::search::index::outbox::{AppliedOutbox, OutboxReader, delete_applied_outbox};
use crate::session::search::index::rebuild::{
    SearchIndexOpening, make_index_at, open_search_index,
};
use crate::session::search::index::schema::add_titled_session;
use crate::session::search::rowid_floors::RowidFloorLog;
use crate::transcript::test_log::TranscriptTestLog;

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
// applied, then deleted once the index has them. The last rows reported for deletion are the
// newest applied, with the applier's floor, which a delete past one session moved, kept.
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
    assert_eq!(open.applier.floor_position() > 0, session_count > 1);
    assert_eq!(
        *deletes.borrow(),
        Some(AppliedOutbox {
            last_outbox_id: highest_id_given,
            kept_floor_position: open.applier.floor_position(),
        })
    );
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

// Counts, and wakes `wake` at, each event the test's thread logs whose message is `message`.
struct MessageWaker {
    message: &'static str,
    wake: Arc<Notify>,
    count: Arc<AtomicUsize>,
}

impl MessageWaker {
    // A waker for `message`, with its wake and its count.
    fn new(message: &'static str) -> (Self, Arc<Notify>, Arc<AtomicUsize>) {
        let wake = Arc::new(Notify::new());
        let count = Arc::new(AtomicUsize::new(0));
        let waker = Self {
            message,
            wake: Arc::clone(&wake),
            count: Arc::clone(&count),
        };
        (waker, wake, count)
    }
}

struct LogMessage(Option<String>);

impl Visit for LogMessage {
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        if field.name() == "message" {
            self.0 = Some(format!("{value:?}"));
        }
    }
}

impl<S: Subscriber> Layer<S> for MessageWaker {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let mut message = LogMessage(None);
        event.record(&mut message);
        if message.0.as_deref() == Some(self.message) {
            self.count.fetch_add(1, Ordering::SeqCst);
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

// Renames the outbox away, so every read of it fails, or back.
fn move_outbox(connection: &Connection, away: bool) {
    let (from, to) = if away {
        ("session_search_outbox", "outbox_away")
    } else {
        ("outbox_away", "session_search_outbox")
    };
    connection
        .execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}"))
        .expect("the outbox is renamed");
}

// An apply after the open whose outbox read fails leaves the index at its last durable commit,
// which a search goes on answering from, and the following goes on. While the failure stands a
// commit starts no apply: the retry alone applies, after 1 s, then 2 s, logging the failure once
// and the recovery once. On a paused clock, which moves only while nothing runs, the blocking pool
// included. Killed by a failed apply that ends the following or fails the index, by a commit that
// applies during the wait, by a wait that does not double and by a warning per attempt.
#[tokio::test(start_paused = true)]
async fn a_failed_apply_keeps_the_last_commit_served_and_is_tried_again_after_its_wait() {
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
    let (failures, failed, failure_count) = MessageWaker::new("search_index_apply_failed");
    let (recoveries, _, recovery_count) = MessageWaker::new("search_index_apply_recovered");
    let _logs = tracing::subscriber::set_default(
        tracing_subscriber::registry()
            .with(failures)
            .with(recoveries),
    );
    let connection = database.opener()().expect("the test opens its database");
    let (commit, mut commits) = watch::channel(0_u64);
    let bounded = Duration::from_secs(5);

    let following = follow_commits(&shared, &open, &mut commits, &deletes, &index_commits);
    let driving = async {
        add_titled_session(&connection, "session-2");
        commit.send_replace(1);
        timeout(bounded, applied.changed())
            .await
            .expect("the commit applies")
            .expect("the following reports its commits");
        let served_id = open.index.last_applied_outbox_id();
        assert_eq!(sessions_found(&open.index), 1);

        let waiting_id = add_titled_session(&connection, "session-3");
        move_outbox(&connection, true);
        commit.send_replace(2);
        timeout(bounded, failed.notified())
            .await
            .expect("the apply fails");
        let failed_at = Instant::now();
        assert_eq!(open.index.last_applied_outbox_id(), served_id);
        assert_eq!(sessions_found(&open.index), 1);

        // Three commits inside the first wait start no apply; the retry at 1 s fails again.
        for count in 3..=5 {
            commit.send_replace(count);
            tokio::task::yield_now().await;
        }
        tokio::time::sleep_until(failed_at + Duration::from_millis(1500)).await;
        move_outbox(&connection, false);
        commit.send_replace(6);
        assert!(
            timeout_at(failed_at + Duration::from_millis(2900), applied.changed())
                .await
                .is_err(),
            "nothing applies before the doubled wait runs out"
        );
        timeout(bounded, applied.changed())
            .await
            .expect("the retry applies")
            .expect("the following reports its commits");
        assert!(Instant::now() >= failed_at + Duration::from_secs(3));
        assert_eq!(open.index.last_applied_outbox_id(), waiting_id);
        assert_eq!(sessions_found(&open.index), 2);
        assert_eq!(failure_count.load(Ordering::SeqCst), 1);
        assert_eq!(recovery_count.load(Ordering::SeqCst), 1);
        assert!(!matches!(*shared.state.borrow(), LiveIndexState::Failed(_)));
        shared.stop.cancel();
    };
    tokio::join!(following, driving);
    open.index.close().expect("the index closes");
}

// How a test damages a stored reply's row.
#[derive(Clone, Copy)]
enum ReplyDamage {
    // Its payload names an encoding no build writes.
    Encoding,
    // Its payload states its length as text.
    Length,
    // Its stored body fails a frame's checksum.
    Frame,
}

// A reply damaged in its payload's encoding or length, or in its stored body's second frame, is no
// index row: the apply passes over it and applies the reply after it, so the damaged reply's words
// find nothing and the next reply's do. Killed by a damaged row that fails the apply as a refused
// read does, whether the row's read or its body's fails, and by a length of another type read as a
// refused read.
#[rstest]
#[case::encoding(ReplyDamage::Encoding)]
#[case::length(ReplyDamage::Length)]
#[case::frame(ReplyDamage::Frame)]
#[tokio::test]
async fn an_apply_passes_over_a_damaged_row_and_applies_the_rows_after_it(
    #[case] damage: ReplyDamage,
) {
    let log = TranscriptTestLog::new();
    let services = TestDaemonServices::open(&log.database).await;
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let (_, open, _) = index_behind_its_database(&log.database, &services, folder.path(), 1).await;
    insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
    let session_rowid: i64 = log
        .writer
        .query_row(
            "SELECT rowid FROM sessions WHERE id = ?1",
            [log.session_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the session's key reads");
    let session_key = u64::try_from(session_rowid).expect("a rowid is positive");
    let damaged_reply = format!("zebra {}", "words ".repeat(2 * PAGE_MAX_BYTES / 6));
    let (damaged, _) = log.reply("m1", None, &damaged_reply);
    match damage {
        ReplyDamage::Encoding => log.set_payload_text(damaged, "$.contentEncoding", "zstdx"),
        ReplyDamage::Length => log.set_payload_text(damaged, "$.contentLength", "many"),
        ReplyDamage::Frame => log.damage_frame(damaged, 1),
    }
    log.reply("m2", None, "quokka");

    open.applier
        .apply_waiting(|_| {})
        .await
        .expect("the apply passes over the damaged reply");

    let rows_found = |word: &str| {
        let query = SearchQuery {
            words: vec![word.to_owned()],
            last_word_is_prefix: false,
        };
        open.index
            .find_in_session(session_key, &query)
            .expect("the find reads")
            .row_keys
            .len()
    };
    assert_eq!(rows_found("zebra"), 0);
    assert_eq!(rows_found("quokka"), 1);
    open.index.close().expect("the index closes");
}
