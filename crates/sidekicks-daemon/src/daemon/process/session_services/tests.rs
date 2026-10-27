//! The session services built as the daemon's start builds them, over a test database, a test
//! registry and a temporary home: their follows of the log once started.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, Weak};

use sidekicks_artifact::admission::UploadAdmission;
use sidekicks_artifact::payload_store::PayloadStore;
use sidekicks_artifact::plans::store::StoredPlanHolds;
use sidekicks_artifact::publish::ArtifactPublishService;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::events::SessionLifecycleChangePayload;
use sidekicks_contracts::session::id::{SessionId, UserId};
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{Spawner, WallClockTimer};
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::background_work::BackgroundWorkForms;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::process_identity::{ProviderProcessIdentity, ProviderProcessIds};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_provider::runtime_binding::store::CreateRuntimeBindingInput;
use sidekicks_provider::runtime_binding::store::{RuntimeBindingSpawnConfig, RuntimeBindingStore};
use sidekicks_provider::runtime_binding::test_store::{binding_input, spawned_build};
use sidekicks_queue::memory_gate::{MemoryGate, MemoryGateFigures};
use sidekicks_queue::provider_session::test_opening::test_opening_composer;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::plan_holds::PlanHolds;
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_session::run::epochs::ExecutionEpochs;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::followers::CommittedEvent;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_store::machine::local::LocalMachine;
use sidekicks_workspace::git::process::{GitLimits, GitRunner};
use sidekicks_workspace::git::worktree::watch::WorkingFolderWatcher;
use sidekicks_workspace::managed::service::{ManagedWorkspaceService, managed_workspaces_folder};
use sidekicks_workspace::managed::write_watcher::{
    ManagedWorkspaceWrite, ManagedWorkspaceWriteKind,
};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    SessionServiceStart, SessionServices, build_session_services, start_session_attachments,
};
use crate::daemon::process::repo_services::{RepoServiceStart, RepoServices, build_repo_services};
use crate::daemon::schema::schema_parts;

// The statements the tests' read pool prepares, every reader's together.
const READ_STATEMENT_CAPACITY: usize = 64;

// A session with no provider process running.
struct NoProcess;

impl ProviderProcessIds for NoProcess {
    fn process_identity(&self, _session_id: &SessionId) -> Option<ProviderProcessIdentity> {
        None
    }
}

/// The repository and session services built over a test database on a temporary home.
struct Fixture {
    database: TestDatabase,
    log: TestLog,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    folder_watch: Arc<WorkingFolderWatcher>,
    workspaces: Arc<ManagedWorkspaceService>,
    // Stands in for the workspaces' watch as the sender of the chats' writes.
    writes: Option<mpsc::Sender<ManagedWorkspaceWrite>>,
    session: SessionServices,
    home: TempDir,
}

async fn fixture() -> Fixture {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    std::fs::create_dir(home.path().join("run")).expect("the test makes the run folder");
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let daemon_program = std::env::current_exe().expect("the test's program is named");
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let clock = Arc::new(WallClockTimer::new().expect("the test arms a wall clock"));
    let scheduler = Arc::new(Scheduler::start(
        Arc::clone(&clock) as Arc<_>,
        None,
        tokio::sync::watch::channel(0).1,
    ));
    let plan_holds: Arc<dyn PlanHolds> = Arc::new(StoredPlanHolds);
    let list_feed = Arc::new(SessionListFeed::new(
        Arc::clone(&reads),
        &log.followers,
        Arc::clone(&scheduler),
        &*plan_holds,
    ));
    let machine = LocalMachine {
        machine_id: MachineId::new(mint_uuid_v7().to_string()).expect("a machine id"),
        owner_user_id: UserId::try_from(mint_uuid_v7()).expect("a user id"),
        name: "desk".to_owned(),
    };
    let git = GitRunner::new(spawner.clone(), None, Arc::from([]), GitLimits::DAEMON);
    let repo = build_repo_services(RepoServiceStart {
        home_folder: home.path().to_path_buf(),
        run_folder: home.path().join("run"),
        daemon_program: daemon_program.clone(),
        git: git.clone(),
        reads: Arc::clone(&reads),
        writer: Arc::clone(&log.writer),
        event_log: Arc::clone(&log.service),
        machine_id: machine.machine_id.clone(),
        scheduler,
        list_feed: Arc::clone(&list_feed),
        stop: CancellationToken::new(),
    })
    .expect("the repository services build");
    let RepoServices {
        folder_watch,
        workspaces,
        ..
    } = repo;
    let (writes, workspace_writes) = mpsc::channel(8);
    let appender = Arc::new(SessionEventAppender::new(
        Arc::clone(&log.service),
        SESSION_EVENT_VERSION.clone(),
    ));
    let payloads =
        Arc::new(PayloadStore::new(home.path().join("objects")).expect("the payload store opens"));
    let spool_folder = home.path().join("spool");
    let publisher = Arc::new(ArtifactPublishService::new(
        appender,
        Arc::clone(&reads),
        Arc::clone(&payloads),
        Arc::new(UploadAdmission::new(spool_folder.clone(), |_folder| {
            Ok(1 << 30)
        })),
        Arc::clone(&clock) as Arc<_>,
    ));
    let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
        NonZeroUsize::new(8).expect("the cap is not zero"),
    )));
    let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> =
        Arc::new(|_: &SessionId| None::<i64>);
    let session = build_session_services(SessionServiceStart {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&log.writer),
        event_log: Arc::clone(&log.service),
        followers: Arc::clone(&log.followers),
        read_damaged_from_sequence,
        providers: Arc::new(registry_of_first_provider(Arc::new(
            MockProviderDriver::new(),
        ))),
        execution_postures: Arc::new(ExecutionPostureService::new(
            home.path(),
            home.path().join("session-token"),
        )),
        runtime_bindings: Arc::new(RuntimeBindingStore::new(reads, Arc::clone(&log.writer))),
        epochs: Arc::clone(&epochs),
        compose_opening: test_opening_composer(),
        processes: Arc::new(NoProcess),
        memory_gate: Arc::new(MemoryGate::new(
            MemoryGateFigures {
                physical_memory_bytes: 16 << 30,
                quick_thread_bytes: 0,
                ingest_worker_bytes: 0,
            },
            Arc::new(|| Ok(16 << 30)),
            Arc::new(|_process_id| Ok(None)),
        )),
        machine,
        shell_lines: Arc::new(ShellLineReadingBound::new(1 << 20)),
        background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
        authorizer: Arc::new(Authorizer::load_built_in().expect("the built-in rules load")),
        data_folder: home.path().join("data"),
        working_folders: Arc::clone(&folder_watch),
        git,
        list_feed,
        plan_holds,
        payloads,
        publisher,
        spool_folder,
        workspaces_folder: managed_workspaces_folder(home.path()),
        workspace_writes,
        clock,
        spawner,
        daemon_program,
    })
    .expect("the session services build");
    Fixture {
        database,
        log,
        epochs,
        folder_watch,
        workspaces,
        writes: Some(writes),
        session,
        home,
    }
}

impl Fixture {
    // Records a binding of a new running run of `session_id` through the services' cursors.
    async fn bind_new_run(&self, session_id: SessionId) -> RuntimeBindingId {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&self.database, session_id, run_id);
        let binding = self
            .session
            .binding_cursors
            .create(CreateRuntimeBindingInput {
                run_id,
                ..binding_input(
                    RuntimeBindingSpawnConfig::default(),
                    spawned_build("2.0.0", "/opt/provider/bin"),
                )
            })
            .await
            .expect("the binding is recorded");
        binding.id
    }

    // Publishes `event` on `session_id`'s log to the followers, as a committed write does.
    fn publish(&self, session_id: SessionId, event: &SessionEvent) {
        self.log.followers.publish(&[CommittedEvent {
            envelope: Arc::new(test_envelope(session_id, event)),
            sequence: SafeInt::new(1).expect("a sequence"),
        }]);
    }

    fn is_open(&self, binding_id: &RuntimeBindingId) -> bool {
        self.epochs
            .lock()
            .expect("no test thread panics holding the cursors")
            .binding(binding_id)
            .is_ok()
    }
}

// Killed by deleting the binding cursors' follow from the start's attachments: a live run's
// cursor then outlives its session's close.
#[tokio::test]
async fn the_started_follows_drop_a_closed_sessions_cursors() {
    let mut fixture = fixture().await;
    let followers = Arc::clone(&fixture.log.followers);
    let attachments = start_session_attachments(&fixture.session, &followers);
    let session_id = test_session_id();
    let live_binding = fixture.bind_new_run(session_id).await;
    assert!(fixture.is_open(&live_binding));

    fixture.publish(
        session_id,
        &SessionEvent::SessionClosed(SessionLifecycleChangePayload {
            session_id,
            previous_state: Some(SessionState::Active),
            new_state: SessionState::Closed,
            actor: None,
        }),
    );
    assert!(
        !fixture.is_open(&live_binding),
        "the session's close drops every cursor it held"
    );
    // The workspaces' watch ends with the stop, which closes the writes' channel.
    fixture.writes = None;
    assert!(
        attachments
            .stop(&mut fixture.session, &fixture.workspaces)
            .await
            .is_empty()
    );
    fixture.folder_watch.stop().await;
}

// Killed by the stop aborting the chat-version recording instead of waiting for it: the writes
// already sent are then lost.
#[tokio::test]
async fn the_stop_records_every_write_sent_before_it() {
    const WRITES: usize = 8;
    let mut fixture = fixture().await;
    let session_id = test_session_id();
    insert_session_row(
        &fixture.database.reader(),
        session_id.text().as_str(),
        None,
        None,
    );
    let workspace = managed_workspaces_folder(fixture.home.path()).join(session_id.to_string());
    std::fs::create_dir_all(&workspace).expect("the test makes the chat's workspace");
    let writes = fixture.writes.take().expect("the writes are sent once");
    for index in 0..WRITES {
        let name = format!("note-{index}.txt");
        std::fs::write(workspace.join(&name), format!("note {index}"))
            .expect("the test writes a file");
        writes
            .send(ManagedWorkspaceWrite {
                session_id,
                relative_path: name.into(),
                kind: ManagedWorkspaceWriteKind::File,
            })
            .await
            .expect("the recording reads the writes");
    }
    drop(writes);
    let followers = Arc::clone(&fixture.log.followers);
    let attachments = start_session_attachments(&fixture.session, &followers);

    let failures = attachments
        .stop(&mut fixture.session, &fixture.workspaces)
        .await;

    assert!(failures.is_empty(), "{failures:?}");
    let recorded: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT count(*) FROM artifact_manifests WHERE session_id = ?1",
            [session_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the test counts the versions");
    assert_eq!(recorded, i64::try_from(WRITES).expect("a small count"));
    fixture.folder_watch.stop().await;
}

// Killed by deleting either cycle's close from the build: the engine then still takes a run queue
// or an interventions service, and a run's end or a limit finds none.
#[tokio::test]
async fn the_build_closes_the_engines_cycles_before_it_returns() {
    let fixture = fixture().await;
    let engine = &fixture.session.engine;

    assert!(
        engine
            .set_interrupt_queue(Arc::downgrade(&fixture.session.queue) as Weak<_>)
            .is_err(),
        "the engine already holds the run queue"
    );
    assert!(
        engine
            .set_limit_interrupter(Arc::downgrade(&fixture.session.interventions) as Weak<_>)
            .is_err(),
        "the engine already holds the interventions service"
    );
    fixture.folder_watch.stop().await;
}
