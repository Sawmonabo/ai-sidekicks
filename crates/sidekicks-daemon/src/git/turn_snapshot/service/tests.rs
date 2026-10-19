use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use rstest::rstest;
use sidekicks_contracts::run::id::RunId;

use super::{
    TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY, TurnSnapshotCaptureInput, TurnSnapshotCaptureOutcome,
    TurnSnapshotPruneOutcome, TurnSnapshotService,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::git::process::{
    GitCall, GitRunner, in_folder, read_git_common_folder, strip_line_end, test_git_runner,
};
use crate::git::turn_snapshot::diagnostics::TurnSnapshotRetentionSkipReason;
use crate::git::turn_snapshot::refs::build_run_snapshot_ref_prefix;
use crate::git::turn_snapshot::retention::RunContextKey;
use crate::git::worktree::test_rows::{RunContextRow, insert_worktree_rows};
use crate::uuid_v7::mint_uuid_v7;

const ENDED_AT: &str = "2026-10-19T10:00:00.000Z";

// What `call` printed, its line end dropped.
async fn answer(git: &GitRunner, call: GitCall) -> String {
    let output = git.run(None, call).await.expect("git answers");
    String::from_utf8(strip_line_end(output.stdout)).expect("git answers in UTF-8")
}

fn utf8(path: &Path) -> &str {
    path.to_str().expect("the temporary folder's path is UTF-8")
}

// A repository under `root` with one commit of the empty tree on its branch, its own config
// keeping the person's hooks and commit signing out of every write: the repository and the
// commit.
async fn repository_with_a_commit(git: &GitRunner, root: &Path) -> (PathBuf, String) {
    let repository = root.join("repository");
    git.run(
        None,
        GitCall::write([OsString::from("init"), repository.clone().into()]),
    )
    .await
    .expect("the repository is made");
    let hooks = root.join("hooks");
    for setting in [
        ["core.hooksPath", utf8(&hooks)],
        ["commit.gpgSign", "false"],
    ] {
        let arguments = in_folder(&repository, &["config", setting[0], setting[1]]);
        git.run(None, GitCall::read(arguments))
            .await
            .expect("the setting is written");
    }
    let tree = answer(git, GitCall::read(in_folder(&repository, &["write-tree"]))).await;
    let arguments = in_folder(&repository, &["commit-tree", &tree, "-F", "-"]);
    let committing = GitCall::write(arguments)
        .with_environment("GIT_AUTHOR_NAME", "Test")
        .with_environment("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .with_environment("GIT_COMMITTER_NAME", "Test")
        .with_environment("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .with_input(b"first\n".to_vec());
    let commit = answer(git, committing).await;
    write_in(git, &repository, &["update-ref", "HEAD", &commit]).await;
    (repository, commit)
}

async fn write_in(git: &GitRunner, repository: &Path, arguments: &[&str]) {
    git.run(None, GitCall::write(in_folder(repository, arguments)))
        .await
        .expect("the test's write succeeds");
}

fn service_reading(git: GitRunner, database: &TestDatabase, root: &Path) -> TurnSnapshotService {
    let reads = DatabaseReadPool::new(database.path(), TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY);
    TurnSnapshotService::new(git, Arc::new(reads), &root.join("execution-roots"))
}

// Fails when one project state at one turn end gives two snapshot ids, when the untracked
// file is left out, or when a second capture of a turn moves its ref instead of reporting the
// first snapshot.
#[tokio::test]
async fn one_state_gives_one_id_and_a_turn_is_captured_once() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, base) = repository_with_a_commit(&git, root.path()).await;
    tokio::fs::write(repository.join("notes.txt"), "a note\n")
        .await
        .expect("the untracked file is written");
    let database = TestDatabase::new();
    let service = service_reading(git.clone(), &database, root.path());
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let turn = |turn_ordinal| TurnSnapshotCaptureInput {
        execution_root: repository.clone(),
        checkout_root: repository.clone(),
        run_id,
        epoch: 0,
        turn_ordinal,
        turn_ended_at: Timestamp::from_second(1_800_000_000).expect("the instant is in range"),
    };

    let first = service.capture_turn_snapshot(None, &turn(0)).await;
    let second = service.capture_turn_snapshot(None, &turn(1)).await;
    let again = service.capture_turn_snapshot(None, &turn(0)).await;

    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit,
        base_commit,
        ..
    } = first
    else {
        panic!("the first turn is captured, got {first:?}");
    };
    assert_eq!(base_commit.as_str(), base);
    let listed = in_folder(
        &repository,
        &["ls-tree", "--name-only", snapshot_commit.as_str()],
    );
    assert_eq!(answer(&git, GitCall::read(listed)).await, "notes.txt");
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

// Fails when an unended run's refs or a removed repository's are touched or misreported, when
// a symref planted under the run's prefix takes the branch it names with it, or when any ref
// under the prefix is left behind.
#[rstest]
#[case::an_unended_run_is_skipped(None, true, Some(TurnSnapshotRetentionSkipReason::RunNotEnded))]
#[case::an_absent_git_folder_is_skipped(
    Some(ENDED_AT),
    false,
    Some(TurnSnapshotRetentionSkipReason::GitDirAbsent)
)]
#[case::a_planted_symref_goes_and_its_branch_stays(Some(ENDED_AT), true, None)]
#[tokio::test]
async fn a_run_prune_deletes_every_ref_under_its_prefix_and_nothing_else(
    #[case] released_at: Option<&str>,
    #[case] is_git_folder_present: bool,
    #[case] skip_reason: Option<TurnSnapshotRetentionSkipReason>,
) {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let (repository, commit) = repository_with_a_commit(&git, root.path()).await;
    let git_common_dir = if is_git_folder_present {
        read_git_common_folder(&git, None, &repository)
            .await
            .expect("the repository's git folder is read")
    } else {
        root.path().join("removed").join(".git")
    };
    let run_key = RunContextKey::from(RunId::try_from(mint_uuid_v7()).expect("a run id"));
    let prefix = build_run_snapshot_ref_prefix(run_key);
    let plain_ref = format!("{prefix}epoch-0/turn-0");
    let planted_ref = format!("{prefix}epoch-0/turn-1");
    write_in(
        &git,
        &repository,
        &["update-ref", "refs/heads/kept", &commit],
    )
    .await;
    write_in(&git, &repository, &["update-ref", &plain_ref, &commit]).await;
    write_in(
        &git,
        &repository,
        &["symbolic-ref", &planted_ref, "refs/heads/kept"],
    )
    .await;
    let database = TestDatabase::new();
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
    let service = service_reading(git.clone(), &database, root.path());

    let pruned = service.prune_snapshots_for_run(None, run_key).await;

    let listing = in_folder(
        &repository,
        &["for-each-ref", "--format=%(refname)", &prefix],
    );
    let remaining = answer(&git, GitCall::read(listing)).await;
    if let Some(expected) = skip_reason {
        assert!(
            matches!(
                pruned,
                TurnSnapshotPruneOutcome::Skipped { reason, .. } if reason == expected
            ),
            "got {pruned:?}"
        );
        assert_eq!(
            remaining.lines().count(),
            2,
            "a skipped prune deletes nothing"
        );
    } else {
        let TurnSnapshotPruneOutcome::Pruned { mut deleted_refs } = pruned else {
            panic!("the ended run's refs are pruned, got {pruned:?}");
        };
        deleted_refs.sort();
        assert_eq!(deleted_refs, [plain_ref, planted_ref]);
        assert_eq!(remaining, "");
    }
    let kept = in_folder(&repository, &["rev-parse", "--verify", "refs/heads/kept"]);
    assert_eq!(answer(&git, GitCall::read(kept)).await, commit);
}
