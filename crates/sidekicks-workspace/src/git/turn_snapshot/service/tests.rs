use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{File, FileTimes};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use rstest::rstest;
use sidekicks_contracts::git::local::WorkflowRunSnapshotPoint;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::run::snapshot::{WorkflowRunEpoch, WorkflowRunPauseNumber};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::test_support::{
    answer, answer_in_git_folder, answer_with_captures, as_the_test, checkout_of, files_with_bytes,
    made_capture_folder, minted_run_id, minted_workflow_run_id, point_of, repository_with_a_commit,
    service_reading, turn_of, utf8, write_in,
};
use super::{
    CheckoutTreeOutcome, TurnSnapshotCaptureInput, TurnSnapshotCaptureOutcome,
    TurnSnapshotPruneOutcome,
};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::version::KeptProgramFacts;
use crate::git::process::{GitCall, GitRunner, in_folder, read_git_common_folder, test_git_runner};
use crate::git::turn_snapshot::capture::{CheckoutCaptureInput, GitFloorReports, LARGE_FILE_BYTES};
use crate::git::turn_snapshot::capture_folder::{
    CaptureFolder, OBJECTS_SEGMENT, git_folder_argument,
};
use crate::git::turn_snapshot::diagnostics::{CaptureStep, TurnSnapshotRetentionSkipReason};
use crate::git::turn_snapshot::refs::{RunSnapshotPoint, build_run_snapshot_ref_prefix};
use crate::git::turn_snapshot::repack::CapturePacking;
use crate::git::turn_snapshot::retention::RunContextKey;
use crate::git::worktree::schema::schema_parts;
use crate::git::worktree::test_rows::{RunContextRow, insert_worktree_rows};

const ENDED_AT: &str = "2026-10-19T10:00:00.000Z";

// A commit of the empty tree written into the git folder `folder` alone.
async fn commit_in_git_folder(git: &GitRunner, folder: &Path) -> String {
    let tree = answer_in_git_folder(git, folder, &["mktree"], &[]).await;
    let arguments = [git_folder_argument(folder)]
        .into_iter()
        .chain(["commit-tree", tree.as_str(), "-F", "-"].map(OsString::from));
    answer(
        git,
        as_the_test(GitCall::write(arguments)).with_input(b"planted\n".to_vec()),
    )
    .await
}

// A service over a fresh test database, packing through its own packing.
fn service_over(
    git: &GitRunner,
    database: &TestDatabase,
    checkout_lock: Arc<KeyedLock<std::path::PathBuf>>,
) -> super::TurnSnapshotService {
    let packing = Arc::new(CapturePacking::new(
        git.clone(),
        Arc::new(GitFloorReports::default()),
    ));
    service_reading(git.clone(), database, checkout_lock, packing)
}

// Fails when one project state at one turn end gives two snapshot ids, when the untracked file is
// left out, when a second capture of a turn moves its ref instead of reporting the first
// snapshot, or when a capture writes anything into the repository's own `.git`: an object or a
// ref, or the shared part of a split scratch index the index guards keep out. Fails too when the
// scratch index outlives the capture.
#[tokio::test]
async fn a_turn_is_captured_once_into_its_owners_folder_and_the_repository_stays_as_it_was() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, base) = repository_with_a_commit(&git, root.path()).await;
    write_in(&git, &repository, &["config", "core.splitIndex", "true"]).await;
    tokio::fs::write(repository.join("notes.txt"), "a note\n")
        .await
        .expect("the untracked file is written");
    let git_folder = repository.join(".git");
    let before = files_with_bytes(&git_folder);
    let database = TestDatabase::new(schema_parts());
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");
    let run_id = minted_run_id();
    let turn = |turn_ordinal| turn_of(&repository, &owner, run_id, turn_ordinal);

    let first = service.capture_turn_snapshot(None, &turn(0)).await;
    let second = service.capture_turn_snapshot(None, &turn(1)).await;
    let again = service.capture_turn_snapshot(None, &turn(0)).await;

    assert_eq!(files_with_bytes(&git_folder), before);
    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_ref,
        snapshot_commit,
        base_commit,
        ..
    } = first
    else {
        panic!("the first turn is captured, got {first:?}");
    };
    assert_eq!(
        base_commit.as_ref().map(GitObjectId::as_str),
        Some(base.as_str())
    );
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let recorded = answer_in_git_folder(
        &git,
        capture_folder.folder(),
        &["rev-parse", &snapshot_ref],
        &[],
    )
    .await;
    assert_eq!(recorded, snapshot_commit.as_str());
    let listing = ["ls-tree", "--name-only", snapshot_commit.as_str()];
    assert_eq!(
        answer_with_captures(&git, &repository, &capture_folder, &listing).await,
        "notes.txt"
    );
    let left_indexes = std::fs::read_dir(capture_folder.indexes_folder())
        .expect("the indexes folder lists")
        .count();
    assert_eq!(left_indexes, 0, "no scratch index outlives its capture");
    assert!(
        matches!(&second, TurnSnapshotCaptureOutcome::Captured { snapshot_commit: id, .. }
            if *id == snapshot_commit),
        "the same state gives the same id, got {second:?}"
    );
    assert!(
        matches!(&again, TurnSnapshotCaptureOutcome::AlreadyCaptured { snapshot_commit: id, .. }
            if *id == snapshot_commit),
        "a turn captured again keeps its first snapshot, got {again:?}"
    );
}

// Execution `number` of a workflow run.
fn epoch(number: u64) -> WorkflowRunEpoch {
    WorkflowRunEpoch(SafeInt::new(number).expect("the epoch is a safe integer"))
}

// Approval pause `number` of an execution, counted from 1.
fn pause(number: u64) -> WorkflowRunPauseNumber {
    WorkflowRunPauseNumber(SafeInt::new(number).expect("the pause number is counted from 1"))
}

// Fails when two point kinds spell one ref (`start` and `end` alike), when `build_snapshot_ref`
// writes `pause` without its number (pause 2 then answers `AlreadyCaptured`), when it drops the
// epoch (epoch 1's start then answers `AlreadyCaptured`), when the refs are keyed on any id but the
// workflow run's (the listing under its prefix is then empty), or when a point taken again
// repoints its ref instead of keeping its first capture.
#[tokio::test]
async fn a_workflow_runs_points_land_beside_each_other_and_one_taken_again_keeps_its_first() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let database = TestDatabase::new(schema_parts());
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");
    let workflow_run_id = minted_workflow_run_id();
    let at = |point| {
        let point = RunSnapshotPoint::WorkflowRun {
            workflow_run_id,
            point,
        };
        point_of(&repository, &owner, point)
    };
    let pause_one = WorkflowRunSnapshotPoint::Pause {
        epoch: epoch(0),
        pause_number: pause(1),
    };
    let epoch_zero = [
        (
            "epoch-0/start",
            WorkflowRunSnapshotPoint::Start { epoch: epoch(0) },
        ),
        ("epoch-0/pause-1", pause_one),
        (
            "epoch-0/pause-2",
            WorkflowRunSnapshotPoint::Pause {
                epoch: epoch(0),
                pause_number: pause(2),
            },
        ),
        (
            "epoch-0/end",
            WorkflowRunSnapshotPoint::End { epoch: epoch(0) },
        ),
    ];
    let notes = repository.join("notes.txt");
    // The point taken over the checkout once `state` is written into it.
    let take = async |state: String, point| {
        tokio::fs::write(&notes, state)
            .await
            .expect("the file is written");
        service.capture_turn_snapshot(None, &at(point)).await
    };
    let mut taken = Vec::new();
    for (index, (point_ref, point)) in epoch_zero.into_iter().enumerate() {
        let outcome = take(format!("state {index}\n"), point).await;
        let TurnSnapshotCaptureOutcome::Captured {
            snapshot_commit, ..
        } = outcome
        else {
            panic!("{point_ref} is captured, got {outcome:?}");
        };
        taken.push((point_ref, snapshot_commit));
    }
    let again = take("changed after the end\n".to_owned(), pause_one).await;
    let next_start = take(
        "the next execution\n".to_owned(),
        WorkflowRunSnapshotPoint::Start { epoch: epoch(1) },
    )
    .await;

    let (_, first_pause) = &taken[1];
    assert!(
        matches!(&again, TurnSnapshotCaptureOutcome::AlreadyCaptured { snapshot_commit, .. }
            if snapshot_commit == first_pause),
        "a point taken twice keeps its first capture, got {again:?}"
    );
    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit, ..
    } = next_start
    else {
        panic!("the next execution's start is captured, got {next_start:?}");
    };
    taken.push(("epoch-1/start", snapshot_commit));
    let distinct: HashSet<&str> = taken.iter().map(|(_, commit)| commit.as_str()).collect();
    assert_eq!(distinct.len(), 5, "each point records its own state");
    let prefix = build_run_snapshot_ref_prefix(RunContextKey::from(workflow_run_id));
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let listing = ["for-each-ref", "--format=%(refname)", prefix.as_str()];
    let listed = answer_in_git_folder(&git, capture_folder.folder(), &listing, &[]).await;
    let expected: Vec<String> = [
        "epoch-0/end",
        "epoch-0/pause-1",
        "epoch-0/pause-2",
        "epoch-0/start",
        "epoch-1/start",
    ]
    .map(|point_ref| format!("{prefix}{point_ref}"))
    .into();
    assert_eq!(listed.lines().collect::<Vec<_>>(), expected);
    for (point_ref, commit) in &taken {
        let full_ref = format!("{prefix}{point_ref}");
        let recorded = answer_in_git_folder(
            &git,
            capture_folder.folder(),
            &["rev-parse", &full_ref],
            &[],
        )
        .await;
        assert_eq!(recorded, commit.as_str(), "{point_ref} names its own take");
    }
}

// Fails when an unended run's refs or an absent capture folder's are touched or misreported, when
// the prune is aimed at the repository instead of the owner's capture folder (the repository's
// ref of the same name goes, or the capture folder's stays), when a symref planted under the
// run's prefix takes the branch it names with it, or when any ref under the prefix is left
// behind; a second prune finds none. Fails too when a prune that deletes refs leaves no reclaim
// mark (the sweep never reclaims the run's objects), when a skipped or empty prune leaves one, and
// when the delete runs before the mark or past a failed one (the blocked mark's refs go).
#[rstest]
#[case::an_unended_run_is_skipped(
    None,
    true,
    false,
    Some(TurnSnapshotRetentionSkipReason::RunNotEnded)
)]
#[case::an_owner_without_a_capture_folder_is_skipped(
    Some(ENDED_AT),
    false,
    false,
    Some(TurnSnapshotRetentionSkipReason::GitDirAbsent)
)]
#[case::a_planted_symref_goes_and_its_branch_stays(Some(ENDED_AT), true, false, None)]
#[case::a_mark_that_cannot_be_written_deletes_no_ref(
    Some(ENDED_AT),
    true,
    true,
    Some(TurnSnapshotRetentionSkipReason::ReclaimMarkFailed)
)]
#[tokio::test]
async fn a_run_prune_deletes_every_ref_under_its_prefix_in_the_capture_folder_and_nothing_else(
    #[case] released_at: Option<&str>,
    #[case] is_capture_folder_made: bool,
    #[case] is_mark_blocked: bool,
    #[case] skip_reason: Option<TurnSnapshotRetentionSkipReason>,
) {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, commit) = repository_with_a_commit(&git, root.path()).await;
    let git_common_dir = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let owner = root.path().join("owner");
    let run_key = RunContextKey::from(minted_run_id());
    let prefix = build_run_snapshot_ref_prefix(run_key);
    let plain_ref = format!("{prefix}epoch-0/turn-0");
    let planted_ref = format!("{prefix}epoch-0/turn-1");
    write_in(&git, &repository, &["update-ref", &plain_ref, &commit]).await;
    let capture_folder = if is_capture_folder_made {
        let packing = CapturePacking::new(git.clone(), Arc::default());
        let capture_folder =
            CaptureFolder::open_or_create(&git, None, &packing, &owner, &git_common_dir)
                .await
                .expect("the capture folder is made");
        let folder = capture_folder.folder();
        let snapshot = commit_in_git_folder(&git, folder).await;
        for arguments in [
            ["update-ref", "refs/heads/kept", snapshot.as_str()],
            ["update-ref", plain_ref.as_str(), snapshot.as_str()],
            ["symbolic-ref", planted_ref.as_str(), "refs/heads/kept"],
        ] {
            answer_in_git_folder(&git, folder, &arguments, &[]).await;
        }
        if is_mark_blocked {
            // A file where the marks' folder goes, so the mark cannot be written.
            std::fs::write(folder.join("reclaims"), "").expect("the blocking file is written");
        }
        Some((capture_folder, snapshot))
    } else {
        None
    };
    let database = TestDatabase::new(schema_parts());
    // Opening the writer creates the file with the daemon's schema.
    let _writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let rows = database.reader();
    insert_worktree_rows(&rows);
    let run_id = run_key.to_string();
    RunContextRow {
        run_id: &run_id,
        execution_root: utf8(&repository),
        checkout_root: Some(utf8(&repository)),
        git_common_dir: Some(utf8(&git_common_dir)),
        released_at,
        ..RunContextRow::BOUND_ROOT
    }
    .insert(&rows)
    .expect("the test stores the run's context");
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));

    let pruned = service.prune_snapshots_for_run(None, run_key, &owner).await;

    let in_repository = in_folder(&repository, &["rev-parse", "--verify", &plain_ref]);
    assert_eq!(answer(&git, GitCall::read(in_repository)).await, commit);
    let remaining = match &capture_folder {
        Some((capture_folder, _)) => {
            let listing = ["for-each-ref", "--format=%(refname)", prefix.as_str()];
            answer_in_git_folder(&git, capture_folder.folder(), &listing, &[]).await
        }
        None => String::new(),
    };
    if let Some(expected) = skip_reason {
        assert!(
            matches!(
                pruned,
                TurnSnapshotPruneOutcome::Skipped { reason, .. } if reason == expected
            ),
            "got {pruned:?}"
        );
        if let Some((capture_folder, _)) = &capture_folder {
            assert_eq!(
                remaining.lines().count(),
                2,
                "a skipped prune deletes nothing"
            );
            assert!(
                is_mark_blocked || !capture_folder.folder().join("reclaims").exists(),
                "a skipped prune marks nothing"
            );
        }
        return;
    }
    let TurnSnapshotPruneOutcome::Pruned { mut deleted_refs } = pruned else {
        panic!("the ended run's refs are pruned, got {pruned:?}");
    };
    deleted_refs.sort();
    assert_eq!(deleted_refs, [plain_ref, planted_ref]);
    assert_eq!(remaining, "");
    let (capture_folder, snapshot) = capture_folder.expect("the pruned case made the folder");
    let kept = ["rev-parse", "--verify", "refs/heads/kept"];
    assert_eq!(
        answer_in_git_folder(&git, capture_folder.folder(), &kept, &[]).await,
        snapshot
    );
    let mark = capture_folder
        .folder()
        .join("reclaims")
        .join(run_key.to_string());
    assert!(mark.exists(), "the prune marks the folder for its reclaim");
    std::fs::remove_file(&mark).expect("the mark is removed");
    let again = service.prune_snapshots_for_run(None, run_key, &owner).await;
    let is_empty_prune = matches!(
        &again,
        TurnSnapshotPruneOutcome::Pruned { deleted_refs } if deleted_refs.is_empty()
    );
    assert!(
        is_empty_prune,
        "a second prune finds nothing, got {again:?}"
    );
    assert!(!mark.exists(), "an empty prune marks nothing");
}

// Fails when the capture takes a lock of its own instead of the run setup gate's: it then runs
// while the gate holds the checkout.
#[tokio::test]
async fn a_capture_waits_for_the_gate_holding_its_checkout() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let database = TestDatabase::new(schema_parts());
    let gate_lock = Arc::new(KeyedLock::new());
    let service = service_over(&git, &database, Arc::clone(&gate_lock));
    let input = turn_of(&repository, &root.path().join("owner"), minted_run_id(), 0);
    let checkout_key = canonical_folder_path(&repository)
        .await
        .expect("the checkout resolves");
    let gate_hold = gate_lock.acquire(checkout_key.clone()).await;
    let held_handles = gate_lock.queue_handle_count(checkout_key.clone());

    let capture = service.capture_turn_snapshot(None, &input);
    tokio::pin!(capture);
    tokio::select! {
        biased;
        outcome = &mut capture => {
            panic!("the capture ran while the gate held its checkout, got {outcome:?}");
        }
        () = gate_lock.wait_for_queue_past(checkout_key, held_handles) => {}
    }
    drop(gate_hold);
    let outcome = capture.await;

    assert!(
        matches!(outcome, TurnSnapshotCaptureOutcome::Captured { .. }),
        "the capture runs once the gate lets go, got {outcome:?}"
    );
}

// Counts the events that report a git below the capture's floor.
struct FloorReportCount(Arc<AtomicUsize>);

impl tracing::Subscriber for FloorReportCount {
    fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        if event.metadata().fields().field("git_floor").is_some() {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn enter(&self, _span: &tracing::span::Id) {}

    fn exit(&self, _span: &tracing::span::Id) {}
}

// Fails when the floor is one release for every capture rather than a feature per capture (a
// plain root then refused on 2.40), when the sparse check runs after the capture folder is opened,
// when a git below a floor writes anything, or when the old git is reported at every capture
// rather than once per place and feature.
#[rstest]
#[case::below_the_fsync_floor(b"git version 2.35.9\n".as_slice(), false, false)]
#[case::a_plain_root_on_2_40(b"git version 2.40.0\n".as_slice(), false, true)]
#[case::a_sparse_root_on_2_40(b"git version 2.40.0\n".as_slice(), true, false)]
#[tokio::test]
async fn each_capture_needs_only_the_git_features_it_calls(
    #[case] version_output: &[u8],
    #[case] is_sparse_root: bool,
    #[case] is_captured: bool,
) {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    if is_sparse_root {
        write_in(
            &git,
            &repository,
            &["config", "core.sparseCheckout", "true"],
        )
        .await;
    }
    let git_folder = repository.join(".git");
    let before = files_with_bytes(&git_folder);
    let database = TestDatabase::new(schema_parts());
    let old_git = git
        .reading_version_as(version_output, KeptProgramFacts::Current)
        .await;
    let service = service_over(&old_git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");
    let run_id = minted_run_id();
    let reports = Arc::new(AtomicUsize::new(0));
    let _reporting = tracing::subscriber::set_default(FloorReportCount(Arc::clone(&reports)));

    let first = service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, run_id, 0))
        .await;
    let second = service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, run_id, 1))
        .await;

    for outcome in [&first, &second] {
        let is_refused = matches!(
            outcome,
            TurnSnapshotCaptureOutcome::Failed {
                failed_step: CaptureStep::GitFloor,
                ..
            }
        );
        let is_outcome_captured = matches!(outcome, TurnSnapshotCaptureOutcome::Captured { .. });
        assert!(
            if is_captured {
                is_outcome_captured
            } else {
                is_refused
            },
            "got {outcome:?}"
        );
    }
    if !is_captured {
        assert!(!owner.exists(), "no capture folder is made");
        assert_eq!(files_with_bytes(&git_folder), before);
    }
    let expected_reports = usize::from(!is_captured);
    assert_eq!(reports.load(Ordering::SeqCst), expected_reports);
}

// Fails when a file over the size bound is hashed into the snapshot, when the bound is read as
// `>=` so a file of exactly the bound is left out, or when the left-out file goes unnamed in the
// commit's trailer, where a restore reads it.
#[tokio::test]
async fn a_file_over_the_size_bound_is_left_out_of_a_turn_snapshot_and_named() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    for (name, size) in [
        ("big.bin", LARGE_FILE_BYTES + 1),
        ("edge.bin", LARGE_FILE_BYTES),
    ] {
        File::create(repository.join(name))
            .and_then(|file| file.set_len(size))
            .expect("the sized file is made");
    }
    let database = TestDatabase::new(schema_parts());
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");

    let outcome = service
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, minted_run_id(), 0))
        .await;

    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit, ..
    } = outcome
    else {
        panic!("the turn is captured, got {outcome:?}");
    };
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let listing = ["ls-tree", "--name-only", snapshot_commit.as_str()];
    assert_eq!(
        answer_with_captures(&git, &repository, &capture_folder, &listing).await,
        "edge.bin"
    );
    let commit = ["cat-file", "commit", snapshot_commit.as_str()];
    let message = answer_with_captures(&git, &repository, &capture_folder, &commit).await;
    assert!(
        message.ends_with("\n\nLeft-Out-Paths: [\"big.bin\"]"),
        "got {message:?}"
    );
}

// What a failing capture takes.
#[derive(Clone, Copy, Debug)]
enum FailedCapture {
    // A workflow run's start.
    WorkflowRunStart,
    // A read of a workflow run's checkout.
    CheckoutRead,
}

// Fails when the cause is dropped from the outcome or taken from another failure than the step's,
// when the read's start answers its step without its cause, or when a checkout the live tree
// disagrees with is captured anyway, recording a wrong tree as the run's: the subfolder is not the
// top level of the tree holding the execution root.
#[rstest]
#[case::a_workflow_runs_start(FailedCapture::WorkflowRunStart)]
#[case::a_checkout_read(FailedCapture::CheckoutRead)]
#[tokio::test]
async fn a_capture_the_live_tree_disagrees_with_fails_naming_its_cause_and_writes_nothing(
    #[case] captured: FailedCapture,
) {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let subfolder = repository.join("nested");
    std::fs::create_dir(&subfolder).expect("the subfolder is made");
    let database = TestDatabase::new(schema_parts());
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");
    let checkout = CheckoutCaptureInput {
        checkout_root: subfolder,
        ..checkout_of(&repository, &owner)
    };

    let (failed_step, cause) = match captured {
        FailedCapture::WorkflowRunStart => {
            let input = TurnSnapshotCaptureInput {
                checkout,
                point: RunSnapshotPoint::WorkflowRun {
                    workflow_run_id: minted_workflow_run_id(),
                    point: WorkflowRunSnapshotPoint::Start { epoch: epoch(0) },
                },
            };
            match service.capture_turn_snapshot(None, &input).await {
                TurnSnapshotCaptureOutcome::Failed {
                    failed_step, cause, ..
                } => (failed_step, cause),
                outcome @ (TurnSnapshotCaptureOutcome::Captured { .. }
                | TurnSnapshotCaptureOutcome::AlreadyCaptured { .. }) => {
                    panic!("the capture fails, got {outcome:?}")
                }
            }
        }
        FailedCapture::CheckoutRead => {
            let read = service
                .capture_checkout_tree(None, minted_workflow_run_id(), &checkout)
                .await;
            match read {
                CheckoutTreeOutcome::Failed { failed_step, cause } => (failed_step, cause),
                outcome @ CheckoutTreeOutcome::Captured { .. } => {
                    panic!("the read fails, got {outcome:?}")
                }
            }
        }
    };

    assert_eq!(failed_step, CaptureStep::VerifyCheckoutRoot);
    assert!(
        cause.contains("not the working tree holding the execution root"),
        "got {cause:?}"
    );
    assert!(!owner.exists(), "no capture folder is made");
}

// Fails when the tree and the commit are swapped or one is answered for both, when the base is not
// the repository's `HEAD` and the commit's parent (a sweep would keep nothing on it), when the read
// writes a ref, when its pack is dropped (the untracked file's blob, which only the repository
// held, is then gone once the repository prunes it), or when the same checkout read again answers
// another tree.
#[tokio::test]
async fn a_checkout_read_writes_its_tree_and_no_ref_and_keeps_what_it_borrows() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, base) = repository_with_a_commit(&git, root.path()).await;
    tokio::fs::write(repository.join("notes.txt"), "a note\n")
        .await
        .expect("the untracked file is written");
    // Its blob is in the repository's objects and reached by nothing there.
    write_in(&git, &repository, &["add", "notes.txt"]).await;
    write_in(
        &git,
        &repository,
        &["rm", "--cached", "--quiet", "notes.txt"],
    )
    .await;
    let database = TestDatabase::new(schema_parts());
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");
    let checkout = checkout_of(&repository, &owner);
    let workflow_run_id = minted_workflow_run_id();

    let first = service
        .capture_checkout_tree(None, workflow_run_id, &checkout)
        .await;

    let CheckoutTreeOutcome::Captured {
        tree,
        snapshot_commit,
        base_commit,
    } = first
    else {
        panic!("the checkout is read, got {first:?}");
    };
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let with_captures = async |arguments: &[&str]| {
        answer_with_captures(&git, &repository, &capture_folder, arguments).await
    };
    assert_eq!(
        with_captures(&["cat-file", "-t", tree.as_str()]).await,
        "tree"
    );
    let commit_tree = format!("{}^{{tree}}", snapshot_commit.as_str());
    assert_eq!(
        with_captures(&["rev-parse", &commit_tree]).await,
        tree.as_str()
    );
    let parent = format!("{}^", snapshot_commit.as_str());
    assert_eq!(with_captures(&["rev-parse", &parent]).await, base);
    assert_eq!(
        base_commit.as_ref().map(GitObjectId::as_str),
        Some(base.as_str())
    );
    let refs = answer_in_git_folder(&git, capture_folder.folder(), &["for-each-ref"], &[]).await;
    assert_eq!(refs, "", "a read writes no ref");
    write_in(&git, &repository, &["gc", "--prune=now", "--quiet"]).await;
    let blob = format!("{}:notes.txt", tree.as_str());
    let kept = ["cat-file", "-p", blob.as_str()];
    assert_eq!(
        answer_in_git_folder(&git, capture_folder.folder(), &kept, &[]).await,
        "a note",
        "the folder alone holds what the read borrowed"
    );
    let again = service
        .capture_checkout_tree(None, workflow_run_id, &checkout)
        .await;
    assert!(
        matches!(&again, CheckoutTreeOutcome::Captured { tree: read_again, .. }
            if *read_again == tree),
        "the same checkout answers the same tree, got {again:?}"
    );
}

// Fails when the capture folder lacks `gc.pruneExpire=never`: the cruft repack the maintenance's
// geometric task falls back to then expires the aged reads, which no ref reaches. Two reads of one
// shape leave two packs of one weight, which the task rolls up whole, the path that expires.
#[tokio::test]
async fn a_capture_folder_keeps_a_capture_with_no_ref_through_a_maintenance_run() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let database = TestDatabase::new(schema_parts());
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");
    let checkout = checkout_of(&repository, &owner);
    let workflow_run_id = minted_workflow_run_id();
    let mut reads = Vec::new();
    for state in ["first\n", "second\n"] {
        tokio::fs::write(repository.join("notes.txt"), state)
            .await
            .expect("the file is written");
        let outcome = service
            .capture_checkout_tree(None, workflow_run_id, &checkout)
            .await;
        let CheckoutTreeOutcome::Captured {
            tree,
            snapshot_commit,
            ..
        } = outcome
        else {
            panic!("the checkout is read, got {outcome:?}");
        };
        reads.push((tree, snapshot_commit));
    }
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let folder = capture_folder.folder();
    let aged = SystemTime::now() - Duration::from_hours(30 * 24);
    for (path, _) in files_with_bytes(&folder.join(OBJECTS_SEGMENT)) {
        std::fs::set_times(&path, FileTimes::new().set_modified(aged))
            .expect("the object file is aged");
    }

    let maintenance = ["maintenance", "run", "--task=geometric-repack", "--quiet"];
    answer_in_git_folder(&git, folder, &maintenance, &[]).await;

    for (tree, snapshot_commit) in &reads {
        for object in [tree, snapshot_commit] {
            // Nothing attached, so only the folder's own objects read; a missing one fails git.
            answer_in_git_folder(&git, folder, &["cat-file", "-e", object.as_str()], &[]).await;
        }
    }
}
