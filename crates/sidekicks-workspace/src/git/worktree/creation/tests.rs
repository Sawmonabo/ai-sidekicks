use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::NullWatcher;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::machine::settings::{BranchNamePattern, BranchNamePatternChange};
use sidekicks_contracts::project::ProjectSetup;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_contracts::worktree::setup::{WorktreeSetupStage, WorktreeSetupStatus};
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;

use super::{
    CreateWorktreeInput, LiveRunFolder, LiveRunFolderReadError, LiveRunFolderReader, NameCollision,
    WorktreeCreationError, WorktreeCreator, WorktreeCreatorDeps, WorktreeNameRequest,
};
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::process::{GitRunner, test_git_runner};
use crate::git::worktree::errors::{WorktreeCreateFailureReason, WorktreeRefusal};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::naming::{
    WorktreeNameBase, WorktreeNamePlan, WorktreeNaming, WorktreeNamingError, WorktreeNamingSources,
    WorktreeProjectNaming, short_id_of,
};
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::reads::has_branch;
use crate::git::worktree::rows::{AttachedMountRow, LIVE_WORKTREE_STATE_PREDICATE};
use crate::git::worktree::schema::schema_parts;
use crate::git::worktree::service::{WorktreeService, WorktreeServiceDeps};
use crate::git::worktree::setup::test_runner::test_setup_runner;
use crate::git::worktree::setup::{WorktreeSetupError, WorktreeSetupRunner, WorktreeSetupSources};
use crate::test_rows::project_and_mount_rows;

const READ_STATEMENT_CAPACITY: usize = 16;

// Every tree is named by the title alone, so a test reads its branch as the tail it gave.
const PATTERN: &str = "{title}";

fn pattern() -> BranchNamePattern {
    BranchNamePattern::new(
        BranchNamePatternChange::new(PATTERN.to_owned()).expect("a bounded pattern"),
    )
    .expect("a pattern holding {title}")
}

/// The plan for `tail` of the fixture's session, as the creator would build it.
pub(super) fn plan_for(fixture: &CreationFixture, tail: &str) -> WorktreeNamePlan {
    WorktreeNamePlan::for_tail(
        WorktreeNameBase {
            pattern: pattern(),
            session_short_id: fixture.session_short_id(),
            project_folder: fixture.project_folder(),
        },
        tail.to_owned(),
    )
}

// The project's naming facts: slug `app` and the title-only pattern; the session has no title.
struct FixedNaming;

impl WorktreeNamingSources for FixedNaming {
    fn read_project_naming<'a>(
        &'a self,
        _repo_mount_id: &'a RepoMountId,
    ) -> BoxFuture<'a, Result<WorktreeProjectNaming, WorktreeNamingError>> {
        async {
            Ok(WorktreeProjectNaming {
                slug: "app".to_owned(),
                branch_pattern: Some(pattern()),
            })
        }
        .boxed()
    }

    fn read_machine_branch_pattern(
        &self,
    ) -> BoxFuture<'_, Result<BranchNamePattern, WorktreeNamingError>> {
        async { Ok(pattern()) }.boxed()
    }

    fn read_session_title_words<'a>(
        &'a self,
        _session_id: &'a SessionId,
        _fallback_message: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, WorktreeNamingError>> {
        async { Ok(String::new()) }.boxed()
    }
}

// A project with no setup steps of its own.
struct NoSetupSteps;

impl WorktreeSetupSources for NoSetupSteps {
    fn require_worktree<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<(), WorktreeSetupError>> {
        async { Ok(()) }.boxed()
    }

    fn read_retired<'a>(
        &'a self,
        _worktree_ids: &'a [WorktreeId],
    ) -> BoxFuture<'a, Result<HashSet<WorktreeId>, WorktreeSetupError>> {
        async { Ok(HashSet::new()) }.boxed()
    }

    fn read_project_setup<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<ProjectSetup, WorktreeSetupError>> {
        async {
            Ok(ProjectSetup {
                files_to_copy: Vec::new(),
                commands: Vec::new(),
                time_limit_seconds: None,
            })
        }
        .boxed()
    }

    fn read_command_environment<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<Vec<(String, String)>, WorktreeSetupError>> {
        async { Ok(std::env::vars().collect()) }.boxed()
    }
}

// Answers each read with the next scripted list of live runs, and none once the script is spent,
// standing in for the session crate's reader.
#[derive(Default)]
struct ScriptedLiveRuns {
    answers: Mutex<VecDeque<Vec<LiveRunFolder>>>,
}

impl LiveRunFolderReader for ScriptedLiveRuns {
    fn read_other_sessions_live_runs<'a>(
        &'a self,
        _session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<Vec<LiveRunFolder>, LiveRunFolderReadError>> {
        let answer = lock(&self.answers).pop_front().unwrap_or_default();
        async move { Ok(answer) }.boxed()
    }
}

/// A repository `app` on `main` with one commit, its attached mount, and a creator over them
/// making trees under the scratch folder's `worktrees`.
pub(super) struct CreationFixture {
    database: TestDatabase,
    _log: TestLog,
    scratch: TempDir,
    /// The test's git.
    pub(super) git: GitRunner,
    /// The repository's checkout.
    pub(super) repository: PathBuf,
    /// The daemon's read pool on the test's database.
    pub(super) reads: Arc<DatabaseReadPool>,
    /// The repository's attached mount.
    pub(super) mount: AttachedMountRow,
    session_id: SessionId,
    live_runs: Arc<ScriptedLiveRuns>,
    setup: Arc<WorktreeSetupRunner<NullWatcher>>,
    creator: WorktreeCreator<NullWatcher>,
}

impl CreationFixture {
    /// The fixture, its repository committed once.
    pub(super) async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let git = test_git_runner();
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let repository = make_test_repository(&git, scratch.path(), "app").await;
        let mount_id = mint_uuid_v7().to_string();
        let connection = database.reader();
        for row in project_and_mount_rows(&mount_id, None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        connection
            .execute(
                "UPDATE repo_mounts SET canonical_root = ?1 WHERE id = ?2",
                params![repository.to_string_lossy(), mount_id],
            )
            .expect("the mount points at the repository");
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let events = Arc::new(WorktreeEventEmitter::new(Arc::clone(&log.service)));
        let worktrees_folder = scratch.path().join("worktrees");
        let worktrees = Arc::new(WorktreeService::new(WorktreeServiceDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&log.writer),
            events: Arc::clone(&events),
            occupancy: MountOccupancyReader::new(Arc::clone(&reads)),
            worktrees_folder: worktrees_folder.clone(),
        }));
        let mount = worktrees
            .require_attached_mount(
                &RepoMountId::new(&mount_id).expect("a minted id is a mount id"),
            )
            .await
            .expect("the mount is attached");
        let setup = Arc::new(test_setup_runner(
            git.clone(),
            Arc::clone(&reads),
            Arc::clone(&events),
            Arc::new(NoSetupSteps),
        ));
        let live_runs = Arc::new(ScriptedLiveRuns::default());
        let creator = WorktreeCreator::new(WorktreeCreatorDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&log.writer),
            events,
            naming: WorktreeNaming::new(worktrees_folder, Arc::new(FixedNaming)),
            worktrees,
            setup: Arc::clone(&setup),
            live_run_folders: Arc::clone(&live_runs) as _,
            checkout_lock: Arc::new(KeyedLock::new()),
        });
        Self {
            database,
            _log: log,
            scratch,
            git,
            repository,
            reads,
            mount,
            session_id: test_session_id(),
            live_runs,
            setup,
            creator,
        }
    }

    /// The repository's own branch, the base every test cuts from.
    pub(super) fn base_ref(&self) -> GitRefName {
        GitRefName::new("main".to_owned()).expect("a branch name is text")
    }

    /// The fixture's session's short id, which every folder it makes starts with.
    pub(super) fn session_short_id(&self) -> String {
        short_id_of(self.session_id.text().as_str())
    }

    fn project_folder(&self) -> PathBuf {
        self.scratch.path().join("worktrees").join("app")
    }

    fn folder_of(&self, tail: &str) -> PathBuf {
        self.project_folder()
            .join(format!("{}-{tail}", self.session_short_id()))
    }

    fn input(&self, name: &str, collision: NameCollision) -> CreateWorktreeInput {
        CreateWorktreeInput {
            repo_mount_id: self.mount.id,
            session_id: self.session_id,
            run_id: None,
            name: WorktreeNameRequest::BranchName(name.to_owned()),
            on_collision: collision,
            base_ref: None,
            carry_uncommitted_from: None,
            actor: None,
            correlation_id: None,
        }
    }

    fn worktree_states(&self) -> Vec<String> {
        let connection = self.database.reader();
        let mut statement = connection
            .prepare("SELECT state FROM worktrees ORDER BY created_at")
            .expect("the rows are read");
        statement
            .query_map([], |row| row.get(0))
            .expect("the rows are read")
            .collect::<rusqlite::Result<_>>()
            .expect("the rows are read")
    }
}

// Before the insert, a live tree on the same mount and branch lands, as one made between the walk's
// read and the write would.
const ACTIVE_BRANCH_TRIGGER: &str = "CREATE TRIGGER collide BEFORE INSERT ON worktrees
  WHEN NEW.id <> 'collider'
BEGIN
  INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, base_ref, fs_root,
                         created_at, updated_at)
  VALUES ('collider', NEW.repo_mount_id, NEW.created_by_session_id, NEW.branch_name,
          NEW.base_ref, '/elsewhere', NEW.created_at, NEW.updated_at);
END;";

// Another constraint refuses the insert: its primary code is a constraint's, its extended code not
// the unique index's.
const OTHER_CONSTRAINT_TRIGGER: &str = "CREATE TRIGGER refuse BEFORE INSERT ON worktrees
BEGIN
  SELECT RAISE(ABORT, 'refused');
END;";

// Kills a primary-code check that reads another constraint's refusal as a collision, the collision
// read from anything but the insert's own failure, and an undo that leaves the folder or the branch
// the creation made.
#[rstest]
#[case::active_branch_index(ACTIVE_BRANCH_TRIGGER, true)]
#[case::other_constraint(OTHER_CONSTRAINT_TRIGGER, false)]
#[tokio::test]
async fn a_record_the_active_branch_index_refuses_is_a_collision_and_its_tree_is_undone(
    #[case] trigger: &str,
    #[case] is_collision: bool,
) {
    let fixture = CreationFixture::new().await;
    fixture
        .database
        .reader()
        .execute_batch(trigger)
        .expect("the trigger is made");

    let failure = fixture
        .creator
        .create(fixture.input("fix", NameCollision::Refuse))
        .await
        .expect_err("the record is refused");

    if let WorktreeCreationError::Refused(WorktreeRefusal::BranchCollision {
        branch_name, ..
    }) = &failure
    {
        assert!(is_collision, "another constraint read as a collision");
        assert_eq!(branch_name.as_str(), "fix");
    } else {
        assert!(!is_collision, "the collision was not read: {failure:?}");
        assert!(
            matches!(failure, WorktreeCreationError::Record(_)),
            "expected the record's failure alone, got {failure:?}"
        );
    }
    assert!(
        !fixture.folder_of("fix").exists(),
        "the tree's folder is left"
    );
    assert!(
        !has_branch(&fixture.git, None, &fixture.repository, "fix")
            .await
            .expect("the branches are read"),
        "the new branch is left"
    );
    assert!(fixture.worktree_states().is_empty());
}

// Kills an undo that deletes a branch the call did not make: git fails on the bad base before it
// reads the branch, so the person's own branch of that name stays.
#[tokio::test]
async fn a_failed_add_keeps_a_branch_the_person_already_had() {
    let fixture = CreationFixture::new().await;
    git_in(&fixture.git, &fixture.repository, &["branch", "feature"]).await;
    let mut input = fixture.input("feature", NameCollision::Refuse);
    input.base_ref = Some(GitRefName::new("no-such-base".to_owned()).expect("text"));

    let failure = fixture
        .creator
        .create(input)
        .await
        .expect_err("a bad base fails the creation");

    assert!(
        matches!(
            failure,
            WorktreeCreationError::Refused(WorktreeRefusal::CreateFailed {
                reason: WorktreeCreateFailureReason::GitInvocationFailed,
                ..
            })
        ),
        "{failure:?}"
    );
    assert!(
        has_branch(&fixture.git, None, &fixture.repository, "feature")
            .await
            .expect("the branches are read"),
        "the person's branch is deleted"
    );
    assert!(!fixture.folder_of("feature").exists());
}

// Kills dropping the check under the checkout lock, and leaving the tree it made: the run starts
// while git makes the tree, so only the second read sees it.
#[tokio::test]
async fn a_carry_while_another_session_runs_in_the_checkout_is_refused_and_leaves_nothing() {
    let fixture = CreationFixture::new().await;
    write_file_atomically(&fixture.repository.join("draft.txt"), "work", 0o644)
        .await
        .expect("the uncommitted work is written");
    let running_session_id = test_session_id();
    let running_agent_id =
        AgentId::new(&mint_uuid_v7().to_string()).expect("a minted id is an agent id");
    lock(&fixture.live_runs.answers).extend([
        Vec::new(),
        vec![LiveRunFolder {
            session_id: running_session_id,
            agent_id: running_agent_id,
            folder: fixture.repository.join("nested"),
        }],
    ]);
    let mut input = fixture.input("carried", NameCollision::Refuse);
    input.carry_uncommitted_from = Some(fixture.repository.clone());

    let failure = fixture
        .creator
        .create(input)
        .await
        .expect_err("the carry is refused");

    let WorktreeCreationError::Refused(WorktreeRefusal::CreateFailed {
        reason:
            WorktreeCreateFailureReason::CarryCheckoutRunning {
                running_session_id: refused_session,
                running_agent_id: refused_agent,
            },
        ..
    }) = &failure
    else {
        panic!("expected carryCheckoutRunning, got {failure:?}");
    };
    assert_eq!(*refused_session, running_session_id);
    assert_eq!(*refused_agent, running_agent_id);
    assert!(
        !fixture.folder_of("carried").exists(),
        "the tree's folder is left"
    );
    assert!(
        !has_branch(&fixture.git, None, &fixture.repository, "carried")
            .await
            .expect("the branches are read"),
        "the new branch is left"
    );
    assert!(
        fixture.repository.join("draft.txt").exists(),
        "the work was stashed"
    );
}

// Kills undoing every tree whose `worktree add` exited non-zero: git makes the tree before its
// checkout hook runs, so a failing hook leaves a ready tree, its words on the card.
#[tokio::test]
async fn a_failing_checkout_hook_keeps_a_ready_tree_with_the_hook_s_line_on_its_card() {
    let fixture = CreationFixture::new().await;
    let hooks = fixture.repository.join(".git").join("hooks");
    tokio::fs::create_dir_all(&hooks)
        .await
        .expect("the hooks folder is made");
    write_file_atomically(
        &hooks.join("post-checkout"),
        "#!/bin/sh\necho 'hook refused the checkout' >&2\nexit 1\n",
        0o755,
    )
    .await
    .expect("the hook is written");
    // Named in the repository's own config, over any hooks folder the person's config names.
    git_in(
        &fixture.git,
        &fixture.repository,
        &["config", "core.hooksPath", &hooks.to_string_lossy()],
    )
    .await;

    let created = fixture
        .creator
        .create(fixture.input("hooked", NameCollision::Refuse))
        .await
        .expect("the tree is made despite its hook");

    assert_eq!(created.fs_root, fixture.folder_of("hooked"));
    assert!(created.fs_root.join(".git").exists());
    assert_eq!(fixture.worktree_states(), ["ready"]);
    let card: Arc<Mutex<Option<WorktreeSetupStatus>>> = Arc::default();
    let seen = Arc::clone(&card);
    let _subscription = fixture
        .setup
        .subscribe(
            created.worktree_id,
            Arc::new(move |status| *lock(&seen) = Some(status)),
        )
        .await
        .expect("the card is read");
    let card = lock(&card).clone().expect("the card is answered");
    let make_tree = card
        .steps
        .iter()
        .find(|step| step.stage == WorktreeSetupStage::MakeTree)
        .expect("the card shows the tree's making");
    let output = make_tree
        .output
        .as_ref()
        .map(FreeFormText::as_str)
        .unwrap_or_default();
    // git's own `Preparing worktree` line stays off the card.
    assert_eq!(output, "hook refused the checkout");
}

// A stop between the row and `ready` leaves a `creating` row holding its branch. Kills the
// `creating` rows skipped, a tree on disk retired instead of undone (its folder and branch left),
// and a tree gone left `creating`.
#[rstest]
#[case::tree_on_disk(true, "failed")]
#[case::tree_gone(false, "retired")]
#[tokio::test]
async fn a_creation_a_stop_cut_off_is_settled_at_start_and_frees_its_branch(
    #[case] is_tree_on_disk: bool,
    #[case] settled_state: &str,
) {
    let fixture = CreationFixture::new().await;
    let created = fixture
        .creator
        .create(fixture.input("fix", NameCollision::Refuse))
        .await
        .expect("the tree is made");
    fixture
        .database
        .reader()
        .execute(
            "UPDATE worktrees SET state = 'creating' WHERE id = ?1",
            [created.worktree_id.to_string()],
        )
        .expect("the row is put back to creating");
    if !is_tree_on_disk {
        tokio::fs::remove_dir_all(&created.fs_root)
            .await
            .expect("the tree's folder is removed");
    }

    let repair = fixture.creator.finish_interrupted_creations().await;

    assert!(repair.failures.is_empty(), "{:?}", repair.failures);
    assert_eq!(repair.settled_worktree_ids, vec![created.worktree_id]);
    assert_eq!(fixture.worktree_states(), vec![settled_state.to_owned()]);
    let live_on_branch: i64 = fixture
        .database
        .reader()
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM worktrees WHERE branch_name = 'fix' AND {}",
                LIVE_WORKTREE_STATE_PREDICATE.as_str()
            ),
            [],
            |row| row.get(0),
        )
        .expect("the live trees are counted");
    assert_eq!(live_on_branch, 0, "a live row still holds the branch");
    if is_tree_on_disk {
        assert!(!created.fs_root.exists(), "the tree's folder is left");
        assert!(
            !has_branch(&fixture.git, None, &fixture.repository, "fix")
                .await
                .expect("the branches are read"),
            "the creation's branch is left"
        );
        fixture
            .creator
            .create(fixture.input("fix", NameCollision::Refuse))
            .await
            .expect("the freed name makes a tree again");
    }
}

// `HEAD` passes the format check alone, so `worktree add -b` would refuse it as a failed git call.
// Kills the branch form of git's rule left out of the name's check.
#[tokio::test]
async fn a_supplied_head_is_refused_as_an_invalid_branch_name_with_git_s_line() {
    let fixture = CreationFixture::new().await;

    let failure = fixture
        .creator
        .create(fixture.input("HEAD", NameCollision::Refuse))
        .await
        .expect_err("the name is refused");

    let WorktreeCreationError::Refused(WorktreeRefusal::CreateFailed {
        reason: WorktreeCreateFailureReason::BranchNameInvalid { line },
        ..
    }) = &failure
    else {
        panic!("expected branchNameInvalid, got {failure:?}");
    };
    assert!(
        line.starts_with("fatal: ") && line.contains("'HEAD'"),
        "git's line as printed: {line}"
    );
    assert!(fixture.worktree_states().is_empty());
}
