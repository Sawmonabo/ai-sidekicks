use std::ffi::OsString;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use jiff::Timestamp;
use rstest::rstest;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::test_support::{
    TURN_ENDED_SECOND, answer, answer_in_git_folder, answer_with_captures, as_the_test,
    files_with_bytes, made_capture_folder, minted_run_id, repository_with_a_commit,
    service_reading, turn_of, utf8, write_in,
};
use super::{TurnSnapshotCaptureOutcome, TurnSnapshotPruneOutcome};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitCall, GitRunner, in_folder, read_git_common_folder, test_git_runner};
use crate::git::turn_snapshot::capture::LARGE_FILE_BYTES;
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, git_folder_argument};
use crate::git::turn_snapshot::diagnostics::{CaptureStep, TurnSnapshotRetentionSkipReason};
use crate::git::turn_snapshot::refs::build_run_snapshot_ref_prefix;
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
    let packing = Arc::new(CapturePacking::new(git.clone()));
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

// Fails when an unended run's refs or an absent capture folder's are touched or misreported, when
// the prune is aimed at the repository instead of the owner's capture folder (the repository's
// ref of the same name goes, or the capture folder's stays), when a symref planted under the
// run's prefix takes the branch it names with it, or when any ref under the prefix is left
// behind; a second prune finds none.
#[rstest]
#[case::an_unended_run_is_skipped(None, true, Some(TurnSnapshotRetentionSkipReason::RunNotEnded))]
#[case::an_owner_without_a_capture_folder_is_skipped(
    Some(ENDED_AT),
    false,
    Some(TurnSnapshotRetentionSkipReason::GitDirAbsent)
)]
#[case::a_planted_symref_goes_and_its_branch_stays(Some(ENDED_AT), true, None)]
#[tokio::test]
async fn a_run_prune_deletes_every_ref_under_its_prefix_in_the_capture_folder_and_nothing_else(
    #[case] released_at: Option<&str>,
    #[case] is_capture_folder_made: bool,
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
        let capture_folder = CaptureFolder::open_or_create(&git, None, &owner, &git_common_dir)
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
        if capture_folder.is_some() {
            assert_eq!(
                remaining.lines().count(),
                2,
                "a skipped prune deletes nothing"
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
    let again = service.prune_snapshots_for_run(None, run_key, &owner).await;
    let is_empty_prune = matches!(
        &again,
        TurnSnapshotPruneOutcome::Pruned { deleted_refs } if deleted_refs.is_empty()
    );
    assert!(
        is_empty_prune,
        "a second prune finds nothing, got {again:?}"
    );
}

// Fails when a ref under the snapshot prefix that no capture writes is listed, when a listed
// turn's ordinal, commit or time is misread, or when an owner with no capture folder answers
// anything but an empty list.
#[tokio::test]
async fn the_list_answers_each_captured_turn_and_nothing_else() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, _) = repository_with_a_commit(&git, root.path()).await;
    let database = TestDatabase::new(schema_parts());
    let service = service_over(&git, &database, Arc::new(KeyedLock::new()));
    let owner = root.path().join("owner");
    let run_id = minted_run_id();
    let mut snapshot_commits = Vec::new();
    for turn_ordinal in [0, 1] {
        let input = turn_of(&repository, &owner, run_id, turn_ordinal);
        let outcome = service.capture_turn_snapshot(None, &input).await;
        let TurnSnapshotCaptureOutcome::Captured {
            snapshot_commit, ..
        } = outcome
        else {
            panic!("the turn is captured, got {outcome:?}");
        };
        snapshot_commits.push(snapshot_commit.as_str().to_owned());
    }
    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    let prefix = build_run_snapshot_ref_prefix(RunContextKey::from(run_id));
    for stray_ref in [
        "refs/heads/elsewhere".to_owned(),
        format!("{prefix}epoch-0/other"),
    ] {
        let arguments = [
            "update-ref",
            stray_ref.as_str(),
            snapshot_commits[0].as_str(),
        ];
        answer_in_git_folder(&git, capture_folder.folder(), &arguments, &[]).await;
    }
    let git_common_dir = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");

    let listed = service
        .list_turn_snapshots(None, &owner, &git_common_dir)
        .await
        .expect("the snapshots are listed");
    let unowned = service
        .list_turn_snapshots(None, &root.path().join("another-owner"), &git_common_dir)
        .await
        .expect("an owner with no folder lists");

    let turn_ended_at = WireInstant::from_timestamp(
        Timestamp::from_second(TURN_ENDED_SECOND).expect("the instant is in range"),
    )
    .expect("the instant writes");
    let read: Vec<_> = listed
        .iter()
        .map(|entry| {
            (
                entry.run_id,
                entry.epoch,
                entry.turn_ordinal,
                entry.snapshot_commit.as_str(),
                entry.created_at.as_str(),
            )
        })
        .collect();
    assert_eq!(
        read,
        [
            (
                run_id,
                0,
                0,
                snapshot_commits[0].as_str(),
                turn_ended_at.as_str()
            ),
            (
                run_id,
                0,
                1,
                snapshot_commits[1].as_str(),
                turn_ended_at.as_str()
            ),
        ]
    );
    assert!(unowned.is_empty(), "got {unowned:?}");
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
    let old_git = git.reading_version_as(version_output, true).await;
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
