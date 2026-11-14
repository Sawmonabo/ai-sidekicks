use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use notify::NullWatcher;
use rusqlite::params;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::folders::{
    RepoMountMoveRequest, RepoMountReattachConflictDetails, RepoMountReattachResponse,
    RepoMountRequest,
};
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::RunningHolder;
use sidekicks_ipc::domain_error::{DomainError, refusal_fields};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::data_folder::session_storage_folder;

use super::{
    RepoMountReattachError, RepoMountReattachService, RepoMountReattachServiceDeps,
    RunningHolderLookup, RunningHolderLookupError,
};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::execution_root::test_fixture::{ExecutionRootFixture, MOUNT_ID, SESSION_ID};
use crate::git::process::test_repository::{commit_empty, git_in, make_test_repository};
use crate::git::process::{GitCall, GitRunner, test_git_runner};
use crate::git::turn_snapshot::capture::GitFloorReports;
use crate::git::turn_snapshot::capture_folder::{
    CAPTURES_SEGMENT, CaptureFolder, git_folder_argument, real_path_name,
};
use crate::git::turn_snapshot::repack::CapturePacking;
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::repo::root_resolver::RepoRootResolver;
use crate::test_rows::PARENT_ROWS_AT;

const MANAGED_MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e90";
const LISTED_TREE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e91";
const UNLISTED_TREE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e92";
const RUNNING_AGENT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e93";
const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e94";

/// Answers every run as an agent's run for [`RUNNING_AGENT_ID`].
struct FixedRunAgent;

impl RunningHolderLookup for FixedRunAgent {
    fn read_running_holder<'a>(
        &'a self,
        _session_id: &'a SessionId,
        _run_id: &'a str,
    ) -> BoxFuture<'a, Result<RunningHolder, RunningHolderLookupError>> {
        async { Ok(running_holder()) }.boxed()
    }
}

fn running_holder() -> RunningHolder {
    RunningHolder::Agent {
        agent_id: AgentId::new(RUNNING_AGENT_ID).expect("the id is a UUID"),
    }
}

/// The re-attach over the execution roots' fixture, whose mount records the repository's common
/// folder as its anchor.
struct ReattachFixture {
    roots: ExecutionRootFixture,
    service: Arc<RepoMountReattachService<NullWatcher>>,
}

impl ReattachFixture {
    async fn new() -> Self {
        let roots = ExecutionRootFixture::new().await;
        roots
            .rows
            .execute(
                "UPDATE repo_mounts SET metadata = json_set(metadata, '$.commonDir', ?1) \
                 WHERE id = ?2",
                params![roots.repository.join(".git").to_string_lossy(), MOUNT_ID],
            )
            .expect("the mount records its anchor");
        let service = Arc::new(RepoMountReattachService::new(
            RepoMountReattachServiceDeps {
                writer: Arc::clone(&roots.log.writer),
                reads: Arc::clone(&roots.reads),
                workspaces: Arc::clone(&roots.workspaces),
                execution_roots: Arc::clone(&roots.service),
                events: Arc::new(WorkspaceEventEmitter::new(Arc::clone(&roots.log.service))),
                worktree_events: Arc::new(WorktreeEventEmitter::new(Arc::clone(
                    &roots.log.service,
                ))),
                resolver: RepoRootResolver::new(test_git_runner()),
                holders: Arc::new(FixedRunAgent),
                packing: Arc::new(CapturePacking::new(
                    test_git_runner(),
                    Arc::new(GitFloorReports::default()),
                )),
                data_folder: roots.scratch.path().join("data"),
                common_folder_columns: Vec::new(),
                attach_notice: Arc::default(),
            },
        ));
        Self { roots, service }
    }

    async fn reattach(
        &self,
        repo_mount_id: &str,
    ) -> Result<RepoMountReattachResponse, RepoMountReattachError> {
        self.service
            .reattach(&RepoMountRequest {
                repo_mount_id: RepoMountId::new(repo_mount_id).expect("the id is a UUID"),
            })
            .await
    }

    async fn move_to(
        &self,
        repo_mount_id: &str,
        folder: &Path,
    ) -> Result<RepoMountReattachResponse, RepoMountReattachError> {
        self.service
            .move_to_folder(&RepoMountMoveRequest {
                repo_mount_id: RepoMountId::new(repo_mount_id).expect("the id is a UUID"),
                local_path: FilesystemPath::new(folder.to_string_lossy().into_owned())
                    .expect("the path is short"),
                place: None,
            })
            .await
    }

    fn text(&self, sql: &str) -> Option<String> {
        self.roots
            .rows
            .query_row(sql, [], |row| row.get(0))
            .expect("the test reads a row")
    }

    /// Every mount row, every workspace's mount and the event count, which a refusal leaves as
    /// they were.
    fn written(&self) -> (i64, Option<String>, i64) {
        (
            self.roots
                .count("SELECT count(*) FROM repo_mounts WHERE state = 'attached'"),
            self.text("SELECT group_concat(repo_mount_id) FROM workspaces"),
            self.roots.count("SELECT count(*) FROM session_events"),
        )
    }
}

fn refusal(error: RepoMountReattachError) -> DomainError {
    match HandlerError::from(error) {
        HandlerError::Refused(refusal) => refusal,
        other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
            panic!("the re-attach is refused, not {other:?}")
        }
    }
}

#[tokio::test]
async fn a_reattach_with_nothing_to_recover_is_refused_writing_nothing() {
    // Catches the `identityMismatch` check dropped: the healthy mount's re-attach would commit.
    let fixture = ReattachFixture::new().await;
    fixture.roots.bind().await;
    fixture
        .roots
        .rows
        .execute(
            "INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, origin, \
             managed_session_id, attached_at, updated_at) VALUES (?1, 'machine', '/chats/one', \
             '/chats/one', 'managed', ?2, ?3, ?3)",
            params![MANAGED_MOUNT_ID, SESSION_ID, PARENT_ROWS_AT],
        )
        .expect("a chat's managed mount is stored");
    let before = fixture.written();

    let healthy = refusal(
        fixture
            .reattach(MOUNT_ID)
            .await
            .expect_err("nothing to recover"),
    );
    assert_eq!(healthy.code, RefusalCode::RepoMountReattachRefused);

    let managed = refusal(
        fixture
            .reattach(MANAGED_MOUNT_ID)
            .await
            .expect_err("a managed mount is never re-attached"),
    );
    assert_eq!(managed.code, RefusalCode::RepoMountManaged);

    std::fs::remove_dir_all(fixture.roots.repository.join(".git")).expect("the repository goes");
    let gone = refusal(
        fixture
            .reattach(MOUNT_ID)
            .await
            .expect_err("a folder that is no repository has nothing to attach"),
    );
    assert_eq!(gone.code, RefusalCode::RepoMountRootResolutionFailed);
    assert_eq!(
        gone.detail.and_then(|detail| detail.get("reason").cloned()),
        Some("notARepository".into())
    );

    // The folder becomes a linked tree of another repository, whose main checkout is elsewhere.
    std::fs::remove_dir_all(&fixture.roots.repository).expect("the folder goes");
    let scratch = fixture
        .roots
        .repository
        .parent()
        .expect("the repository sits in the scratch folder");
    let other = make_test_repository(&fixture.roots.git, scratch, "other").await;
    git_in(
        &fixture.roots.git,
        &other,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "moved",
            &fixture.roots.repository.to_string_lossy(),
        ],
    )
    .await;
    let moved = refusal(
        fixture
            .reattach(MOUNT_ID)
            .await
            .expect_err("a folder that resolves to another root is not this mount's"),
    );
    assert_eq!(moved.code, RefusalCode::RepoMountRootResolutionFailed);
    assert_eq!(
        moved
            .detail
            .and_then(|detail| detail.get("reason").cloned()),
        Some("rootMismatch".into())
    );

    assert_eq!(fixture.written(), before);
}

#[tokio::test]
async fn a_reattach_moves_the_workspaces_and_listed_trees_and_retires_the_rest() {
    // Catches the listed trees' move dropped: the listed tree would stay on the old mount and be
    // retired with the unlisted one.
    let fixture = ReattachFixture::new().await;
    let workspace_id = fixture.roots.bind().await;
    fixture
        .roots
        .prepare(workspace_id, None)
        .await
        .expect("the workspace roots at the repository");
    let unlisted = fixture.roots.add_tree("old-tree").await;
    let common_folder = fixture.roots.replace_repository().await;
    let listed = fixture.roots.add_tree("new-tree").await;
    for (id, branch, folder) in [
        (LISTED_TREE_ID, "new-tree", &listed),
        (UNLISTED_TREE_ID, "old-tree", &unlisted),
    ] {
        fixture
            .roots
            .rows
            .execute(
                "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
                 base_ref, fs_root, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, \
                 'main', ?5, 'ready', ?6, ?6)",
                params![
                    id,
                    MOUNT_ID,
                    SESSION_ID,
                    branch,
                    folder.to_string_lossy(),
                    PARENT_ROWS_AT
                ],
            )
            .expect("the daemon's tree is recorded");
    }

    let response = fixture
        .reattach(MOUNT_ID)
        .await
        .expect("the mount is re-attached");

    let new_mount = response.repo_mount_id.text().as_str().to_owned();
    assert_ne!(new_mount, MOUNT_ID);
    assert_eq!(
        fixture.text(&format!(
            "SELECT state FROM repo_mounts WHERE id = '{MOUNT_ID}'"
        )),
        Some("detached".to_owned())
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT json_extract(metadata, '$.commonDir') FROM repo_mounts \
             WHERE id = '{new_mount}' AND state = 'attached' AND project_id = '{MOUNT_ID}'"
        )),
        Some(common_folder.to_string_lossy().into_owned())
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT repo_mount_id || ' ' || state FROM workspaces WHERE id = '{workspace_id}'"
        )),
        Some(format!("{new_mount} ready"))
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT repo_mount_id || ' ' || state FROM worktrees WHERE id = '{LISTED_TREE_ID}'"
        )),
        Some(format!("{new_mount} ready"))
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT repo_mount_id || ' ' || state || ' ' || (cleaned_at IS NOT NULL) \
             FROM worktrees WHERE id = '{UNLISTED_TREE_ID}'"
        )),
        Some(format!("{MOUNT_ID} retired 1"))
    );
    assert!(unlisted.exists(), "a retired tree's folder stays on disk");
    assert_eq!(
        fixture.roots.count(&format!(
            "SELECT count(*) FROM session_events WHERE type = 'worktree.retired' \
             AND json_extract(payload, '$.worktreeId') = '{UNLISTED_TREE_ID}'"
        )),
        1
    );
}

#[tokio::test]
async fn a_run_that_starts_after_the_checks_refuses_the_write_naming_its_agent() {
    // Catches the running check's expected count of zero dropped from the write: the re-attach
    // would commit under the run that started after its read.
    let fixture = ReattachFixture::new().await;
    let workspace_id: WorkspaceId = fixture.roots.bind().await;
    fixture.roots.replace_repository().await;
    let before = fixture.written();
    let paused = fixture.service.write_pause.arm();
    let reattach = tokio::spawn({
        let service = Arc::clone(&fixture.service);
        async move {
            service
                .reattach(&RepoMountRequest {
                    repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
                })
                .await
        }
    });
    paused
        .reached
        .await
        .expect("the re-attach passed its checks");

    fixture
        .roots
        .rows
        .execute_batch(&format!(
            "INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at, \
             updated_at) VALUES ('branch-context', '{workspace_id}', 'main', 'main', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');
             INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
             execution_mode, execution_root, checkout_root, git_common_dir, branch_context_id, \
             created_at) VALUES ('{RUN_ID}', '{SESSION_ID}', '{workspace_id}', 'boundRoot', \
             '/repos/app', '/repos/app', '/repos/app/.git', 'branch-context', \
             '{PARENT_ROWS_AT}')"
        ))
        .expect("the run starts");
    paused
        .release
        .send(())
        .expect("the re-attach waits at its pause");
    let refused = refusal(
        reattach
            .await
            .expect("the re-attach's task ends")
            .expect_err("the run holds the project"),
    );

    assert_eq!(refused.code, RefusalCode::RepoMountReattachConflict);
    assert_eq!(
        refused.detail,
        Some(Box::new(refusal_fields(RepoMountReattachConflictDetails {
            running_session_id: SessionId::new(SESSION_ID).expect("the id is a UUID"),
            running_holder: running_holder(),
        })))
    );
    assert_eq!(fixture.written(), before);
}

#[tokio::test]
async fn a_lost_mount_follows_its_repository_keeping_every_id_and_refuses_another() {
    // Catches the repository check dropped or keyed on the folder: another repository's folder
    // would take the project; and the checkout's paths or the trees' links left at the old root:
    // the workspace or the tree would turn `rootLost` or retired.
    let fixture = ReattachFixture::new().await;
    let git = &fixture.roots.git;
    let workspace_id = fixture.roots.bind().await;
    fixture
        .roots
        .prepare(workspace_id, None)
        .await
        .expect("the workspace roots at the repository");
    let tree = fixture.roots.add_tree("session-tree").await;
    fixture
        .roots
        .rows
        .execute(
            "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
             base_ref, fs_root, state, created_at, updated_at) VALUES (?1, ?2, ?3, \
             'session-tree', 'main', ?4, 'ready', ?5, ?5)",
            params![
                LISTED_TREE_ID,
                MOUNT_ID,
                SESSION_ID,
                tree.to_string_lossy(),
                PARENT_ROWS_AT
            ],
        )
        .expect("the daemon's tree is recorded");
    let repository = fixture.roots.repository.clone();
    let root_commit = git_in(git, &repository, &["rev-list", "--max-parents=0", "HEAD"]).await;
    fixture
        .roots
        .rows
        .execute(
            "UPDATE repo_mounts SET metadata = json_set(metadata, '$.rootCommit', ?1) \
             WHERE id = ?2",
            params![root_commit, MOUNT_ID],
        )
        .expect("the mount records its first commit");
    let scratch = repository
        .parent()
        .expect("the repository sits in the scratch folder")
        .to_path_buf();
    // Its own first commit, so it shares no history with the mount's repository.
    git_in(git, &scratch, &["init", "--quiet", "other"]).await;
    let other = scratch.join("other");
    for setting in [
        ["user.name", "Test"],
        ["user.email", "test@example.invalid"],
    ] {
        git_in(git, &other, &["config", setting[0], setting[1]]).await;
    }
    commit_empty(git, &other, "another project").await;

    // Moved away, another repository in its place: `identityMismatch`.
    let moved = scratch.join("moved");
    std::fs::rename(&repository, &moved).expect("the repository moves");
    make_test_repository(git, &scratch, "app").await;
    git_in(
        git,
        &repository,
        &[
            "init",
            "--quiet",
            "--separate-git-dir",
            &scratch.join("impostor.git").to_string_lossy(),
        ],
    )
    .await;
    let before = fixture.written();
    let refused = refusal(
        fixture
            .move_to(MOUNT_ID, &other)
            .await
            .expect_err("another repository is not the mount's"),
    );
    assert_eq!(refused.code, RefusalCode::RepoMountRepositoryDiffers);
    assert_eq!(fixture.written(), before);

    let mut mount = MOUNT_ID.to_owned();
    // Then moved again with nothing left behind: `unreachable`.
    for (from, to) in [
        (None, moved.clone()),
        (Some(moved), scratch.join("moved-again")),
    ] {
        if let Some(from) = from {
            std::fs::rename(&from, &to).expect("the repository moves again");
        }
        let response = fixture
            .move_to(&mount, &to)
            .await
            .expect("the mount follows its repository");
        let new_mount = response.repo_mount_id.text().as_str().to_owned();
        let to = to.to_string_lossy();
        assert_eq!(
            fixture.text(&format!(
                "SELECT canonical_root || ' ' || project_id FROM repo_mounts \
                 WHERE id = '{new_mount}' AND state = 'attached'"
            )),
            Some(format!("{to} {MOUNT_ID}"))
        );
        assert_eq!(
            fixture.text(&format!(
                "SELECT folder_path FROM projects WHERE id = '{MOUNT_ID}'"
            )),
            Some(to.clone().into_owned())
        );
        assert_eq!(
            fixture.text(&format!(
                "SELECT repo_mount_id || ' ' || state || ' ' || fs_root FROM workspaces \
                 WHERE id = '{workspace_id}'"
            )),
            Some(format!("{new_mount} ready {to}"))
        );
        assert_eq!(
            fixture.text(&format!(
                "SELECT repo_mount_id || ' ' || state FROM worktrees WHERE id = '{LISTED_TREE_ID}'"
            )),
            Some(format!("{new_mount} ready"))
        );
        assert_eq!(
            fixture.roots.count(&format!(
                "SELECT count(*) FROM session_events WHERE type = 'repoMount.health.changed' \
                 AND json_extract(payload, '$.repoMountId') = '{new_mount}' \
                 AND json_extract(payload, '$.health.status') = 'healthy'"
            )),
            1
        );
        mount = new_mount;
    }
}

// A capture taken before its repository moved is found and read at the new folder after the move,
// its run's context naming the new common folder; and so it is after a stop cut the move between
// its write and the carry, once the start's carry runs, whether the folder was renamed or not.
// Killed by the move's carry dropped (no folder at the new name), by the rows left unrewritten
// (the context names the old folder), by the record of the carry left unwritten or uncleared, and
// by a rename that replaces a folder already at the new name.
#[tokio::test]
async fn a_capture_taken_before_a_move_is_found_and_read_after_it() {
    let fixture = ReattachFixture::new().await;
    let git = &fixture.roots.git;
    let workspace_id = fixture.roots.bind().await;
    let repository = fixture.roots.repository.clone();
    let head = git_in(git, &repository, &["rev-parse", "HEAD"]).await;
    let root_commit = git_in(git, &repository, &["rev-list", "--max-parents=0", "HEAD"]).await;
    let old_common = repository.join(".git");
    fixture
        .roots
        .rows
        .execute_batch(&format!(
            "UPDATE repo_mounts SET metadata = json_set(metadata, '$.rootCommit', '{root_commit}') \
             WHERE id = '{MOUNT_ID}';
             INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at, \
             updated_at) VALUES ('branch-context', '{workspace_id}', 'main', 'main', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');
             INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
             execution_mode, execution_root, checkout_root, git_common_dir, branch_context_id, \
             created_at, released_at) VALUES ('{RUN_ID}', '{SESSION_ID}', '{workspace_id}', \
             'boundRoot', '{root}', '{root}', '{common}', 'branch-context', '{PARENT_ROWS_AT}', \
             '{PARENT_ROWS_AT}')",
            root = repository.to_string_lossy(),
            common = old_common.to_string_lossy(),
        ))
        .expect("the mount records its first commit and a past run its context");
    let owner = session_storage_folder(
        &fixture.roots.scratch.path().join("data"),
        &SessionId::new(SESSION_ID).expect("the id is a UUID"),
    );
    let captured_file = fixture.roots.scratch.path().join("captured.txt");
    std::fs::write(&captured_file, "the captured words").expect("the file is written");
    let capture_folder = CaptureFolder::open_or_create(git, None, &owner, &old_common)
        .await
        .expect("the capture folder is made");
    let blob = capture_git(
        git,
        &capture_folder,
        &["hash-object", "-w", &captured_file.to_string_lossy()],
    )
    .await;

    let moved = repository
        .parent()
        .expect("the repository sits in the scratch folder")
        .join("moved");
    std::fs::rename(&repository, &moved).expect("the repository moves");
    fixture
        .move_to(MOUNT_ID, &moved)
        .await
        .expect("the mount follows its repository");
    let new_common = moved.join(".git");
    let context =
        format!("SELECT git_common_dir FROM run_execution_contexts WHERE run_id = '{RUN_ID}'");
    let record = "SELECT count(*) FROM repo_mounts \
                  WHERE json_extract(metadata, '$.capturesMovedFrom') IS NOT NULL";
    let new_name = real_path_name(&new_common)
        .await
        .expect("the new common folder resolves");

    // As the move left it, then as a stop after its write leaves it, the folder renamed or not.
    for is_folder_renamed_back in [None, Some(false), Some(true)] {
        if let Some(is_folder_renamed_back) = is_folder_renamed_back {
            fixture
                .roots
                .rows
                .execute_batch(&format!(
                    "UPDATE repo_mounts SET metadata = json_set(metadata, \
                     '$.capturesMovedFrom', '{old}') WHERE state = 'attached';
                     UPDATE run_execution_contexts SET git_common_dir = '{old}'",
                    old = old_common.to_string_lossy(),
                ))
                .expect("the stop leaves the move's write alone");
            if is_folder_renamed_back {
                std::fs::rename(
                    owner.join(CAPTURES_SEGMENT).join(&new_name),
                    capture_folder.folder(),
                )
                .expect("the capture folder is as it was before the carry");
            }
            fixture
                .service
                .carry_moved_captures()
                .await
                .expect("the start's carry finishes the move");
        }
        assert_eq!(
            fixture.text(&context),
            Some(new_common.to_string_lossy().into_owned())
        );
        assert_eq!(fixture.roots.count(record), 0);
        let found = CaptureFolder::open_existing(&owner, &new_common)
            .await
            .expect("the captures folder reads")
            .expect("the capture folder is found at the new folder");
        assert_eq!(
            capture_git(git, &found, &["cat-file", "-p", &blob]).await,
            "the captured words"
        );
        assert_eq!(
            capture_git(git, &found, &["cat-file", "-t", &head]).await,
            "commit"
        );
    }

    // A folder already at the new name is never replaced.
    std::fs::create_dir_all(capture_folder.folder()).expect("a folder takes the old name");
    fixture
        .roots
        .rows
        .execute(
            "UPDATE repo_mounts SET metadata = json_set(metadata, '$.capturesMovedFrom', ?1) \
             WHERE state = 'attached'",
            params![old_common.to_string_lossy()],
        )
        .expect("a carry is owed again");
    fixture
        .service
        .carry_moved_captures()
        .await
        .expect_err("the new name is taken");
    assert_eq!(fixture.roots.count(record), 1);
}

// What git printed, trimmed, for `arguments` against the capture folder with the repository's
// objects attached. Panics when git fails.
async fn capture_git(
    git: &GitRunner,
    capture_folder: &CaptureFolder,
    arguments: &[&str],
) -> String {
    let mut call = GitCall::read(
        [git_folder_argument(capture_folder.folder())]
            .into_iter()
            .chain(arguments.iter().map(OsString::from)),
    );
    for (name, value) in capture_folder.write_environment() {
        call = call.with_environment(name, value);
    }
    let output = git.run(None, call).await.expect("git answers");
    String::from_utf8(output.stdout)
        .expect("git prints UTF-8")
        .trim()
        .to_owned()
}
