use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::daemon::backup::BackupLastRun;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{WallClockTimer, check_private_run_folder};
use tempfile::TempDir;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{
    BACKUP_STATEMENT_CAPACITY, BackupDeps, BackupManifestFacts, BackupTrigger, Backups,
    MirrorRootsReader,
};
use crate::daemon::machine::settings::file::{MachineSettingsFile, machine_settings_file_path};
use crate::remote::shared_ports::schema::schema_parts;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::backup_mirror::MirrorRoot;
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::wal_truncation::WriteAheadLogTruncation;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::tests::{TestLog, open_log};

/// The service's backups over the test's `database` and `log`, under the home folder
/// `home_folder`, the mirror keeping what `read_mirror_roots` lists.
pub(crate) fn test_backups(
    database: &TestDatabase,
    log: &TestLog,
    home_folder: PathBuf,
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
        settings: Arc::new(MachineSettingsFile::new(machine_settings_file_path(
            &home_folder,
        ))),
        home_folder,
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
// mirrors a place found under the home folder, prunes what no day or week keeps and a folder a
// cut-short run left, never a folder of the person's own, and records its completion as the last
// run; the backup's folder and the mirror's are owner-only, though the backups folder was made
// with the default mode. Killed by pruning before the run succeeds, by a failed run's folder left
// behind, by a manifest-less folder kept, by a folder pruned whatever its name, and by the
// backup's folder or the mirror's made with the default mode.
#[tokio::test]
async fn a_failed_run_prunes_nothing_and_the_next_one_prunes_after_it_succeeds() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = TempDir::new().expect("a scratch folder");
    let backups_folder = data_folder(home.path()).join("backups");
    // Monday the 5th of October 2020 to Tuesday the 13th.
    for day in 5..=13 {
        write_older_backup(&backups_folder, &format!("2020-10-{day:02}T12:00:00.000Z"));
    }
    let kept_file = home.path().join("agent-memory.md");
    fs::write(&kept_file, b"learned").expect("written");
    let is_mirror_readable = Arc::new(AtomicBool::new(false));
    let readable = Arc::clone(&is_mirror_readable);
    let read_mirror_roots: MirrorRootsReader = Arc::new(move |_meter| {
        let roots = if readable.load(Ordering::SeqCst) {
            Ok(vec![
                MirrorRoot::new("agent-memory".to_owned(), Path::new("agent-memory.md"))
                    .expect("a root"),
            ])
        } else {
            Err(io::Error::other("the kept files did not list"))
        };
        async move { roots }.boxed()
    });
    let backups = test_backups(
        &database,
        &log,
        home.path().to_path_buf(),
        read_mirror_roots,
    );
    // A run a crash cut short left a folder named as a run names one, with no manifest; a folder
    // of the person's own beside the backups is no backup.
    let unfinished = backups_folder.join("0192a4b0-7c3e-7d4f-8a5b-6c7d8e9f0a1b");
    fs::create_dir_all(&unfinished).expect("the unfinished folder is made");
    let own_folder = backups_folder.join("photos");
    fs::create_dir_all(&own_folder).expect("the person's folder is made");
    let older = backup_folders(&backups_folder);
    let stop = CancellationToken::new();
    let meter = ProcessorMeter::default();

    backups
        .run(BackupTrigger::Now, &stop, &meter)
        .await
        .expect("the failed run is recorded");

    assert_eq!(backup_folders(&backups_folder), older);
    assert!(unfinished.exists());
    assert!(matches!(
        backups.read_last_run().await.expect("the last run reads"),
        Some(BackupLastRun::Failed { message, .. })
            if message.as_str().contains("could not be listed")
    ));

    is_mirror_readable.store(true, Ordering::SeqCst);
    backups
        .run(BackupTrigger::Now, &stop, &meter)
        .await
        .expect("the run is recorded");

    // The new backup, the seven newest days, the week of the 5th's Monday and the person's own
    // folder stay; the unfinished folder goes.
    let remaining = backup_folders(&backups_folder);
    let mut expected: Vec<PathBuf> = older
        .iter()
        .filter(|folder| {
            !folder.ends_with("2020-10-06T12:00:00.000Z")
                && !folder.ends_with("2020-10-07T12:00:00.000Z")
                && **folder != unfinished
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
    check_private_run_folder(&written).expect("the backup's folder is owner-only");
    check_private_run_folder(&backups_folder.join("mirror")).expect("the mirror is owner-only");
    assert!(matches!(
        backups.read_last_run().await.expect("the last run reads"),
        Some(BackupLastRun::Completed { .. })
    ));
}

// A run stopped while its copy waits on the writer ends only once the writer's thread answers,
// then removes its folder, so no backup's folder is left and nothing is recorded. Killed by the
// copy dropped at the stop, which ends the run while the thread may still step into its folder.
#[tokio::test]
async fn a_stopped_run_waits_for_its_copy_and_leaves_no_folder() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = TempDir::new().expect("a scratch folder");
    let backups_folder = data_folder(home.path()).join("backups");
    let read_mirror_roots: MirrorRootsReader = Arc::new(|_meter| async { Ok(Vec::new()) }.boxed());
    let backups = test_backups(
        &database,
        &log,
        home.path().to_path_buf(),
        read_mirror_roots,
    );
    let (held, is_held) = oneshot::channel();
    let (release, released) = oneshot::channel::<()>();
    let writer = Arc::clone(&log.writer);
    let hold = tokio::spawn(async move {
        writer
            .hold_while(|| async move {
                held.send(()).expect("the test waits for the hold");
                released.await.expect("the test lets the hold go");
            })
            .await;
    });
    is_held.await.expect("the writer holds its writes");
    let stop = CancellationToken::new();
    let meter = ProcessorMeter::default();
    let mut run = Box::pin(backups.run(BackupTrigger::Now, &stop, &meter));
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut run)
            .await
            .is_err(),
        "the copy waits out the hold"
    );

    stop.cancel();

    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut run)
            .await
            .is_err(),
        "the stopped run waits for its copy's answer"
    );
    release.send(()).expect("the hold waits");
    let ran = run.await.expect("the stopped run ends cleanly");
    assert!(ran.is_none());
    hold.await.expect("the hold ends");
    assert_eq!(backup_folders(&backups_folder), Vec::<PathBuf>::new());
    assert!(
        backups
            .read_last_run()
            .await
            .expect("the last run reads")
            .is_none()
    );
}

// With `Back up automatically` off, a `Back up now` pressed once the daily run took its turn joins
// that run, which takes the stronger request at its check and copies, then lets the requests go so
// the next press queues a run of its own. Killed by the run keeping the trigger it started with,
// which skips with the switch off and loses the press.
#[tokio::test]
async fn a_back_up_now_that_joins_a_daily_run_makes_it_copy() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = TempDir::new().expect("a scratch folder");
    let backups_folder = data_folder(home.path()).join("backups");
    let read_mirror_roots: MirrorRootsReader = Arc::new(|_meter| async { Ok(Vec::new()) }.boxed());
    let backups = test_backups(
        &database,
        &log,
        home.path().to_path_buf(),
        read_mirror_roots,
    );
    let scheduler = Scheduler::start(
        Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
        None,
        tokio::sync::watch::channel(0).1,
    );
    // The daily run's turn, as its job takes it: no run was queued, so requests join this one.
    *lock(&backups.pending) = Some(BackupTrigger::Daily);
    backups
        .request(&scheduler, BackupTrigger::Now)
        .expect("the press joins the daily run");

    backups
        .run(
            BackupTrigger::Daily,
            &CancellationToken::new(),
            &ProcessorMeter::default(),
        )
        .await
        .expect("the run is recorded");

    assert_eq!(backup_folders(&backups_folder).len(), 1);
    assert!(lock(&backups.pending).is_none());
}
