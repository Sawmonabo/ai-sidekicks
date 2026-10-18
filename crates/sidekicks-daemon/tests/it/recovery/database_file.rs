//! The database file's copies aside and its repair, each run through the daemon's own program in
//! its `database copy` and `database shell` modes.

use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sidekicks_daemon::recovery::database_file::aside_copy::{
    AsideCopyError, DatabaseFilesAside, copy_database_files_aside,
};
use sidekicks_daemon::recovery::database_file::check::{
    DatabaseFileCheck, DatabaseFileCheckAnswer,
};
use sidekicks_daemon::recovery::database_file::copy::{DatabaseCopyError, DatabaseFileCopier};
use sidekicks_daemon::recovery::database_file::sqlite_shell::SqliteShell;
use sidekicks_platforms::{Spawner, physical_memory};
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

// The daemon's own program, whose modes the copies and the shells run in.
fn daemon_program() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sidekicks-daemon"))
}

fn spawner() -> Spawner {
    Spawner::new(Handle::current()).expect("the spawner thread starts")
}

// The folders the store's files are copied into, each a copy.
fn aside_copies(data_folder: &Path) -> Vec<PathBuf> {
    match fs::read_dir(data_folder.join("damaged")) {
        Ok(entries) => entries
            .map(|entry| entry.expect("an entry reads").path())
            .collect(),
        Err(error) => {
            assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{error}");
            Vec::new()
        }
    }
}

fn row_count(database: &Path, table: &str) -> i64 {
    Connection::open(database)
        .expect("the database opens")
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("the rows count")
}

#[tokio::test]
async fn a_second_start_meeting_the_same_files_finds_the_first_copy() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let database_path = data_folder.path().join("daemon.db");
    let writer = Connection::open(&database_path).expect("the database opens");
    writer
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE session_events (sequence INTEGER PRIMARY KEY, payload TEXT);
             INSERT INTO session_events VALUES (1, 'first');",
        )
        .expect("the database is written");
    let copier = DatabaseFileCopier::new(daemon_program(), spawner());
    let stop = CancellationToken::new();
    let aside = |now| DatabaseFilesAside {
        database_path: &database_path,
        data_folder: data_folder.path(),
        copier: &copier,
        now,
    };

    let first = copy_database_files_aside(&aside(jiff::Timestamp::UNIX_EPOCH), &stop)
        .await
        .expect("the files are copied aside");
    let second = copy_database_files_aside(&aside(jiff::Timestamp::now()), &stop)
        .await
        .expect("the copy is found");

    assert_eq!(first, second);
    assert_eq!(aside_copies(data_folder.path()), vec![first.clone()]);
    assert_eq!(row_count(&first.join("daemon.db"), "session_events"), 1);
    drop(writer);
}

// The last connection's close folds the log into the file and removes it while the copy runs;
// whichever comes first, the copy holds every commit.
#[tokio::test]
async fn a_log_folded_while_the_files_are_copied_keeps_every_commit() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let database_path = data_folder.path().join("daemon.db");
    let writer = Connection::open(&database_path).expect("the database opens");
    writer
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE session_events (sequence INTEGER PRIMARY KEY, payload TEXT);
             WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter
               WHERE n < 500)
             INSERT INTO session_events SELECT n, printf('%.100c', 'x') FROM counter;",
        )
        .expect("the commits are written");
    let copier = DatabaseFileCopier::new(daemon_program(), spawner());
    let stop = CancellationToken::new();
    let aside = DatabaseFilesAside {
        database_path: &database_path,
        data_folder: data_folder.path(),
        copier: &copier,
        now: jiff::Timestamp::now(),
    };

    let closing = tokio::task::spawn_blocking(move || writer.close().map_err(|(_, error)| error));
    let (copied, closed) = tokio::join!(copy_database_files_aside(&aside, &stop), closing);

    closed
        .expect("the close's task ends")
        .expect("the last connection closes");
    let folder = copied.expect("the files are copied aside");
    assert_eq!(row_count(&folder.join("daemon.db"), "session_events"), 500);
}

#[tokio::test]
async fn a_stop_leaves_no_copy() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let database_path = data_folder.path().join("daemon.db");
    Connection::open(&database_path)
        .expect("the database opens")
        .execute_batch("CREATE TABLE session_events (sequence INTEGER PRIMARY KEY);")
        .expect("the database is written");
    let copier = DatabaseFileCopier::new(daemon_program(), spawner());
    let stop = CancellationToken::new();
    stop.cancel();

    let copied = copy_database_files_aside(
        &DatabaseFilesAside {
            database_path: &database_path,
            data_folder: data_folder.path(),
            copier: &copier,
            now: jiff::Timestamp::now(),
        },
        &stop,
    )
    .await;

    assert!(
        matches!(
            copied,
            Err(AsideCopyError::Copy {
                source: DatabaseCopyError::Stopped,
                ..
            })
        ),
        "{copied:?}"
    );
    assert_eq!(aside_copies(data_folder.path()), Vec::<PathBuf>::new());
}

// A text value `.recover` writes raw, which a text-mode read on Windows would take as the input's
// end, and a line break it escapes.
const RAW_VALUE: &str = "before\u{1a}after\r\nnext line";

// How many session events the fixture writes, and how many of the marks that point at them.
const WRITTEN_EVENTS: i64 = 2_000;

// The fixture's database: session events, each with a mark pointing at it under a foreign key,
// then one page in the middle of the events overwritten, so the events on it are lost while every
// mark survives, which only a writer with foreign keys off can keep.
fn write_damaged_database(database_path: &Path) {
    let writer = Connection::open(database_path).expect("the database opens");
    writer
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE session_events (sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL);",
        )
        .expect("the events' table is made");
    writer
        .execute("INSERT INTO session_events VALUES (1, ?1)", [RAW_VALUE])
        .expect("the raw value is written");
    writer
        .execute_batch(&format!(
            "WITH RECURSIVE counter(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM counter
               WHERE n < {WRITTEN_EVENTS})
             INSERT INTO session_events SELECT n, printf('%.200c', 'x') FROM counter;"
        ))
        .expect("the events are written");
    let events_end: i64 = writer
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .expect("the page count reads");
    writer
        .execute_batch(
            "CREATE TABLE event_marks (
               id INTEGER PRIMARY KEY,
               sequence INTEGER NOT NULL REFERENCES session_events (sequence)
             );
             INSERT INTO event_marks SELECT sequence, sequence FROM session_events;",
        )
        .expect("the marks are written");
    let page_size: i64 = writer
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("the page size reads");
    writer
        .close()
        .map_err(|(_, error)| error)
        .expect("the database closes");
    // The events' pages follow the schema's first page; one in their middle is overwritten.
    let damaged_page = events_end / 2;
    let mut file = OpenOptions::new()
        .write(true)
        .open(database_path)
        .expect("the file opens to be damaged");
    file.seek(SeekFrom::Start(
        u64::try_from((damaged_page - 1) * page_size).expect("the offset is positive"),
    ))
    .expect("the page is found");
    file.write_all(&vec![
        0xA5;
        usize::try_from(page_size).expect("a page size fits")
    ])
    .expect("the page is overwritten");
    file.sync_all().expect("the damage is on disk");
}

#[tokio::test]
async fn a_damaged_file_is_found_and_recovered_through_the_shell_mode() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let damaged_path = data_folder.path().join("daemon.db");
    let fresh_path = data_folder.path().join("daemon.db.fresh");
    write_damaged_database(&damaged_path);
    let shell = SqliteShell::new(daemon_program(), spawner());
    let (recovered_events, recovered) = watch::channel(0);
    let stop = CancellationToken::new();

    let found = DatabaseFileCheck::start(damaged_path.clone())
        .answer()
        .await
        .expect("the check runs");
    shell
        .recover_into_fresh_file(
            &damaged_path,
            &fresh_path,
            physical_memory(),
            &recovered_events,
            &stop,
        )
        .await
        .expect("the file is recovered");

    assert!(
        matches!(found, DatabaseFileCheckAnswer::Damaged(_)),
        "{found:?}"
    );
    let fresh = Connection::open(&fresh_path).expect("the fresh file opens");
    let events: i64 = fresh
        .query_row("SELECT count(*) FROM session_events", [], |row| row.get(0))
        .expect("the events count");
    let marks: i64 = fresh
        .query_row("SELECT count(*) FROM event_marks", [], |row| row.get(0))
        .expect("the marks count");
    let raw_value: String = fresh
        .query_row(
            "SELECT payload FROM session_events WHERE sequence = 1",
            [],
            |row| row.get(0),
        )
        .expect("the raw value reads");
    assert_eq!(u64::try_from(events).ok(), Some(*recovered.borrow()));
    assert!(events > 0 && events < WRITTEN_EVENTS, "{events}");
    assert_eq!(marks, WRITTEN_EVENTS);
    assert_eq!(raw_value.as_bytes(), RAW_VALUE.as_bytes());
}
