use std::ffi::OsString;
use std::fs::{self, FileTimes};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use jiff::Timestamp;
use rstest::rstest;
use sidekicks_platforms::{is_superuser, make_unwritable};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{CaptureFolderSweep, CapturePacking, is_fold_due};
use crate::git::process::{GitCall, GitRunner, in_folder, read_git_common_folder, test_git_runner};
use crate::git::turn_snapshot::capture::{CheckoutCaptureInput, GitFloorReports};
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, git_folder_argument};
use crate::git::turn_snapshot::command_capture::CommandCaptureService;
use crate::git::turn_snapshot::service::test_support::{
    answer, answer_in_git_folder, answer_with_captures, files_with_bytes, made_capture_folder,
    minted_run_id, repository_with_a_commit, repository_without_a_commit, service_reading, turn_of,
    write_in,
};
use crate::git::turn_snapshot::service::{TurnSnapshotCaptureOutcome, TurnSnapshotService};
use crate::git::worktree::schema::schema_parts;

mod failed_packs;

// A read of a ref state well after its last write, outside the window in which a later write
// could keep the facts it read.
const SETTLED_READ_DELAY: Duration = Duration::from_secs(3);

// Twice the age past which a leftover is removed.
const LEFTOVER_AGE: Duration = Duration::from_hours(2);

// The value `count-objects -v` reports for `key` in the git folder `folder`.
async fn counted(git: &GitRunner, folder: &Path, key: &str) -> u64 {
    let report = answer_in_git_folder(git, folder, &["count-objects", "-v"], &[]).await;
    report
        .lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix(": "))
        .expect("count-objects reports the key")
        .parse()
        .expect("the count is a number")
}

// Writes `text` to `name` in `repository` and stages it, so its blob is a loose object of the
// repository that only the index names.
async fn stage_file(git: &GitRunner, repository: &Path, name: &str, text: &str) {
    tokio::fs::write(repository.join(name), text)
        .await
        .expect("the file is written");
    write_in(git, repository, &["add", name]).await;
}

// Expires every reflog entry and prunes every object no ref reaches, now.
async fn collect_garbage(git: &GitRunner, repository: &Path) {
    write_in(
        git,
        repository,
        &["reflog", "expire", "--expire=now", "--all"],
    )
    .await;
    write_in(git, repository, &["gc", "--quiet", "--prune=now"]).await;
}

// A turn-snapshot service and the packing it shares with the test.
fn service_and_packing(
    git: &GitRunner,
    database: &TestDatabase,
) -> (TurnSnapshotService, Arc<CapturePacking>) {
    let packing = Arc::new(CapturePacking::new(
        git.clone(),
        Arc::new(GitFloorReports::default()),
    ));
    let service = service_reading(
        git.clone(),
        database,
        Arc::new(KeyedLock::new()),
        Arc::clone(&packing),
    );
    (service, packing)
}

// Fails when a capture's borrowed blob is not packed into its capture folder (the gc in the
// repository then takes it), when packing waits for a HEAD move, when the pack runs without the
// repository attached or with `--local` or `--incremental`, when the tree form leaves the
// snapshot's commit loose, or when packing writes anything into the repository's own `.git`.
#[tokio::test]
async fn each_turn_snapshot_packs_what_it_borrows_so_a_gc_takes_none_of_it() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let database = TestDatabase::new(schema_parts());
    let (service, _) = service_and_packing(&git, &database);
    let owner = root.path().join("owner");
    let run_id = minted_run_id();
    let git_folder = repository.join(".git");
    let mut snapshot_commits = Vec::new();

    for (turn_ordinal, text) in [(0, "version 1\n"), (1, "version 2\n")] {
        stage_file(&git, &repository, "n.txt", text).await;
        let before = files_with_bytes(&git_folder);
        let outcome = service
            .capture_turn_snapshot(None, &turn_of(&repository, &owner, run_id, turn_ordinal))
            .await;
        assert_eq!(files_with_bytes(&git_folder), before);
        let TurnSnapshotCaptureOutcome::Captured {
            snapshot_commit, ..
        } = outcome
        else {
            panic!("the turn is captured, got {outcome:?}");
        };
        snapshot_commits.push(snapshot_commit);
        write_in(&git, &repository, &["reset", "--quiet"]).await;
    }
    collect_garbage(&git, &repository).await;

    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    assert_eq!(counted(&git, capture_folder.folder(), "count").await, 0);
    for (snapshot_commit, text) in snapshot_commits.iter().zip(["version 1", "version 2"]) {
        let blob = format!("{}:n.txt", snapshot_commit.as_str());
        let read = answer_with_captures(
            &git,
            &repository,
            &capture_folder,
            &["cat-file", "-p", &blob],
        )
        .await;
        assert_eq!(read, text);
    }
}

// Fails when a capture in a repository with no commit is refused, when its commit is given a
// parent, when its pack leaves an object loose, or when either capture writes the repository's
// own index or any other byte of its `.git`.
#[tokio::test]
async fn a_repository_with_no_commit_is_captured_and_packed() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let repository = repository_without_a_commit(&git, root.path()).await;
    tokio::fs::write(repository.join("first.txt"), "first\n")
        .await
        .expect("the file is written");
    let git_folder = repository.join(".git");
    let before = files_with_bytes(&git_folder);
    let database = TestDatabase::new(schema_parts());
    let (service, packing) = service_and_packing(&git, &database);
    let commands = CommandCaptureService::new(
        git.clone(),
        Arc::new(KeyedLock::new()),
        Arc::new(GitFloorReports::default()),
    );
    let owner = root.path().join("owner");

    let snapshot = service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, minted_run_id(), 0))
        .await;
    let command = commands
        .capture_before(
            None,
            &CheckoutCaptureInput {
                owner_folder: owner.clone(),
                execution_root: repository.clone(),
                checkout_root: repository.clone(),
                captured_at: Timestamp::from_second(1_800_000_000)
                    .expect("the instant is in range"),
            },
        )
        .await
        .expect("the command's capture is taken");
    packing.pack(None, &command.objects).await;

    assert_eq!(files_with_bytes(&git_folder), before);
    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit,
        base_commit: None,
        ..
    } = snapshot
    else {
        panic!("the turn is captured with no base, got {snapshot:?}");
    };
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    for commit in [&snapshot_commit, command.objects.commit()] {
        let parents = ["rev-list", "--parents", "-n1", commit.as_str()];
        let listed = answer_with_captures(&git, &repository, &capture_folder, &parents).await;
        assert_eq!(listed, commit.as_str(), "the capture has no parent");
        let file = format!("{}:first.txt", commit.as_str());
        let read = answer_with_captures(
            &git,
            &repository,
            &capture_folder,
            &["cat-file", "-p", &file],
        )
        .await;
        assert_eq!(read, "first");
    }
    assert_eq!(counted(&git, capture_folder.folder(), "count").await, 0);
}

// A repository with a commit under `root` and its capture folder for an owner, the folder holding
// eleven packs of one blob each, one past the fold's threshold, and no loose object.
async fn folder_with_eleven_packs(git: &GitRunner, root: &Path) -> (PathBuf, PathBuf) {
    let (repository, _) = repository_with_a_commit(git, root).await;
    let common = read_git_common_folder(git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let owner = root.join("owner");
    let capture_folder = CaptureFolder::open_or_create(git, None, &owner, &common)
        .await
        .expect("the capture folder is made");
    let folder = capture_folder.folder().to_path_buf();
    for index in 0..11 {
        let blob = git
            .run(
                None,
                GitCall::read([
                    git_folder_argument(&folder),
                    "hash-object".into(),
                    "-w".into(),
                    "--stdin".into(),
                ])
                .with_input(format!("blob {index}\n").into_bytes()),
            )
            .await
            .expect("the blob is written");
        let pack_base = folder.join("objects").join("pack").join("pack");
        git.run(
            None,
            GitCall::read([
                git_folder_argument(&folder),
                "pack-objects".into(),
                "-q".into(),
                OsString::from(pack_base),
            ])
            .with_input(blob.stdout),
        )
        .await
        .expect("the blob is packed");
    }
    answer_in_git_folder(git, &folder, &["prune-packed"], &[]).await;
    (repository, folder)
}

// Fails when the fold writes a bitmap (a `pack.writeBitmaps` setting then fails it), writes
// `info/refs` or `objects/info/packs`, folds nothing, or copies an object the folder only borrows.
#[tokio::test]
async fn a_fold_merges_the_folders_own_packs_and_nothing_it_borrows() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, folder) = folder_with_eleven_packs(&git, root.path()).await;
    answer_in_git_folder(&git, &folder, &["config", "pack.writeBitmaps", "true"], &[]).await;
    let borrowed = answer(
        &git,
        GitCall::read(in_folder(&repository, &["hash-object", "-w", "--stdin"]))
            .with_input(b"only the repository\n".to_vec()),
    )
    .await;
    let packing = CapturePacking::new(git.clone(), Arc::new(GitFloorReports::default()));
    let lock = KeyedLock::new();
    let hold = lock.acquire(PathBuf::from("fold")).await;

    let folded = packing.fold_held(None, &folder, &hold).await;

    assert!(folded.is_ok(), "got {folded:?}");
    assert!(counted(&git, &folder, "packs").await < 11);
    let in_folder_alone = git
        .run(
            None,
            GitCall::read([
                git_folder_argument(&folder),
                "cat-file".into(),
                "-e".into(),
                borrowed.into(),
            ]),
        )
        .await;
    assert!(in_folder_alone.is_err(), "the borrowed blob is not copied");
    assert!(!folder.join("info").join("refs").exists());
    assert!(!folder.join("objects").join("info").join("packs").exists());
}

// Fails when a failed fold is not kept, so the next capture folds the folder again at once rather
// than an hour later.
#[tokio::test]
async fn a_failed_fold_keeps_the_next_fold_waiting() {
    // Root writes into a folder whatever its mode.
    if is_superuser() {
        return;
    }
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (_, folder) = folder_with_eleven_packs(&git, root.path()).await;
    let packing = CapturePacking::new(git.clone(), Arc::new(GitFloorReports::default()));
    let lock = KeyedLock::new();
    let hold = lock.acquire(PathBuf::from("fold")).await;
    let unwritable = make_unwritable(&folder.join("objects").join("pack"))
        .expect("the pack folder is made unwritable");

    let failed = packing.fold_held(None, &folder, &hold).await;
    drop(unwritable);
    let again = packing.fold_held(None, &folder, &hold).await;

    assert!(failed.is_err(), "the fold fails, got {failed:?}");
    assert!(again.is_ok(), "got {again:?}");
    assert_eq!(counted(&git, &folder, "packs").await, 11);
}

// A fold a capture's pack finds due waits for the folder's first sweep pass of the daemon run,
// which packs what an earlier run's failed pack left loose, and runs once that pass read it.
// Fails when the fold runs before the pass (the eleven packs are folded at once).
#[tokio::test]
async fn a_capture_fold_waits_for_the_folders_first_sweep_pass() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (_, folder) = folder_with_eleven_packs(&git, root.path()).await;
    let packing = CapturePacking::new(git.clone(), Arc::new(GitFloorReports::default()));

    let before_the_pass = packing.fold_when_due(None, folder.clone()).await;
    let packs_before_the_pass = counted(&git, &folder, "packs").await;
    lock(&packing.swept_folders).insert(folder.clone());
    let after_the_pass = packing.fold_when_due(None, folder.clone()).await;

    assert!(before_the_pass.is_ok(), "got {before_the_pass:?}");
    assert_eq!(packs_before_the_pass, 11);
    assert!(after_the_pass.is_ok(), "got {after_the_pass:?}");
    assert!(counted(&git, &folder, "packs").await < 11);
}

// Fails on an off-by-one at the threshold, when the packs the last fold left are ignored, so
// packs already in geometric order are folded again after every capture, or when a fold that
// failed within the hour is run again, or never again after it.
#[rstest]
#[case::at_the_threshold(10, None, None, false)]
#[case::past_the_threshold(11, None, None, true)]
#[case::past_a_fold_that_left_fewer(11, Some(10), None, true)]
#[case::as_the_last_fold_left(12, Some(12), None, false)]
#[case::past_the_last_fold(13, Some(12), None, true)]
#[case::below_the_threshold_after_a_fold(10, Some(3), None, false)]
#[case::within_the_hour_after_a_failed_fold(11, None, Some(59 * 60), false)]
#[case::an_hour_after_a_failed_fold(11, None, Some(60 * 60), true)]
fn a_fold_is_due_past_ten_packs_past_what_the_last_fold_left_and_an_hour_after_a_failure(
    #[case] packs: u64,
    #[case] left: Option<u64>,
    #[case] since_failure_seconds: Option<u64>,
    #[case] is_due: bool,
) {
    let since_failure = since_failure_seconds.map(Duration::from_secs);
    assert_eq!(is_fold_due(packs, left, since_failure), is_due);
}

// Fails when the leftovers are cleared only on a swept pass, when their age is ignored so a fresh
// entry goes, when any one stale kind is kept, an index a stopped reclaim left without its pack
// among them, or when a kept index, its `.head` or its lock, or a finished pack, is removed.
#[tokio::test]
async fn a_sweep_pass_clears_what_a_cut_git_or_a_crash_left_and_keeps_the_rest() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let common = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let database = TestDatabase::new(schema_parts());
    let (service, packing) = service_and_packing(&git, &database);
    let owner = root.path().join("owner");
    stage_file(&git, &repository, "n.txt", "version 1\n").await;
    service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, minted_run_id(), 0))
        .await;
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let folder = capture_folder.folder();
    let settled = SystemTime::now() + SETTLED_READ_DELAY;
    let first = packing
        .sweep_capture_folder(
            None,
            &owner,
            &common,
            None,
            &[],
            &[],
            &[],
            settled,
            &ProcessorMeter::default(),
        )
        .await;
    let Ok(CaptureFolderSweep::Swept(pass)) = first else {
        panic!("the folder is swept, got {first:?}");
    };
    let fresh_garbage = counted(&git, folder, "garbage").await;
    let packs_before = counted(&git, folder, "packs").await;
    let pack_folder = folder.join("objects").join("pack");
    let indexes = capture_folder.indexes_folder();
    let captures = owner.join("captures");
    let kept_index = "ab".repeat(32);
    let packless = format!("pack-{}", "cd".repeat(20));
    let stale = [
        pack_folder.join("tmp_pack_stale"),
        pack_folder.join(".tmp-12-pack-stale.pack"),
        pack_folder.join(format!("{packless}.idx")),
        pack_folder.join(format!("{packless}.rev")),
        folder.join("objects").join("ab").join("tmp_obj_stale"),
        indexes.join("scratch-0011223344556677.index"),
        indexes.join("scratch-0011223344556677.index.lock"),
    ];
    let kept = [
        pack_folder.join("tmp_pack_live"),
        pack_folder.join(".tmp-13-pack-live.pack"),
        indexes.join("scratch-live.index"),
        indexes.join(&kept_index),
        indexes.join(format!("{kept_index}.head")),
        indexes.join(format!("{kept_index}.lock")),
    ];
    // Listed before the planting, so the planted index with no pack is not among them.
    let finished_packs: Vec<PathBuf> = fs::read_dir(&pack_folder)
        .expect("the pack folder is listed")
        .map(|entry| entry.expect("the entry reads").path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("pack-"))
        })
        .collect();
    assert!(!finished_packs.is_empty(), "the capture wrote a pack");
    let stale_partial = captures.join("other.8899aabbccddeeff.partial");
    let fresh_partial = captures.join("other.0123456789abcdef.partial");
    for path in stale.iter().chain(&kept) {
        fs::create_dir_all(path.parent().expect("a planted file has a folder"))
            .expect("the folder is made");
        fs::write(path, b"").expect("the file is written");
    }
    fs::create_dir_all(&stale_partial).expect("the partial folder is made");
    fs::write(stale_partial.join("HEAD"), b"").expect("the file is written");
    fs::create_dir_all(&fresh_partial).expect("the partial folder is made");
    let aged_time = SystemTime::now() - LEFTOVER_AGE;
    // By path, since git writes its packs read-only.
    let aged_paths = stale.iter().chain(&kept[3..]).chain(&finished_packs);
    for path in aged_paths.chain([&stale_partial]) {
        fs::set_times(path, FileTimes::new().set_modified(aged_time)).expect("the entry is aged");
    }

    let second = packing
        .sweep_capture_folder(
            None,
            &owner,
            &common,
            Some(&pass),
            &[],
            &[],
            &[],
            settled,
            &ProcessorMeter::default(),
        )
        .await;

    assert!(
        matches!(second, Ok(CaptureFolderSweep::Skipped(_))),
        "got {second:?}"
    );
    for path in stale.iter().chain([&stale_partial]) {
        assert!(!path.exists(), "{} is removed", path.display());
    }
    for path in kept.iter().chain([&fresh_partial]).chain(&finished_packs) {
        assert!(path.exists(), "{} is kept", path.display());
    }
    assert_eq!(counted(&git, folder, "packs").await, packs_before);
    assert_eq!(fresh_garbage, 0, "a fresh capture folder holds no garbage");
}

// Fails when the sweep skips the reach pack (the gc then takes the blob only the lost branch
// held), reads the reach check the wrong way round, sweeps an idle folder again, starts a git
// process for a folder still idle since its last count, or packs a capture whose base a ref still
// reaches.
#[tokio::test]
async fn a_sweep_packs_the_captures_whose_base_no_ref_reaches_and_skips_an_idle_folder() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let common = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let database = TestDatabase::new(schema_parts());
    let (service, packing) = service_and_packing(&git, &database);
    let owner = root.path().join("owner");
    let run_id = minted_run_id();
    let main_branch = answer(
        &git,
        GitCall::read(in_folder(&repository, &["symbolic-ref", "--short", "HEAD"])),
    )
    .await;
    // A capture on `main`, whose base stays reached; its staged file gives its tree an object
    // beyond the base's tree, so packing it as unreached would write a pack.
    stage_file(&git, &repository, "on-main.txt", "on main\n").await;
    service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, run_id, 0))
        .await;
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let folder = capture_folder.folder();
    let packs_before = counted(&git, folder, "packs").await;
    let reached_sweep = packing
        .sweep_capture_folder(
            None,
            &owner,
            &common,
            None,
            &[],
            &[],
            &[],
            SystemTime::now(),
            &ProcessorMeter::default(),
        )
        .await;
    assert!(
        matches!(reached_sweep, Ok(CaptureFolderSweep::Swept(_))),
        "got {reached_sweep:?}"
    );
    assert_eq!(counted(&git, folder, "packs").await, packs_before);

    write_in(&git, &repository, &["checkout", "--quiet", "-b", "topic"]).await;
    stage_file(&git, &repository, "only-topic.txt", "only on topic\n").await;
    write_in(
        &git,
        &repository,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-q",
            "-m",
            "topic",
        ],
    )
    .await;
    let outcome = service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, run_id, 1))
        .await;
    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit, ..
    } = outcome
    else {
        panic!("the turn is captured, got {outcome:?}");
    };
    write_in(&git, &repository, &["checkout", "--quiet", &main_branch]).await;
    write_in(&git, &repository, &["branch", "--quiet", "-D", "topic"]).await;
    write_in(
        &git,
        &repository,
        &["reflog", "expire", "--expire=now", "--all"],
    )
    .await;

    let settled = SystemTime::now() + SETTLED_READ_DELAY;
    let first = packing
        .sweep_capture_folder(
            None,
            &owner,
            &common,
            None,
            &[],
            &[],
            &[],
            settled,
            &ProcessorMeter::default(),
        )
        .await;
    let Ok(CaptureFolderSweep::Swept(pass)) = first else {
        panic!("the folder is swept, got {first:?}");
    };
    let second = packing
        .sweep_capture_folder(
            None,
            &owner,
            &common,
            Some(&pass),
            &[],
            &[],
            &[],
            settled,
            &ProcessorMeter::default(),
        )
        .await;
    let Ok(CaptureFolderSweep::Skipped(idle)) = second else {
        panic!("the idle folder is skipped, got {second:?}");
    };
    // Any git run in the capture folder now fails, so an idle pass that starts one answers it.
    let config = folder.join("config");
    let kept_config = std::fs::read(&config).expect("the folder's config is read");
    std::fs::write(&config, "[broken\n").expect("the folder's config is written");
    let third = packing
        .sweep_capture_folder(
            None,
            &owner,
            &common,
            Some(&idle),
            &[],
            &[],
            &[],
            settled,
            &ProcessorMeter::default(),
        )
        .await;
    assert!(
        matches!(third, Ok(CaptureFolderSweep::Skipped(_))),
        "an idle folder starts no git process, got {third:?}"
    );
    std::fs::write(&config, kept_config).expect("the folder's config is put back");
    collect_garbage(&git, &repository).await;

    let file = format!("{}:only-topic.txt", snapshot_commit.as_str());
    let read = answer_with_captures(
        &git,
        &repository,
        &capture_folder,
        &["cat-file", "-p", &file],
    )
    .await;
    assert_eq!(read, "only on topic");
}

// Fails when a deleted repository's pass answers a failure rather than its absence, when its
// capture folder is removed, or when the owner's partial folders are cleared only after the
// repository resolves.
#[tokio::test]
async fn a_sweep_of_a_deleted_repository_answers_its_absence_and_keeps_its_folder() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let common = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let database = TestDatabase::new(schema_parts());
    let (service, packing) = service_and_packing(&git, &database);
    let owner = root.path().join("owner");
    service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, minted_run_id(), 0))
        .await;
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    fs::remove_dir_all(&repository).expect("the repository is removed");
    let partial = owner.join("captures").join("gone.8899aabbccddeeff.partial");
    fs::create_dir_all(&partial).expect("the partial folder is made");
    fs::set_times(
        &partial,
        FileTimes::new().set_modified(SystemTime::now() - LEFTOVER_AGE),
    )
    .expect("the partial folder is aged");

    let swept = packing
        .sweep_capture_folder(
            None,
            &owner,
            &common,
            None,
            &[],
            &[],
            &[],
            SystemTime::now(),
            &ProcessorMeter::default(),
        )
        .await;

    assert!(
        matches!(swept, Ok(CaptureFolderSweep::RepositoryGone)),
        "got {swept:?}"
    );
    assert!(
        capture_folder.folder().exists(),
        "the capture folder is kept"
    );
    assert!(!partial.exists(), "the partial folder is removed");
}
