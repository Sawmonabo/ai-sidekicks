//! The database file's copies aside, its repair and the readying of its fresh file, each run
//! through the daemon's own program in its `database copy` and `database shell` modes, and the
//! service's start on a file its repair cannot heal.

use std::error::Error as _;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rstest::rstest;
use rusqlite::Connection;
use rusqlite::config::DbConfig;
use sidekicks_contracts::daemon::service_status::{DaemonCannotStart, ServiceStatusFile};
use sidekicks_daemon::daemon::schema::schema_parts;
use sidekicks_platforms::{create_missing_private_folders, physical_memory};
use sidekicks_recovery::database_file::aside_copy::{
    AsideCopyError, DatabaseFilesAside, copy_database_files_aside,
};
use sidekicks_recovery::database_file::check::{DatabaseFileCheck, DatabaseFileCheckAnswer};
use sidekicks_recovery::database_file::copy::{DatabaseCopyError, DatabaseFileCopier};
use sidekicks_recovery::database_file::fresh::{
    FreshFileError, FreshFilePreparation, prepare_fresh_file,
};
use sidekicks_recovery::database_file::repair::{
    DatabaseFileRepair, DatabaseFileRepairError, DatabaseFileRepairOptions, LeftoverFile,
    repair_damaged_file,
};
use sidekicks_recovery::database_file::sqlite_shell::SqliteShell;
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, SEARCH_INDEX_FOLDER_NAME,
};
use sidekicks_store::database::damage::record_database_damage;
use sidekicks_store::database::schema::DatabaseSchema;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::helpers::{daemon_program, run_service, short_home, spawner};

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
             CREATE TABLE filler (sequence INTEGER PRIMARY KEY, payload TEXT);
             INSERT INTO filler VALUES (1, 'first');",
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
    assert_eq!(row_count(&first.join("daemon.db"), "filler"), 1);
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
             CREATE TABLE filler (sequence INTEGER PRIMARY KEY, payload TEXT);
             WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter
               WHERE n < 500)
             INSERT INTO filler SELECT n, printf('%.100c', 'x') FROM counter;",
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
    assert_eq!(row_count(&folder.join("daemon.db"), "filler"), 500);
}

#[tokio::test]
async fn a_stop_leaves_no_copy() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let database_path = data_folder.path().join("daemon.db");
    Connection::open(&database_path)
        .expect("the database opens")
        .execute_batch("CREATE TABLE filler (sequence INTEGER PRIMARY KEY);")
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
// mark survives, which only a writer with foreign keys off can keep. The events' table keeps its
// real name, since the repair counts the rows it recovers into that table.
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
    Box::pin(shell.recover_into_fresh_file(
        &damaged_path,
        &fresh_path,
        physical_memory(),
        &recovered_events,
        &stop,
    ))
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

// A database file with `schema` and its fingerprint, as the daemon creates one.
fn schema_file(path: &Path, schema: &DatabaseSchema) -> Connection {
    let connection = Connection::open(path).expect("the database opens");
    connection
        .execute_batch(schema.sql())
        .expect("the schema is made");
    connection
        .pragma_update(None, "user_version", schema.fingerprint())
        .expect("the fingerprint is written");
    connection
}

// Writes `count` events of `session_id` from sequence 0, each in run `run-1` at its own run version
// and turn, each a piece of the row the first one starts, under one join key, filed under `run-2`
// too, naming a tool call and placed as a stored patch part, so a copy shows every column the
// append stamps.
fn write_events(connection: &Connection, session_id: &str, count: i64) {
    for sequence in 0..count {
        connection
            .execute(
                "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
                   category, type, payload, run_id, run_version, turn_number, join_key,
                   joins_sequence, target_run_id, tool_call_id, patch_file_index,
                   patch_text_offset)
                 VALUES (?1, ?2, ?3, '2026-10-19T09:00:00.000Z', ?3, 'session', 'session.pinned',
                   '{}', 'run-1', ?3, ?3, 'key-1', NULLIF(0, ?3), 'run-2', 'call-1', ?3, ?3)",
                (format!("{session_id}-{sequence}"), session_id, sequence),
            )
            .expect("the event is written");
    }
}

// Each event's sequence, run columns, three join columns, tool call and patch part place.
type StoredStamps = (
    i64,
    String,
    i64,
    i64,
    String,
    Option<i64>,
    String,
    String,
    i64,
    i64,
);

fn session_events(connection: &Connection, session_id: &str) -> Vec<StoredStamps> {
    let mut statement = connection
        .prepare(
            "SELECT sequence, run_id, run_version, turn_number, join_key, joins_sequence,
                    target_run_id, tool_call_id, patch_file_index, patch_text_offset
               FROM session_events WHERE session_id = ? ORDER BY sequence",
        )
        .expect("the read prepares");
    statement
        .query_map([session_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })
        .expect("the events read")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("every event reads")
}

// The newest backup's copy beside the fresh file: this build's, another build's, or no database.
#[derive(Clone, Copy, Debug)]
enum BackupCopy {
    ThisBuild,
    AnotherBuild,
    Unreadable,
}

// A session the backup holds more readable events of takes its events with their run and join
// columns, its snapshots and its recovery checkpoints from it, and one the fresh file holds more of
// keeps its own; a backup another build made, or one that does not read, is passed over and heals
// nothing.
#[rstest]
#[case::of_this_build(BackupCopy::ThisBuild, 1)]
#[case::of_another_build(BackupCopy::AnotherBuild, 0)]
#[case::unreadable(BackupCopy::Unreadable, 0)]
#[tokio::test]
async fn sessions_the_newest_backup_holds_more_of_come_from_it(
    #[case] backup: BackupCopy,
    #[case] sessions_from_backup: u64,
) {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let schema = schema_parts().into_schema();
    let fresh_path = data_folder.path().join("daemon.db.recovered");
    let backup_copy_path = data_folder.path().join("daemon.db.backup-read");
    let fresh = schema_file(&fresh_path, &schema);
    write_events(&fresh, "richer-in-backup", 1);
    write_events(&fresh, "richer-in-fresh", 2);
    drop(fresh);
    if let BackupCopy::Unreadable = backup {
        fs::write(&backup_copy_path, b"no database").expect("the copy is written");
    } else {
        let copy = schema_file(&backup_copy_path, &schema);
        write_events(&copy, "richer-in-backup", 3);
        write_events(&copy, "richer-in-fresh", 1);
        copy.execute_batch(
            "INSERT INTO session_snapshots (id, session_id, as_of_sequence, state_blob, created_at)
               VALUES ('snapshot-1', 'richer-in-backup', 2, x'01', '2026-10-19T09:00:00.000Z');
             INSERT INTO recovery_checkpoints
               (id, session_id, checkpoint_type, as_of_sequence, state_blob, created_at)
               VALUES ('checkpoint-1', 'richer-in-backup', 'full', 2, x'01',
                       '2026-10-19T09:00:00.000Z');",
        )
        .expect("the snapshot and the checkpoint are written");
        if let BackupCopy::AnotherBuild = backup {
            copy.pragma_update(None, "user_version", schema.fingerprint() ^ 1)
                .expect("another build's fingerprint is written");
        }
    }
    let shell = SqliteShell::new(daemon_program(), spawner());

    let taken = prepare_fresh_file(
        &FreshFilePreparation {
            shell: &shell,
            fresh_path: &fresh_path,
            schema: &schema,
            backup_copy_path: Some(&backup_copy_path),
        },
        &CancellationToken::new(),
    )
    .await
    .expect("the fresh file is readied");

    assert_eq!(taken, sessions_from_backup);
    let fresh = Connection::open(&fresh_path).expect("the fresh file opens");
    let backup_events = if sessions_from_backup == 1 { 3 } else { 1 };
    assert_eq!(
        session_events(&fresh, "richer-in-backup"),
        (0..backup_events)
            .map(|sequence| (
                sequence,
                "run-1".to_owned(),
                sequence,
                sequence,
                "key-1".to_owned(),
                (sequence > 0).then_some(0),
                "run-2".to_owned(),
                "call-1".to_owned(),
                sequence,
                sequence,
            ))
            .collect::<Vec<_>>()
    );
    assert_eq!(session_events(&fresh, "richer-in-fresh").len(), 2);
    assert_eq!(
        row_count(&fresh_path, "session_snapshots"),
        i64::from(sessions_from_backup == 1)
    );
    assert_eq!(
        row_count(&fresh_path, "recovery_checkpoints"),
        i64::from(sessions_from_backup == 1)
    );
}

// The fresh file's readying drops the recovery's tables of lost rows, marks every session with
// events for a rebuild, a session whose cursor the recovery lost included, and writes this build's
// fingerprint over the one the recovery carried, so the next open takes the file.
#[tokio::test]
async fn a_readied_fresh_file_rebuilds_every_session_and_carries_the_fingerprint() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let schema = schema_parts().into_schema();
    let fresh_path = data_folder.path().join("daemon.db.recovered");
    let fresh = schema_file(&fresh_path, &schema);
    fresh
        .pragma_update(None, "user_version", 0)
        .expect("a damaged header's fingerprint is lost");
    write_events(&fresh, "with-cursor", 1);
    write_events(&fresh, "without-cursor", 1);
    fresh
        .execute_batch(
            "INSERT INTO projection_cursors (id, session_id, last_sequence, state, updated_at)
               VALUES ('cursor-1', 'with-cursor', 0, 'current', '2026-10-19T09:00:00.000Z');
             CREATE TABLE lost_and_found (rootpgno INTEGER, pgno INTEGER, nfield INTEGER,
                                          id INTEGER, c0);
             INSERT INTO lost_and_found VALUES (7, 7, 1, 1, 'a lost row');",
        )
        .expect("the recovery's rows are written");
    drop(fresh);
    let shell = SqliteShell::new(daemon_program(), spawner());

    let taken = prepare_fresh_file(
        &FreshFilePreparation {
            shell: &shell,
            fresh_path: &fresh_path,
            schema: &schema,
            backup_copy_path: None,
        },
        &CancellationToken::new(),
    )
    .await
    .expect("the fresh file is readied");

    assert_eq!(taken, 0);
    let fresh = Connection::open(&fresh_path).expect("the fresh file opens");
    let lost_tables: i64 = fresh
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name = 'lost_and_found'",
            [],
            |row| row.get(0),
        )
        .expect("the schema reads");
    assert_eq!(lost_tables, 0);
    let mut cursors = fresh
        .prepare("SELECT session_id, last_sequence, state FROM projection_cursors ORDER BY 1")
        .expect("the read prepares");
    let cursors = cursors
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("the cursors read")
        .collect::<rusqlite::Result<Vec<(String, i64, String)>>>()
        .expect("every cursor reads");
    assert_eq!(
        cursors,
        vec![
            ("with-cursor".to_owned(), 0, "stale".to_owned()),
            ("without-cursor".to_owned(), -1, "stale".to_owned()),
        ]
    );
    let fingerprint: i32 = fresh
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("the fingerprint reads");
    assert_eq!(fingerprint, schema.fingerprint());
}

// What breaks a fresh file: an object of the schema it lacks, one the schema does not hold, or an
// index whose entries do not match its rows.
#[derive(Clone, Copy, Debug)]
enum FreshFileFault {
    MissingIndex,
    ExtraTable,
    SwappedIndexes,
}

// A fresh file that is not this build's or not sound is refused, naming why.
#[rstest]
#[case::lacking_an_index(FreshFileFault::MissingIndex)]
#[case::holding_another_table(FreshFileFault::ExtraTable)]
#[case::failing_its_integrity_check(FreshFileFault::SwappedIndexes)]
#[tokio::test]
async fn a_fresh_file_not_of_this_build_or_not_sound_is_refused(#[case] fault: FreshFileFault) {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let schema = schema_parts().into_schema();
    let fresh_path = data_folder.path().join("daemon.db.recovered");
    let fresh = schema_file(&fresh_path, &schema);
    match fault {
        FreshFileFault::MissingIndex => fresh
            .execute_batch("DROP INDEX idx_session_events_type")
            .expect("the index is dropped"),
        FreshFileFault::ExtraTable => fresh
            .execute_batch("CREATE TABLE stray (id INTEGER)")
            .expect("the table is made"),
        FreshFileFault::SwappedIndexes => {
            write_events(&fresh, "session-1", 50);
            // An index of the same shape with no entries takes the event index's name, and the
            // index holding the entries is dropped, so the event index matches no row.
            fresh
                .execute_batch("CREATE INDEX spare ON session_events(session_id, type) WHERE 0")
                .expect("the spare index is made");
            fresh
                .set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, false)
                .expect("the test may write the schema");
            // Both pages are read before either is written, so the swap never reads a page it
            // already moved and the two indexes never share one.
            let root_page = |name: &str| -> i64 {
                fresh
                    .query_row(
                        "SELECT rootpage FROM sqlite_schema WHERE name = ?1",
                        [name],
                        |row| row.get(0),
                    )
                    .expect("the index's page reads")
            };
            let event_index_page = root_page("idx_session_events_type");
            let spare_page = root_page("spare");
            fresh
                .pragma_update(None, "writable_schema", true)
                .expect("the schema is writable");
            for (name, page) in [
                ("idx_session_events_type", spare_page),
                ("spare", event_index_page),
            ] {
                fresh
                    .execute(
                        "UPDATE sqlite_schema SET rootpage = ?2 WHERE name = ?1",
                        (name, page),
                    )
                    .expect("the index's page is swapped");
            }
            fresh
                .pragma_update(None, "writable_schema", false)
                .expect("the schema is read-only again");
        }
    }
    drop(fresh);
    if let FreshFileFault::SwappedIndexes = fault {
        // A connection opened after the swap reads the schema as it now stands.
        Connection::open(&fresh_path)
            .expect("the fresh file opens again")
            .execute_batch("DROP INDEX spare")
            .expect("the entries' index is dropped");
    }
    let shell = SqliteShell::new(daemon_program(), spawner());

    let refused = prepare_fresh_file(
        &FreshFilePreparation {
            shell: &shell,
            fresh_path: &fresh_path,
            schema: &schema,
            backup_copy_path: None,
        },
        &CancellationToken::new(),
    )
    .await;

    match (fault, refused) {
        (FreshFileFault::MissingIndex, Err(FreshFileError::SchemaDiffers { missing, extra })) => {
            assert_eq!(missing, vec!["index idx_session_events_type".to_owned()]);
            assert_eq!(extra, Vec::<String>::new());
        }
        (FreshFileFault::ExtraTable, Err(FreshFileError::SchemaDiffers { missing, extra })) => {
            assert_eq!(missing, Vec::<String>::new());
            assert_eq!(extra, vec!["table stray".to_owned()]);
        }
        (FreshFileFault::SwappedIndexes, Err(FreshFileError::Integrity(_))) => {}
        (fault, refused) => panic!("{fault:?} was answered {refused:?}"),
    }
}

// A stop before the damaged file is copied aside ends the repair at once: the damaged file stays
// as it was, and no copy aside, fresh file or marker is left.
#[tokio::test]
async fn a_stop_before_the_aside_copy_leaves_the_damaged_file_as_it_was() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let schema = schema_parts().into_schema();
    let database_path = data_folder.path().join("daemon.db");
    write_damaged_database(&database_path);
    let damaged_bytes = fs::read(&database_path).expect("the damaged file reads");
    let shell = SqliteShell::new(daemon_program(), spawner());
    let copier = DatabaseFileCopier::new(daemon_program(), spawner());
    let (progress, _progress_reader) = watch::channel(None);
    let stop = CancellationToken::new();
    stop.cancel();

    let repaired = Box::pin(repair_damaged_file(
        &DatabaseFileRepairOptions {
            database_path: &database_path,
            data_folder: data_folder.path(),
            index_folder_path: &data_folder.path().join(SEARCH_INDEX_FOLDER_NAME),
            shell: &shell,
            copier: &copier,
            schema: &schema,
            now: jiff::Timestamp::now(),
        },
        "page 7 is damaged",
        &data_folder.path().join("backups"),
        &progress,
        &stop,
    ))
    .await
    .expect("the repair ends");

    assert!(
        matches!(repaired, DatabaseFileRepair::Stopped { ref leftovers } if leftovers.is_empty()),
        "{repaired:?}"
    );
    assert_eq!(
        fs::read(&database_path).expect("the damaged file reads"),
        damaged_bytes
    );
    assert_eq!(aside_copies(data_folder.path()), Vec::<PathBuf>::new());
    for left in ["daemon.db.recovered", "daemon.db.recovered-ready"] {
        assert!(!data_folder.path().join(left).exists(), "{left} is left");
    }
}

// What an earlier repair left where the newest backup's copy goes: the copy, or a folder no
// removal of a file takes.
#[derive(Clone, Copy, Debug)]
enum EarlierBackupCopy {
    File,
    Folder,
}

// A repair a stop or a crash cut short may leave the newest backup's copy beside the database
// file; the next repair removes it before any work, and one it cannot remove ends the repair
// before the work, naming the file that stayed.
#[rstest]
#[case::a_copy(EarlierBackupCopy::File)]
#[case::a_folder(EarlierBackupCopy::Folder)]
#[tokio::test]
async fn a_backup_copy_an_earlier_repair_left_is_removed_before_any_work(
    #[case] earlier: EarlierBackupCopy,
) {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let schema = schema_parts().into_schema();
    let database_path = data_folder.path().join("daemon.db");
    write_damaged_database(&database_path);
    let backup_copy_path = data_folder.path().join("daemon.db.backup-read");
    match earlier {
        EarlierBackupCopy::File => {
            fs::write(&backup_copy_path, b"an earlier repair's copy").expect("the copy is left");
        }
        EarlierBackupCopy::Folder => {
            fs::create_dir(&backup_copy_path).expect("the folder is left");
        }
    }
    let shell = SqliteShell::new(daemon_program(), spawner());
    let copier = DatabaseFileCopier::new(daemon_program(), spawner());
    let (progress, _progress_reader) = watch::channel(None);

    let repaired = Box::pin(repair_damaged_file(
        &DatabaseFileRepairOptions {
            database_path: &database_path,
            data_folder: data_folder.path(),
            index_folder_path: &data_folder.path().join(SEARCH_INDEX_FOLDER_NAME),
            shell: &shell,
            copier: &copier,
            schema: &schema,
            now: jiff::Timestamp::now(),
        },
        "page 7 is damaged",
        &data_folder.path().join("backups"),
        &progress,
        &CancellationToken::new(),
    ))
    .await;

    match (earlier, repaired) {
        (EarlierBackupCopy::File, Ok(_)) => {
            assert!(!backup_copy_path.exists(), "the earlier copy is left");
        }
        (EarlierBackupCopy::Folder, Err(DatabaseFileRepairError::Leftover(leftovers))) => {
            let first = leftovers
                .source()
                .and_then(|first| first.downcast_ref::<LeftoverFile>())
                .expect("the first file that stayed is named");
            assert_eq!(first.path, backup_copy_path);
        }
        (earlier, repaired) => panic!("{earlier:?} was answered {repaired:?}"),
    }
}

// A start on a damaged file its repair cannot heal, here a table this build does not have, which
// the recovery carries into the fresh file, fails naming the damaged file's copy aside, writes the
// status file a client reads that from, and leaves the file byte for byte as it was. Killed by the
// start going on past a file its repair left damaged.
#[tokio::test]
async fn a_start_on_a_file_its_repair_cannot_heal_fails_naming_the_copy_aside() {
    let home = short_home();
    let data_folder = data_folder(home.path());
    create_missing_private_folders(&data_folder).expect("the data folder is made");
    let database_path = data_folder.join(DAEMON_DATABASE_FILE_NAME);
    schema_file(&database_path, &schema_parts().into_schema())
        .execute_batch("CREATE TABLE stray (id INTEGER)")
        .expect("the table is made");
    record_database_damage(&database_path, "a page failed the integrity check")
        .await
        .expect("the damage is recorded");
    let before = fs::read(&database_path).expect("the file reads");

    let ended = run_service(home.path()).await;

    let standard_error = String::from_utf8_lossy(&ended.stderr);
    assert_eq!(ended.status.code(), Some(1), "{standard_error}");
    let status: ServiceStatusFile = serde_json::from_slice(
        &fs::read(data_folder.join("run").join("service-status.json"))
            .expect("the status file is written"),
    )
    .expect("the status file reads");
    let DaemonCannotStart::SavedSessionsUnrepaired { aside_folder } = status.cannot_start else {
        panic!("the status file says {:?}", status.cannot_start);
    };
    assert_eq!(
        aside_copies(&data_folder),
        vec![PathBuf::from(aside_folder.as_str())]
    );
    assert!(
        standard_error.contains(aside_folder.as_str()),
        "{standard_error}"
    );
    assert_eq!(
        fs::read(&database_path).expect("the file reads"),
        before,
        "the file is as it was"
    );
}
