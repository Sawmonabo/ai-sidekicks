//! The session services built as the daemon's start builds them, over a test database, a test
//! registry and a temporary home: their follows of the log once started.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, Weak};

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
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    SessionServiceStart, SessionServices, build_session_services, start_session_attachments,
};
use crate::admission::memory_gate::{MemoryGate, MemoryGateFigures};
use crate::artifacts::admission::UploadAdmission;
use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::publish::ArtifactPublishService;
use crate::daemon::machine::local::LocalMachine;
use crate::daemon::process::repo_services::{RepoServiceStart, RepoServices, build_repo_services};
use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::followers::CommittedEvent;
use crate::events::session::read::DamagedFromSequenceReader;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::git::worktree::watch::WorkingFolderWatcher;
use crate::policy::authorizer::Authorizer;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::test_registry::registry_of_first_provider;
use crate::provider::runtime_binding::store::CreateRuntimeBindingInput;
use crate::provider::runtime_binding::store::{RuntimeBindingSpawnConfig, RuntimeBindingStore};
use crate::provider::runtime_binding::test_store::{binding_input, spawned_build};
use crate::queue::delivery::{ProviderProcessIdentity, ProviderProcessIds};
use crate::queue::provider_session::test_opening::test_opening_composer;
use crate::session::directory::list_feed::SessionListFeed;
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::engine::tests::insert_running_run;
use crate::session::run::epochs::ExecutionEpochs;
use crate::workspace::managed::service::{ManagedWorkspaceService, managed_workspaces_folder};
use crate::workspace::managed::write_watcher::{ManagedWorkspaceWrite, ManagedWorkspaceWriteKind};

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
    let database = TestDatabase::new();
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
    let list_feed = Arc::new(SessionListFeed::new(
        Arc::clone(&reads),
        &log.followers,
        Arc::clone(&scheduler),
    ));
    let machine = LocalMachine {
        machine_id: MachineId::new(mint_uuid_v7().to_string()).expect("a machine id"),
        owner_user_id: UserId::try_from(mint_uuid_v7()).expect("a user id"),
        name: "desk".to_owned(),
    };
    let repo = build_repo_services(RepoServiceStart {
        home_folder: home.path().to_path_buf(),
        run_folder: home.path().join("run"),
        daemon_program: daemon_program.clone(),
        spawner: spawner.clone(),
        git_executable: None,
        base_environment: Arc::from([]),
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
        git,
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
        authorizer: Arc::new(Authorizer::load_built_in().expect("the built-in rules load")),
        data_folder: home.path().join("data"),
        working_folders: Arc::clone(&folder_watch),
        git,
        list_feed,
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
