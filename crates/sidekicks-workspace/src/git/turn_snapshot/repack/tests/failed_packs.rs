//! The captures whose own pack failed: packed again at the next sweep, what is present packed when
//! an object is gone, a capture that can never be packed forgotten, and the owner's hold.

use std::fs::{self, FileTimes};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use rstest::rstest;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::{is_superuser, make_unwritable};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{collect_garbage, counted, service_and_packing, stage_file};
use crate::git::process::{GitCall, GitRunner, in_folder, read_git_common_folder, test_git_runner};
use crate::git::turn_snapshot::capture::GitFloorReports;
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, git_folder_argument};
use crate::git::turn_snapshot::repack::{
    CaptureFolderSweep, CapturePacking, CapturedCommit, PackingError,
};
use crate::git::turn_snapshot::service::TurnSnapshotCaptureOutcome;
use crate::git::turn_snapshot::service::test_support::{
    answer, answer_with_captures, as_the_test, minted_run_id, repository_with_a_commit, turn_of,
    write_in,
};
use crate::git::worktree::schema::schema_parts;

// A time before a restarted daemon run began, younger than the hour past which a loose object is
// stale whatever run wrote it.
const BEFORE_THE_RUN: Duration = Duration::from_mins(10);

// A capture whose own pack failed is packed again at the next sweep: in the same daemon run from
// the run's record before its loose objects age, and after a restart, which loses the record, from
// its loose objects written before the run began, though younger than an hour. Fails when the
// record is not kept, or when the sweep after a restart leaves the capture's loose objects
// unwalked or reads them stale only past an hour (the gc in the repository then takes the staged
// blob only the capture's tree names), or when the tree is packed less the base's commit rather
// than its tree, which leaves nothing out and copies the base's file.
#[rstest]
#[case::in_the_same_run(false)]
#[case::after_a_restart(true)]
#[tokio::test]
async fn a_sweep_packs_again_a_capture_whose_own_pack_failed(#[case] is_restarted: bool) {
    // Root writes into a folder whatever its mode.
    if is_superuser() {
        return;
    }
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let common = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    stage_file(&git, &repository, "kept.txt", "in the base\n").await;
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
            "base",
        ],
    )
    .await;
    let base_blob = answer(
        &git,
        GitCall::read(in_folder(&repository, &["rev-parse", "HEAD:kept.txt"])),
    )
    .await;
    stage_file(&git, &repository, "n.txt", "only staged\n").await;
    let database = TestDatabase::new(schema_parts());
    let (service, packing) = service_and_packing(&git, &database);
    let owner = root.path().join("owner");
    let capture_folder = CaptureFolder::open_or_create(&git, None, &owner, &common)
        .await
        .expect("the capture folder is made");
    let folder = capture_folder.folder();
    let unwritable = make_unwritable(&folder.join("objects").join("pack"))
        .expect("the pack folder is made unwritable");
    let outcome = service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, minted_run_id(), 0))
        .await;
    drop(unwritable);
    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit, ..
    } = outcome
    else {
        panic!("the turn is captured, got {outcome:?}");
    };
    assert!(
        counted(&git, folder, "count").await > 0,
        "the failed pack left the capture loose"
    );
    let sweeping = if is_restarted {
        let aged_time = SystemTime::now() - BEFORE_THE_RUN;
        for fan_out in fs::read_dir(folder.join("objects")).expect("the object folder is listed") {
            let fan_out = fan_out.expect("the entry reads").path();
            if fan_out.file_name().is_some_and(|name| name.len() == 2) {
                for object in fs::read_dir(&fan_out).expect("the fan-out folder is listed") {
                    let object = object.expect("the entry reads").path();
                    fs::set_times(&object, FileTimes::new().set_modified(aged_time))
                        .expect("the loose object is aged");
                }
            }
        }
        Arc::new(CapturePacking::new(
            git.clone(),
            Arc::new(GitFloorReports::default()),
        ))
    } else {
        packing
    };

    let swept = sweeping
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
    write_in(&git, &repository, &["reset", "--quiet"]).await;
    collect_garbage(&git, &repository).await;

    assert!(
        matches!(swept, Ok(CaptureFolderSweep::Swept(_))),
        "got {swept:?}"
    );
    assert_eq!(counted(&git, folder, "count").await, 0);
    let file = format!("{}:n.txt", snapshot_commit.as_str());
    let read = answer_with_captures(
        &git,
        &repository,
        &capture_folder,
        &["cat-file", "-p", &file],
    )
    .await;
    assert_eq!(read, "only staged");
    let base_in_folder = git
        .run(
            None,
            GitCall::read([
                git_folder_argument(folder),
                "cat-file".into(),
                "-e".into(),
                base_blob.into(),
            ]),
        )
        .await;
    assert!(
        base_in_folder.is_err(),
        "the base's file is left out of the pack"
    );
}

// What waits behind an owner's hold.
#[derive(Debug)]
enum HeldBack {
    Sweep,
    Pack,
    Fold,
}

// A sweep, a pack or a capture's fold queued behind an owner's hold finds its folder gone once
// the hold drops and leaves it alone. Fails when any works on the folder without checking it is
// still there (the sweep's count of its objects then fails; the pack fails and keeps its capture
// to pack again; the fold's count fails), or when the hold leaves the owner's capture folder free.
#[rstest]
#[case::sweep(HeldBack::Sweep)]
#[case::pack(HeldBack::Pack)]
#[case::fold(HeldBack::Fold)]
#[tokio::test]
async fn a_sweep_or_a_pack_queued_behind_the_owners_hold_finds_its_folder_gone(
    #[case] held_back: HeldBack,
) {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, commit) = repository_with_a_commit(&git, root.path()).await;
    let common = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let packing = Arc::new(CapturePacking::new(
        git.clone(),
        Arc::new(GitFloorReports::default()),
    ));
    let owner = root.path().join("owner");
    let capture_folder = CaptureFolder::open_or_create(&git, None, &owner, &common)
        .await
        .expect("the capture folder is made");
    let folder = capture_folder.folder().to_path_buf();
    // A pass has read the folder, so a capture's fold runs once its lock comes free.
    lock(&packing.swept_folders).insert(folder.clone());
    let hold = packing
        .hold_owner_folders(&owner)
        .await
        .expect("the owner's folders are held");
    let handles = packing.folder_lock.queue_handle_count(folder.clone());
    let meter = ProcessorMeter::default();
    let commit = GitObjectId::new(commit).expect("the commit is an object id");
    let captured = CapturedCommit::new(capture_folder, commit.clone(), commit, None);
    let mut waiting = std::pin::pin!(async {
        match held_back {
            HeldBack::Sweep => packing
                .sweep_capture_folder(
                    None,
                    &owner,
                    &common,
                    None,
                    &[],
                    &[],
                    &[],
                    SystemTime::now(),
                    &meter,
                )
                .await
                .map(Some),
            HeldBack::Pack => {
                packing.pack(None, &captured).await;
                Ok(None)
            }
            HeldBack::Fold => packing
                .fold_when_due(None, folder.clone())
                .await
                .map(|()| None),
        }
    });

    tokio::select! {
        ended = &mut waiting => panic!("the {held_back:?} waits for the hold, got {ended:?}"),
        () = packing.folder_lock.wait_for_queue_past(folder.clone(), handles) => {}
    }
    fs::remove_dir_all(&folder).expect("the capture folder is removed");
    drop(hold);
    let swept = waiting.await;

    match held_back {
        HeldBack::Sweep => assert!(
            matches!(swept, Ok(Some(CaptureFolderSweep::Absent))),
            "got {swept:?}"
        ),
        HeldBack::Pack => assert!(
            lock(&packing.failed_packs).is_empty(),
            "the pack left the removed folder alone"
        ),
        HeldBack::Fold => assert!(matches!(swept, Ok(None)), "got {swept:?}"),
    }
    assert!(!folder.exists(), "the folder is not made again");
}

// A capture of the files staged in `repository` whose own pack failed, its capture folder's pack
// folder unwritable while it ran, with the packing that kept it.
struct FailedCapture {
    packing: Arc<CapturePacking>,
    capture_folder: CaptureFolder,
    owner: PathBuf,
    common: PathBuf,
    commit: GitObjectId,
}

async fn capture_with_a_failed_pack(
    git: &GitRunner,
    root: &Path,
    repository: &Path,
    database: &TestDatabase,
) -> FailedCapture {
    let common = read_git_common_folder(git, None, repository, None)
        .await
        .expect("the repository's git folder is read");
    let (service, packing) = service_and_packing(git, database);
    let owner = root.join("owner");
    let capture_folder = CaptureFolder::open_or_create(git, None, &owner, &common)
        .await
        .expect("the capture folder is made");
    let unwritable = make_unwritable(&capture_folder.folder().join("objects").join("pack"))
        .expect("the pack folder is made unwritable");
    let outcome = service
        .capture_turn_snapshot(None, &turn_of(repository, &owner, minted_run_id(), 0))
        .await;
    drop(unwritable);
    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit, ..
    } = outcome
    else {
        panic!("the turn is captured, got {outcome:?}");
    };
    assert!(
        !lock(&packing.failed_packs).is_empty(),
        "the failed pack is kept"
    );
    FailedCapture {
        packing,
        capture_folder,
        owner,
        common,
        commit: snapshot_commit,
    }
}

// One sweep pass over the failed capture's folder, as the first of the daemon run.
async fn sweep(failed: &FailedCapture) -> Result<CaptureFolderSweep, PackingError> {
    failed
        .packing
        .sweep_capture_folder(
            None,
            &failed.owner,
            &failed.common,
            None,
            &[],
            &[],
            &[],
            SystemTime::now(),
            &ProcessorMeter::default(),
        )
        .await
}

// Removes the loose object `object` from the object folder `objects`.
fn remove_loose_object(objects: &Path, object: &str) {
    let (fan_out, rest) = object.split_at(2);
    fs::remove_file(objects.join(fan_out).join(rest)).expect("the loose object is removed");
}

// A capture whose own pack failed and that borrows one object gone from the repository is packed
// at the next sweep with everything else it borrows, the gone object logged, and leaves the
// record, so one gone object stops no later pack of its folder. Fails when the pack of the
// capture's tree gives up on the gone object (the record stays and the gc in the repository takes
// the other staged blob, which the capture can then no longer read).
#[tokio::test]
async fn a_sweep_packs_what_is_present_of_a_failed_capture_that_borrows_a_gone_object() {
    // Root writes into a folder whatever its mode.
    if is_superuser() {
        return;
    }
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    stage_file(&git, &repository, "kept.txt", "kept\n").await;
    stage_file(&git, &repository, "gone.txt", "gone\n").await;
    let gone_blob = answer(
        &git,
        GitCall::read(in_folder(&repository, &["rev-parse", ":gone.txt"])),
    )
    .await;
    let database = TestDatabase::new(schema_parts());
    let failed = capture_with_a_failed_pack(&git, root.path(), &repository, &database).await;
    remove_loose_object(&repository.join(".git").join("objects"), &gone_blob);

    let swept = sweep(&failed).await;
    write_in(&git, &repository, &["reset", "--quiet"]).await;
    collect_garbage(&git, &repository).await;

    assert!(
        matches!(swept, Ok(CaptureFolderSweep::Swept(_))),
        "got {swept:?}"
    );
    assert!(lock(&failed.packing.failed_packs).is_empty());
    assert_eq!(
        counted(&git, failed.capture_folder.folder(), "count").await,
        0
    );
    let file = format!("{}:kept.txt", failed.commit.as_str());
    let read = answer_with_captures(
        &git,
        &repository,
        &failed.capture_folder,
        &["cat-file", "-p", &file],
    )
    .await;
    assert_eq!(read, "kept");
}

// What of a failed capture is gone before the sweep packs it again.
#[derive(Debug)]
enum GoneBeforeTheSweep {
    Tree,
    Base,
}

// A capture whose own pack failed leaves the record at the next sweep when it can never be packed
// on its base: one whose tree is gone is forgotten, and one whose base is gone is packed whole.
// Fails when a gone base's tree is still left out of the pack (git cannot read it, the pack fails
// and the record stays, keeping the folder from its idle skip for the rest of the run), and when
// both a gone tree is kept and the pack gives up on it.
#[rstest]
#[case::tree(GoneBeforeTheSweep::Tree)]
#[case::base(GoneBeforeTheSweep::Base)]
#[tokio::test]
async fn a_failed_capture_whose_tree_or_base_is_gone_leaves_the_record(
    #[case] gone: GoneBeforeTheSweep,
) {
    // Root writes into a folder whatever its mode.
    if is_superuser() {
        return;
    }
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, base) = repository_with_a_commit(&git, root.path()).await;
    stage_file(&git, &repository, "n.txt", "only staged\n").await;
    let database = TestDatabase::new(schema_parts());
    let failed = capture_with_a_failed_pack(&git, root.path(), &repository, &database).await;
    match gone {
        GoneBeforeTheSweep::Tree => {
            let tree = format!("{}^{{tree}}", failed.commit.as_str());
            let tree = answer_with_captures(
                &git,
                &repository,
                &failed.capture_folder,
                &["rev-parse", &tree],
            )
            .await;
            remove_loose_object(&failed.capture_folder.folder().join("objects"), &tree);
        }
        GoneBeforeTheSweep::Base => {
            // A new first commit of the same tree takes the branch, so the base is pruned.
            let tree = answer(
                &git,
                GitCall::read(in_folder(
                    &repository,
                    &["rev-parse", &format!("{base}^{{tree}}")],
                )),
            )
            .await;
            let other = answer(
                &git,
                as_the_test(GitCall::write(in_folder(
                    &repository,
                    &["commit-tree", &tree, "-m", "other"],
                ))),
            )
            .await;
            write_in(&git, &repository, &["update-ref", "HEAD", &other]).await;
            collect_garbage(&git, &repository).await;
            let base_in_repository = git
                .run(
                    None,
                    GitCall::read(in_folder(&repository, &["cat-file", "-e", &base])),
                )
                .await;
            assert!(base_in_repository.is_err(), "the base is pruned");
        }
    }

    let swept = sweep(&failed).await;

    assert!(
        matches!(swept, Ok(CaptureFolderSweep::Swept(_))),
        "got {swept:?}"
    );
    assert!(lock(&failed.packing.failed_packs).is_empty());
    if matches!(gone, GoneBeforeTheSweep::Base) {
        let file = format!("{}:n.txt", failed.commit.as_str());
        let read = answer_with_captures(
            &git,
            &repository,
            &failed.capture_folder,
            &["cat-file", "-p", &file],
        )
        .await;
        assert_eq!(read, "only staged");
    }
}
