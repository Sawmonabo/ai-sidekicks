use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::daemon::backup::BackupLastRun;
use sidekicks_contracts::wire::text::FreeFormText;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::{
    BACKUP_STATEMENT_CAPACITY, BackupDeps, BackupManifestFacts, BackupTrigger, Backups,
    MirrorRootsReader,
};
use crate::daemon::backup::mirror::MirrorRoot;
use crate::daemon::machine::settings::file::MachineSettingsFile;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::tests::{TestLog, open_log};
use crate::events::session::purge::checkpoint::WriteAheadLogTruncation;

/// The service's backups over the test's `database` and `log`, its data folder `data_folder`, the
/// mirror keeping what `read_mirror_roots` lists.
pub(crate) fn test_backups(
    database: &TestDatabase,
    log: &TestLog,
    data_folder: PathBuf,
    read_mirror_roots: MirrorRootsReader,
) -> Arc<Backups> {
    Backups::new(BackupDeps {
        writer: Arc::clone(&log.writer),
        event_log: Arc::clone(&log.service),
        reads: Arc::new(DatabaseReadPool::new(
            database.path(),
            BACKUP_STATEMENT_CAPACITY,
        )),
        truncation: Arc::new(WriteAheadLogTruncation::new(Arc::clone(&log.writer))),
        settings: Arc::new(MachineSettingsFile::new(
            data_folder.join("machine-settings.json"),
        )),
        data_folder,
        read_mirror_roots,
        manifest_facts: BackupManifestFacts {
            app_version: serde_json::from_value(json!("0.1.0")).expect("a version reads"),
            service_version: serde_json::from_value(json!("0.1.0")).expect("a version reads"),
            computer_name: FreeFormText::new("Studio".to_owned()).expect("a name"),
        },
    })
}

// Writes an older backup taken at `taken_at` into `folder`.
fn write_older_backup(folder: &Path, taken_at: &str) {
    let backup = folder.join(taken_at);
    fs::create_dir_all(&backup).expect("the backup's folder is made");
    fs::write(backup.join("daemon.db"), b"an older copy").expect("written");
    let manifest = json!({
        "backupId": taken_at,
        "takenAt": taken_at,
        "appVersion": "0.1.0",
        "serviceVersion": "0.1.0",
        "totalBytes": 13,
        "computerName": "Studio",
    });
    fs::write(
        backup.join("manifest.json"),
        serde_json::to_vec(&manifest).expect("a manifest writes"),
    )
    .expect("written");
}

fn backup_folders(folder: &Path) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = fs::read_dir(folder)
        .expect("the backups folder lists")
        .map(|entry| entry.expect("an entry lists").path())
        .filter(|path| path.is_dir() && path.file_name().is_some_and(|name| name != "mirror"))
        .collect();
    folders.sort();
    folders
}

// A run whose mirror fails after the database is copied records why and keeps every backup there
// is, its own unfinished one removed; the next run writes a backup that passes SQLite's check,
// prunes what no day or week keeps, and records its completion as the last run. Killed by pruning
// before the run succeeds and by a failed run's folder left behind.
#[tokio::test]
async fn a_failed_run_prunes_nothing_and_the_next_one_prunes_after_it_succeeds() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = TempDir::new().expect("a scratch folder");
    let data_folder = home.path().join(".ai-sidekicks");
    let backups_folder = data_folder.join("backups");
    // Monday the 5th of October 2020 to Tuesday the 13th.
    for day in 5..=13 {
        write_older_backup(&backups_folder, &format!("2020-10-{day:02}T12:00:00.000Z"));
    }
    let kept_file = home.path().join("agent-memory.md");
    fs::write(&kept_file, b"learned").expect("written");
    let is_mirror_readable = Arc::new(AtomicBool::new(false));
    let readable = Arc::clone(&is_mirror_readable);
    let source = kept_file.clone();
    let read_mirror_roots: MirrorRootsReader = Arc::new(move || {
        let roots = if readable.load(Ordering::SeqCst) {
            Ok(vec![MirrorRoot {
                name: "agent-memory".to_owned(),
                source: source.clone(),
            }])
        } else {
            Err(io::Error::other("the kept files did not list"))
        };
        async move { roots }.boxed()
    });
    let backups = test_backups(&database, &log, data_folder, read_mirror_roots);
    let older = backup_folders(&backups_folder);
    let stop = CancellationToken::new();

    backups
        .run(BackupTrigger::Now, &stop)
        .await
        .expect("the failed run is recorded");

    assert_eq!(backup_folders(&backups_folder), older);
    assert!(matches!(
        backups.read_last_run().await.expect("the last run reads"),
        Some(BackupLastRun::Failed { message, .. })
            if message.as_str().contains("could not be listed")
    ));

    is_mirror_readable.store(true, Ordering::SeqCst);
    backups
        .run(BackupTrigger::Now, &stop)
        .await
        .expect("the run is recorded");

    // The new backup, the seven newest days and the week of the 5th's Monday stay.
    let remaining = backup_folders(&backups_folder);
    let mut expected: Vec<PathBuf> = older
        .iter()
        .filter(|folder| {
            !folder.ends_with("2020-10-06T12:00:00.000Z")
                && !folder.ends_with("2020-10-07T12:00:00.000Z")
        })
        .cloned()
        .collect();
    let written = remaining
        .iter()
        .find(|folder| !older.contains(folder))
        .expect("the run wrote a backup")
        .clone();
    expected.push(written.clone());
    expected.sort();
    assert_eq!(remaining, expected);
    let copy = rusqlite::Connection::open(written.join("daemon.db")).expect("the copy opens");
    let check: String = copy
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("the copy is checked");
    assert_eq!(check, "ok");
    assert_eq!(
        fs::read(backups_folder.join("mirror/agent-memory")).expect("the kept file is mirrored"),
        b"learned"
    );
    assert!(matches!(
        backups.read_last_run().await.expect("the last run reads"),
        Some(BackupLastRun::Completed { .. })
    ));
}
