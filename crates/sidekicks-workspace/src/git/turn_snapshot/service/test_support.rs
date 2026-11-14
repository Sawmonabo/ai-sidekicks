//! What the capture tests share: git answers read in a test, a repository with one commit, the
//! bytes of a folder, the inputs of a capture, and a turn-snapshot service over a test database.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY, TurnSnapshotCaptureInput, TurnSnapshotService,
};
use crate::git::process::{GitCall, GitRunner, in_folder, read_git_common_folder, strip_line_end};
use crate::git::turn_snapshot::capture::{CheckoutCaptureInput, GitFloorReports};
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, git_folder_argument};
use crate::git::turn_snapshot::refs::RunSnapshotPoint;
use crate::git::turn_snapshot::repack::CapturePacking;

/// The second every test capture is taken at.
const CAPTURED_SECOND: i64 = 1_800_000_000;

/// What `call` printed, its line end dropped. Panics when git fails.
pub(crate) async fn answer(git: &GitRunner, call: GitCall) -> String {
    let output = git.run(None, call).await.expect("git answers");
    String::from_utf8(strip_line_end(output.stdout)).expect("git answers in UTF-8")
}

/// What `arguments` against the git folder `folder` printed, run with `environment`. Panics when
/// git fails.
pub(crate) async fn answer_in_git_folder(
    git: &GitRunner,
    folder: &Path,
    arguments: &[&str],
    environment: &[(&str, &OsStr)],
) -> String {
    let mut call = GitCall::read(
        [git_folder_argument(folder)]
            .into_iter()
            .chain(arguments.iter().map(OsString::from)),
    );
    for (name, value) in environment {
        call = call.with_environment(*name, *value);
    }
    answer(git, call).await
}

/// What `arguments` in the repository `repository` printed, the capture folder attached so its
/// objects read. Panics when git fails.
pub(crate) async fn answer_with_captures(
    git: &GitRunner,
    repository: &Path,
    capture_folder: &CaptureFolder,
    arguments: &[&str],
) -> String {
    let mut call = GitCall::read(in_folder(repository, arguments));
    for (name, value) in capture_folder.read_environment() {
        call = call.with_environment(name, value);
    }
    answer(git, call).await
}

/// The temporary folder's path as text. Panics when it is not UTF-8.
pub(crate) fn utf8(path: &Path) -> &str {
    path.to_str().expect("the temporary folder's path is UTF-8")
}

/// `call` with the test's identity on the commit it writes.
pub(crate) fn as_the_test(call: GitCall) -> GitCall {
    call.with_environment("GIT_AUTHOR_NAME", "Test")
        .with_environment("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .with_environment("GIT_COMMITTER_NAME", "Test")
        .with_environment("GIT_COMMITTER_EMAIL", "test@example.invalid")
}

/// A repository under `root` with no commit, its own config keeping the person's hooks and commit
/// signing out of every write. Panics when git fails.
pub(crate) async fn repository_without_a_commit(git: &GitRunner, root: &Path) -> PathBuf {
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
    repository
}

/// A repository under `root` with one commit of the empty tree on its branch, as
/// [`repository_without_a_commit`] makes it: the repository and the commit. Panics when git fails.
pub(crate) async fn repository_with_a_commit(git: &GitRunner, root: &Path) -> (PathBuf, String) {
    let repository = repository_without_a_commit(git, root).await;
    let tree = answer(git, GitCall::read(in_folder(&repository, &["write-tree"]))).await;
    let arguments = in_folder(&repository, &["commit-tree", &tree, "-F", "-"]);
    let commit = answer(
        git,
        as_the_test(GitCall::write(arguments)).with_input(b"first\n".to_vec()),
    )
    .await;
    write_in(git, &repository, &["update-ref", "HEAD", &commit]).await;
    (repository, commit)
}

/// Runs the write `arguments` in `repository`. Panics when git fails.
pub(crate) async fn write_in(git: &GitRunner, repository: &Path, arguments: &[&str]) {
    git.run(None, GitCall::write(in_folder(repository, arguments)))
        .await
        .expect("the test's write succeeds");
}

/// Every file under `folder` with its bytes, by path. Panics when a file does not read.
pub(crate) fn files_with_bytes(folder: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).expect("the folder lists") {
            let path = entry.expect("the entry reads").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let bytes = std::fs::read(&path).expect("the file reads");
                files.push((path, bytes));
            }
        }
    }
    files.sort();
    files
}

/// A turn-snapshot service running `git`, reading `database`, holding checkouts in
/// `checkout_lock` and packing through `packing`.
pub(crate) fn service_reading(
    git: GitRunner,
    database: &TestDatabase,
    checkout_lock: Arc<KeyedLock<PathBuf>>,
    packing: Arc<CapturePacking>,
) -> TurnSnapshotService {
    let reads = DatabaseReadPool::new(database.path(), TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY);
    let floor_reports = Arc::new(GitFloorReports::default());
    TurnSnapshotService::new(git, Arc::new(reads), checkout_lock, packing, floor_reports)
}

/// The checkout `repository`, its own top level, owned by `owner` and captured at the test's
/// second.
pub(crate) fn checkout_of(repository: &Path, owner: &Path) -> CheckoutCaptureInput {
    CheckoutCaptureInput {
        owner_folder: owner.to_path_buf(),
        execution_root: repository.to_path_buf(),
        checkout_root: repository.to_path_buf(),
        captured_at: Timestamp::from_second(CAPTURED_SECOND).expect("the instant is in range"),
    }
}

/// A snapshot at `point` of the checkout `repository`, owned by `owner`.
pub(crate) fn point_of(
    repository: &Path,
    owner: &Path,
    point: RunSnapshotPoint,
) -> TurnSnapshotCaptureInput {
    TurnSnapshotCaptureInput {
        checkout: checkout_of(repository, owner),
        point,
    }
}

/// Turn `turn_ordinal` of `run_id` in epoch 0 at the checkout `repository`, owned by `owner`.
pub(crate) fn turn_of(
    repository: &Path,
    owner: &Path,
    run_id: RunId,
    turn_ordinal: u64,
) -> TurnSnapshotCaptureInput {
    let point = RunSnapshotPoint::Turn {
        run_id,
        epoch: 0,
        ordinal: turn_ordinal,
    };
    point_of(repository, owner, point)
}

/// A fresh run id.
pub(crate) fn minted_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

/// A fresh workflow run id.
pub(crate) fn minted_workflow_run_id() -> WorkflowRunId {
    WorkflowRunId::try_from(mint_uuid_v7()).expect("a minted UUID is a workflow run id")
}

/// The owner's capture folder for the repository at `repository`, which a capture made. Panics
/// when there is none.
pub(crate) async fn made_capture_folder(
    git: &GitRunner,
    owner: &Path,
    repository: &Path,
) -> CaptureFolder {
    let git_common_folder = read_git_common_folder(git, None, repository, None)
        .await
        .expect("the repository's git folder is read");
    let packing = CapturePacking::new(git.clone(), Arc::default());
    CaptureFolder::open_existing(&packing, owner, &git_common_folder)
        .await
        .expect("the capture folder is looked for")
        .expect("a capture made the capture folder")
}
