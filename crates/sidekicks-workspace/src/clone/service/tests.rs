//! The clone service's tests, against a real git on temporary folders with the test's own git
//! config: a clone with a submodule attaches and its key answers a resend and refuses another
//! request, a failed clone keeps no credential, and the start's recovery removes only the folders
//! the daemon made.

use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::Connection;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::clone::{
    ProjectCloneFailedStep, ProjectCloneStartRequest, ProjectCloneStatus,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::feed::{Feed as _, SendGate, SubscriptionClosed};
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_platforms::real_path;
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::EVENT_LOG_STATEMENT_CAPACITY;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;

use super::{CloneAttachedListener, CloneService, CloneServiceDeps, CloneServiceError};
use crate::clone::askpass::broker::AskpassBroker;
use crate::clone::destination::make_staged_clone;
use crate::clone::requests::CLONE_REQUESTS_STATEMENT_CAPACITY;
use crate::event_emitter::WorkspaceEventEmitter;
use crate::git::process::{GitCall, GitRunner, in_folder, test_git_runner_with_environment};
use crate::git::worktree::schema::schema_parts;
use crate::machine_settings::MachineSettingsReader;
use crate::project::list_feed::ProjectListFeed;
use crate::project::records::{
    PROJECT_RECORDS_STATEMENT_CAPACITY, ProjectRecords, ProjectSessionActivity, ProjectSessionFacts,
};
use crate::project::service::{ForgottenProjectSessions, ProjectService, ProjectServiceDeps};
use crate::repo::errors::RepoRefusal;
use crate::repo::mount::service::{REPO_MOUNT_SERVICE_STATEMENT_CAPACITY, RepoMountService};
use crate::repo::root_resolver::RepoRootResolver;
use crate::test_rows::PARENT_ROWS_AT;

// Long enough for a local clone with a submodule on a loaded machine.
const WAIT: Duration = Duration::from_secs(60);

// The test's own identity and the local submodule clone, never the person's config.
const GIT_CONFIG: &str = "[user]\n\tname = Test\n\temail = test@example.invalid\n\
                          [commit]\n\tgpgSign = false\n[protocol \"file\"]\n\tallow = always\n";

// No session counts in any project: these tests read only the project rows.
struct NoSessions;

impl ProjectSessionActivity for NoSessions {
    fn read_session_facts(
        &self,
        _reader: &Connection,
        _project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
        Ok(Vec::new())
    }
}

// A port no test here reaches: every start names its parent folder and nothing is detached.
struct Unreached;

impl ForgottenProjectSessions for Unreached {
    fn archive_of_forgotten_project(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no test archives a session".into()) }.boxed()
    }
}

impl MachineSettingsReader for Unreached {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        async { Err("no test reads the machine's settings".into()) }.boxed()
    }
}

// The projects whose clone attached, as the sessions that waited hear of them.
#[derive(Default)]
struct AttachedClones(Mutex<Vec<ProjectId>>);

impl CloneAttachedListener for AttachedClones {
    fn clone_attached(
        &self,
        project_id: ProjectId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.0).push(project_id);
        async { Ok(()) }.boxed()
    }
}

// A gate always open, so the card's feed sends what it holds.
struct OpenGate;

impl SendGate for OpenGate {
    fn ready(&self) -> BoxFuture<'_, Result<(), SubscriptionClosed>> {
        async { Ok(()) }.boxed()
    }
}

struct Harness {
    database: TestDatabase,
    log: TestLog,
    reads: Arc<DatabaseReadPool>,
    git: GitRunner,
    folder: PathBuf,
    attached: Arc<AttachedClones>,
    _scratch: TempDir,
}

impl Harness {
    // A database and a git whose only config is the test's own.
    async fn new() -> Self {
        let scratch = tempfile::tempdir().expect("the scratch folder is made");
        let folder = real_path(scratch.path()).expect("the scratch folder resolves");
        let config_path = folder.join("gitconfig");
        std::fs::write(&config_path, GIT_CONFIG).expect("the test's git config is written");
        let config_path = config_path
            .to_str()
            .expect("a scratch path is text")
            .to_owned();
        let git = test_git_runner_with_environment(&[
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", &config_path),
        ]);
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY
                + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY
                + PROJECT_RECORDS_STATEMENT_CAPACITY
                + CLONE_REQUESTS_STATEMENT_CAPACITY,
        ));
        Self {
            database,
            log,
            reads,
            git,
            folder,
            attached: Arc::new(AttachedClones::default()),
            _scratch: scratch,
        }
    }

    // Starts the service, its recovery run.
    async fn start(&self) -> Arc<CloneService> {
        let mounts = Arc::new(RepoMountService::new(
            Arc::clone(&self.log.writer),
            Arc::clone(&self.reads),
            Arc::new(WorkspaceEventEmitter::new(Arc::clone(&self.log.service))),
            RepoRootResolver::new(self.git.clone()),
            MachineId::new("machine".to_owned()).expect("the id is short"),
        ));
        let records = Arc::new(ProjectRecords::new(
            Arc::clone(&self.reads),
            Arc::new(NoSessions),
        ));
        let projects = Arc::new(ProjectService::new(ProjectServiceDeps {
            writer: Arc::clone(&self.log.writer),
            records: Arc::clone(&records),
            mounts,
            sessions: Arc::new(Unreached),
            git: self.git.clone(),
            settings: Arc::new(Unreached),
            driver_set_names: Vec::new(),
            worktrees_folder: self.folder.join("worktrees"),
            list_feed: Arc::new(ProjectListFeed::new(
                Arc::clone(&records),
                &self.log.followers,
            )),
        }));
        let clone_attached = Arc::new(PortRegistration::new("clone attached"));
        let listener: Arc<dyn CloneAttachedListener> = Arc::clone(&self.attached) as _;
        clone_attached
            .register(listener)
            .expect("the port is registered once");
        // No question is asked in these tests, so the program's path names nothing.
        let askpass = AskpassBroker::start(&self.folder, PathBuf::from("askpass-program"))
            .expect("the broker starts");
        CloneService::start(CloneServiceDeps {
            projects,
            records,
            reads: Arc::clone(&self.reads),
            askpass,
            settings: Arc::new(Unreached),
            home_folder: self.folder.clone(),
            git: self.git.clone(),
            clone_attached,
        })
        .await
        .expect("the service starts")
    }

    // Adds `settings` to the test's git config, which every later git call reads.
    fn add_git_config(&self, settings: &str) {
        let config_path = self.folder.join("gitconfig");
        let mut config = std::fs::read_to_string(&config_path).expect("the config is read");
        config.push_str(settings);
        std::fs::write(&config_path, config).expect("the config is written");
    }

    // Runs git in `folder` with the test's config, as a read so no hook runs.
    async fn git_in(&self, folder: &Path, arguments: &[&str]) {
        self.git
            .run(None, GitCall::read(in_folder(folder, arguments)))
            .await
            .expect("the repository is set up");
    }

    // The writes committed so far.
    fn commits(&self) -> u64 {
        *self.log.writer.follow_commits().borrow()
    }

    fn project_column(&self, project_id: ProjectId, column: &str) -> Option<String> {
        self.database
            .reader()
            .query_row(
                &format!("SELECT {column} FROM projects WHERE id = ?1"),
                [project_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the project is stored")
    }
}

fn start_request(url: &str, parent_folder: &Path, key: &ClientUuid) -> ProjectCloneStartRequest {
    ProjectCloneStartRequest {
        url: FreeFormText::new(url.to_owned()).expect("the address is short"),
        parent_folder: Some(
            FilesystemPath::new(parent_folder.to_string_lossy().into_owned())
                .expect("the folder is a wire path"),
        ),
        place: None,
        project_id: None,
        client_idempotency_key: key.clone(),
    }
}

fn new_key() -> ClientUuid {
    ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key")
}

// Follows the project's card until its run ends, and answers how it ended.
async fn follow_to_end(service: &CloneService, project_id: ProjectId) -> ProjectCloneStatus {
    let mut card = LatestValueFeed::open(|outlet| async move {
        Ok::<_, HandlerError>(service.follow_card(project_id, outlet).await?)
    })
    .await
    .expect("the card opens");
    loop {
        let status = tokio::time::timeout(WAIT, card.next(&OpenGate))
            .await
            .expect("the run ends in time")
            .expect("the card reads")
            .expect("the card stays open");
        match status {
            ProjectCloneStatus::Cloning { .. } | ProjectCloneStatus::PullingLargeFiles { .. } => {}
            ended @ (ProjectCloneStatus::Failed { .. }
            | ProjectCloneStatus::LargeFilesMissing { .. }
            | ProjectCloneStatus::Canceled { .. }
            | ProjectCloneStatus::Done { .. }) => return ended,
        }
    }
}

// Kills `--recurse-submodules` dropped (the submodule's file is missing), the key record written
// outside the project's insert (the start commits twice, or the resend clones again and commits),
// and the key's comparison dropped (the differing parent folder answers the first project).
#[tokio::test]
async fn a_clone_with_a_submodule_attaches_and_its_key_answers_a_resend_and_refuses_another() {
    let harness = Harness::new().await;
    let folder = harness.folder.clone();
    harness.git_in(&folder, &["init", "library"]).await;
    std::fs::write(folder.join("library").join("README"), "library\n")
        .expect("the submodule's file is written");
    harness
        .git_in(&folder.join("library"), &["add", "README"])
        .await;
    harness
        .git_in(&folder.join("library"), &["commit", "-m", "library"])
        .await;
    harness.git_in(&folder, &["init", "app"]).await;
    let library = folder.join("library");
    let library = library.to_str().expect("a scratch path is text");
    harness
        .git_in(
            &folder.join("app"),
            &["submodule", "add", library, "lib/library"],
        )
        .await;
    harness
        .git_in(&folder.join("app"), &["commit", "-m", "app"])
        .await;
    harness
        .git_in(&folder, &["clone", "--bare", "app", "app.git"])
        .await;
    let service = harness.start().await;
    let key = new_key();
    let source = folder.join("app.git");
    let source = source.to_str().expect("a scratch path is text");
    let request = start_request(source, &folder.join("projects"), &key);

    let before = harness.commits();
    let started = service
        .start_clone(request.clone())
        .await
        .expect("the clone starts");
    assert_eq!(
        harness.commits(),
        before + 1,
        "the project and its key record are one write"
    );
    let project_id = started.project_id;
    assert_eq!(
        follow_to_end(&service, project_id).await,
        ProjectCloneStatus::Done { project_id }
    );
    assert_eq!(
        harness.project_column(project_id, "state").as_deref(),
        Some("active")
    );
    let mounts: i64 = harness
        .database
        .reader()
        .query_row(
            "SELECT count(*) FROM repo_mounts WHERE project_id = ?1",
            [project_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the mounts count");
    assert_eq!(mounts, 1);
    assert!(
        folder
            .join("projects")
            .join("app")
            .join("lib")
            .join("library")
            .join("README")
            .is_file(),
        "the submodule is checked out"
    );
    assert_eq!(*lock(&harness.attached.0), [project_id]);

    let settled = harness.commits();
    let resent = service
        .start_clone(request.clone())
        .await
        .expect("the resend answers");
    assert_eq!(resent, started);
    assert_eq!(
        harness.commits(),
        settled,
        "the resend writes and runs nothing"
    );

    let elsewhere = start_request(source, &folder.join("elsewhere"), &key);
    let refused = service
        .start_clone(elsewhere)
        .await
        .expect_err("another request under the key is refused");
    assert!(
        matches!(
            refused,
            CloneServiceError::Refused(RepoRefusal::CloneIdempotencyConflict { project_id: first })
                if first == project_id
        ),
        "the first project is named: {refused:?}"
    );
    service.close().await.expect("the service closes");
}

// Kills the typed address's replacement dropped: the hook's failure line echoes the address as
// typed, which git itself prints only without its credentials.
#[tokio::test]
async fn a_failed_clone_keeps_no_credential_in_its_record_or_its_card() {
    let harness = Harness::new().await;
    let hooks = harness.folder.join("hooks");
    // The hook's line names the clone's origin as git keeps it, the address as typed.
    std::fs::create_dir(&hooks).expect("the hooks folder is made");
    write_file_atomically(
        &hooks.join("post-checkout"),
        "#!/bin/sh\necho \"fatal: checkout refused for $(git config remote.origin.url)\" >&2\n\
         exit 1\n",
        0o755,
    )
    .await
    .expect("the hook is written");
    harness.add_git_config(&format!("[core]\n\thooksPath = {}\n", hooks.display()));
    let folder = harness.folder.clone();
    harness.git_in(&folder, &["init", "app"]).await;
    harness
        .git_in(
            &folder.join("app"),
            &["commit", "--allow-empty", "-m", "app"],
        )
        .await;
    harness
        .git_in(&folder, &["clone", "--bare", "app", "app.git"])
        .await;
    let service = harness.start().await;
    let url = format!(
        "file://ana:tok@127.0.0.1{}",
        folder.join("app.git").display()
    );

    let started = service
        .start_clone(start_request(&url, &folder.join("projects"), &new_key()))
        .await
        .expect("the clone starts");
    let project_id = started.project_id;
    let ended = follow_to_end(&service, project_id).await;

    let line = match ended {
        ProjectCloneStatus::Failed {
            step: ProjectCloneFailedStep::Clone,
            failure_line,
            ..
        } => failure_line,
        ProjectCloneStatus::Failed { .. }
        | ProjectCloneStatus::Cloning { .. }
        | ProjectCloneStatus::PullingLargeFiles { .. }
        | ProjectCloneStatus::LargeFilesMissing { .. }
        | ProjectCloneStatus::Canceled { .. }
        | ProjectCloneStatus::Done { .. } => None,
    }
    .expect("the clone fails with the hook's line");
    assert!(line.as_str().contains("file://127.0.0.1/"), "{line:?}");
    for kept in [
        Some(line.into_string()),
        harness.project_column(project_id, "clone_failure"),
        harness.project_column(project_id, "clone_url"),
    ] {
        let kept = kept.expect("the failure and the address are kept");
        assert!(!kept.contains("tok"), "a credential is kept: {kept}");
    }
    service.close().await.expect("the service closes");
}

// Kills a staged folder removed by its path alone (the folder that replaced one is removed) and
// the recovery skipped (both clones stay running and the daemon's folder stays).
#[tokio::test]
async fn the_start_records_running_clones_interrupted_and_removes_only_the_folders_it_made() {
    let harness = Harness::new().await;
    let projects = harness.folder.join("projects");
    let made = make_staged_clone(&projects.join("made"))
        .await
        .expect("the folder is made");
    let replaced = make_staged_clone(&projects.join("replaced"))
        .await
        .expect("the folder is made");
    std::fs::rename(&replaced.path, harness.folder.join("moved")).expect("the folder moves away");
    std::fs::create_dir(&replaced.path).expect("another folder takes its path");
    let mut clones = Vec::new();
    for staged in [&made, &replaced] {
        let project_id =
            ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");
        let slug: OsString = staged.path.file_name().expect("a folder name").to_owned();
        harness
            .database
            .reader()
            .execute(
                "INSERT INTO projects (id, name, slug, folder_path, state, clone_url, \
                 clone_outcome, clone_staging_folder, clone_staging_identity, setup, created_at, \
                 updated_at) VALUES (?1, ?2, ?2, '/repos/app', 'cloning', \
                 'https://example.invalid/app.git', 'running', ?3, ?4, \
                 '{\"filesToCopy\":[],\"commands\":[]}', ?5, ?5)",
                rusqlite::params![
                    project_id.text().as_str(),
                    slug.to_string_lossy(),
                    staged.path.to_string_lossy(),
                    staged.identity.to_string(),
                    PARENT_ROWS_AT,
                ],
            )
            .expect("the running clone is stored");
        clones.push(project_id);
    }

    let service = harness.start().await;

    assert!(!made.path.exists(), "the folder the daemon made is removed");
    assert!(replaced.path.is_dir(), "a folder that replaced it is kept");
    for project_id in clones {
        assert_eq!(
            harness
                .project_column(project_id, "clone_outcome")
                .as_deref(),
            Some("interrupted")
        );
    }
    service.close().await.expect("the service closes");
}
