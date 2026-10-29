//! A session's provider session resumed from a conversation an earlier daemon left, restarted,
//! and its process gone; the controls that act on the process are in `controls`, and a run bound
//! after a resume and the idle sleep's wake in `resume`.

mod controls;
mod resume;

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver, SessionProcessState};
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderSessionHandle, ResumeSessionParams,
};
use sidekicks_provider::driver::test_registry::{new_run_id, registry_of_first_provider};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;
use sidekicks_provider::runtime_binding::store::{CreateRuntimeBindingInput, RuntimeBindingStore};
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, spawn_config_on, spawned_build, test_provider_account_id,
};
use sidekicks_session::changes::{SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges};
use sidekicks_session::directory::row::{DirectoryEvent, directory_statements_for};
use sidekicks_session::idle_sleep::openings::{SessionProcessFollower, SessionProcessWaker};
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_session::run::epochs::ExecutionEpochs;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
    SessionAppendRefusal,
};
use sidekicks_store::events::session::appender::{SessionEventAppender, UnsequencedEventEnvelope};
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tokio::sync::Notify;
use tokio::time::timeout;

use super::test_opening::{
    RecordedProcessFollowing, record_first_provider_capabilities, test_execution_postures,
    test_opening_composer,
};
use super::{
    ProviderSessionError, ProviderSessionGitFolderReader, ProviderSessionOpeningComposer,
    ProviderSessions, ProviderSessionsDeps,
};

/// The statements the test's read pool prepares.
const READ_STATEMENT_CAPACITY: usize = 16;

/// Bounds the open, which waits on its own lock forever when it takes it twice.
const WAIT: Duration = Duration::from_secs(5);

/// How long a resume that would land inside a close is given to land there.
const CLOSE_HELD: Duration = Duration::from_millis(500);

/// What runs inside the fixture's driver resume, given the params it was handed.
type ResumeHook = Box<dyn Fn(&ResumeSessionParams) + Send + Sync>;

/// What runs as the close's `session.closed` is appended, before its write is queued.
type ClosedAppendHook = Box<dyn Fn() + Send + Sync>;

// A session an earlier daemon ran on its binding, its provider sessions and its changes sharing
// the transition lock, over a driver that resumes the conversation on the binding the queue minted,
// or on `came_up_on` once a test sets it, checking that binding's cursor is open as it runs, and
// closes at once, counting each close; each event changes the session's directory row, so a close
// leaves the session reading closed. Once a test sets `is_row_taken`, a resume first records a row
// under the binding it runs on, so the queue's own record of it fails; once it sets `git_folder`,
// an opening names that git folder.
struct Opening {
    database: TestDatabase,
    session_id: SessionId,
    earlier_run_id: RunId,
    run_id: RunId,
    predecessor_id: RuntimeBindingId,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    handed_ids: Arc<Mutex<Vec<RuntimeBindingId>>>,
    came_up_on: Arc<Mutex<Option<RuntimeBindingId>>>,
    is_row_taken: Arc<AtomicBool>,
    git_folder: Arc<Mutex<Option<FilesystemPath>>>,
    closes: Arc<AtomicUsize>,
    sessions: Arc<ProviderSessions>,
    execution_postures: Arc<ExecutionPostureService>,
    changes: Arc<SessionChanges>,
    following: Arc<RecordedProcessFollowing>,
}

impl Opening {
    // `on_resume` runs inside the driver's resume, `on_closed_append` as the close's
    // `session.closed` is appended, before its write is queued, and `expect` adds the test's own
    // expectations to the driver, which may watch the cursors and the bindings handed out.
    async fn new(
        on_resume: ResumeHook,
        on_closed_append: ClosedAppendHook,
        expect: impl FnOnce(&mut MockProviderDriver, &OpeningWatch),
    ) -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let session_id = test_session_id();
        let earlier_run_id = new_run_id();
        let run_id = new_run_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        insert_running_run(&database, session_id, earlier_run_id);
        insert_running_run(&database, session_id, run_id);
        queue_on_test_account(&database, session_id, run_id);
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: Some(Box::new(|envelope: &UnsequencedEventEnvelope| {
                Ok(directory_statements_for(&DirectoryEvent::from(envelope))?)
            })),
            refuse_session_write: Some(Box::new(
                move |_session_id: &SessionId, event_type: &str| {
                    if event_type == SessionEventType::SessionClosed.as_str() {
                        on_closed_append();
                    }
                    Ok::<(), SessionAppendRefusal>(())
                },
            )),
            read_damaged_from_sequence: None,
        }));
        let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        )));
        let store = Arc::new(RuntimeBindingStore::new(
            Arc::clone(&pool),
            Arc::clone(&writer),
        ));
        let binding_cursors = Arc::new(RunBindingCursors::new(
            Arc::clone(&pool),
            Arc::clone(&store),
            Arc::clone(&epochs),
        ));
        let predecessor_id = binding_cursors
            .create(
                session_id,
                CreateRuntimeBindingInput {
                    run_id: earlier_run_id,
                    ..binding_input(
                        spawn_config_on(test_provider_account_id()),
                        spawned_build("1.0.0", "/opt/provider/bin"),
                    )
                },
            )
            .await
            .expect("the earlier daemon's binding is recorded")
            .id;
        let handed_ids = Arc::new(Mutex::new(Vec::new()));
        let came_up_on = Arc::new(Mutex::new(None::<RuntimeBindingId>));
        let is_row_taken = Arc::new(AtomicBool::new(false));
        let closes = Arc::new(AtomicUsize::new(0));
        let git_folder = Arc::new(Mutex::new(None));
        let execution_postures = test_execution_postures();
        let on_resume: Arc<dyn Fn(&ResumeSessionParams) + Send + Sync> = Arc::from(on_resume);
        // The resume and the restart answer alike.
        let answer_relaunch = || {
            let (epochs, store) = (Arc::clone(&epochs), Arc::clone(&store));
            let (came_up_on, is_row_taken) = (Arc::clone(&came_up_on), Arc::clone(&is_row_taken));
            let on_resume = Arc::clone(&on_resume);
            move |params: ResumeSessionParams| {
                assert_eq!(params.resume_handle, "conversation-1");
                assert!(
                    lock(&epochs).binding(&params.binding_id).is_ok(),
                    "the resume's cursor is open before the process runs"
                );
                on_resume(&params);
                let binding_id = lock(&came_up_on)
                    .clone()
                    .unwrap_or_else(|| params.binding_id.clone());
                let taken = is_row_taken
                    .load(Ordering::SeqCst)
                    .then(|| params.binding_id.clone());
                let store = Arc::clone(&store);
                async move {
                    if let Some(taken) = taken {
                        take_row(&store, taken, earlier_run_id).await;
                    }
                    Ok(DriverResumeResult::Resumed {
                        binding_id,
                        session_position: SafeInt::new(1).expect("a position"),
                        resume_handle: NonEmptyText::new("conversation-1".to_owned())
                            .expect("a resume handle"),
                        spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
                    })
                }
                .boxed()
            }
        };
        let mut driver = MockProviderDriver::new();
        driver.expect_resume_session().returning(answer_relaunch());
        driver.expect_restart_session().returning(answer_relaunch());
        driver.expect_close_session().returning({
            let closes = Arc::clone(&closes);
            move |_params| {
                closes.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }.boxed()
            }
        });
        expect(
            &mut driver,
            &OpeningWatch {
                epochs: Arc::clone(&epochs),
                handed_ids: Arc::clone(&handed_ids),
                store: Arc::clone(&store),
            },
        );
        let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
        record_first_provider_capabilities(&providers, true);
        let changes = Arc::new(SessionChanges::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_CHANGES_STATEMENT_CAPACITY,
            )),
            Arc::clone(&event_log),
            Arc::clone(&providers),
        ));
        let following = Arc::new(RecordedProcessFollowing::default());
        let sessions = Arc::new(ProviderSessions::new(ProviderSessionsDeps {
            pool,
            appender: Arc::new(SessionEventAppender::new(
                event_log,
                SESSION_EVENT_VERSION.clone(),
            )),
            binding_cursors,
            providers,
            compose_opening: recording_composer(&handed_ids, &git_folder),
            read_git_folder: recording_git_folder(&git_folder),
            transition_lock: Arc::clone(changes.transition_lock()),
            process_follower: Arc::clone(&following) as Arc<dyn SessionProcessFollower>,
            execution_postures: Arc::clone(&execution_postures),
        }));
        execution_postures
            .set_stored_postures(Arc::downgrade(&sessions) as Weak<_>)
            .expect("a new posture service reads no stored level yet");
        Self {
            database,
            session_id,
            earlier_run_id,
            run_id,
            predecessor_id,
            epochs,
            handed_ids,
            came_up_on,
            is_row_taken,
            git_folder,
            closes,
            sessions,
            execution_postures,
            changes,
            following,
        }
    }

    // The binding the latest opening's process was handed to run under.
    fn handed_id(&self) -> RuntimeBindingId {
        lock(&self.handed_ids)
            .last()
            .cloned()
            .expect("an opening handed its process a binding")
    }
}

// Writes `run_id`'s `agent.run.queued` admitted against the test's account, as its admission
// would, so a create reads the account it runs on.
fn queue_on_test_account(database: &TestDatabase, session_id: SessionId, run_id: RunId) {
    let queued = SessionEventType::AgentRunQueued;
    database
        .reader()
        .execute(
            "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
               category, type, payload, run_id, run_version)
             VALUES (?1, ?2, 0, ?3, 0, ?4, ?5, ?6, ?7, 1)",
            params![
                mint_uuid_v7().to_string(),
                session_id.text().as_str(),
                WireInstant::now().as_str(),
                queued.category().as_str(),
                queued.as_str(),
                json!({
                    "runId": run_id.text().as_str(),
                    "admittedProviderAccountId": test_provider_account_id().as_str(),
                })
                .to_string(),
                run_id.text().as_str(),
            ],
        )
        .expect("the test queues the run");
}

// What a test's own driver expectations watch: the cursors, and each binding an opening handed its
// process.
struct OpeningWatch {
    epochs: Arc<Mutex<ExecutionEpochs>>,
    handed_ids: Arc<Mutex<Vec<RuntimeBindingId>>>,
    store: Arc<RuntimeBindingStore>,
}

// The test composer's opening, its callbacks recording each binding they are bound to, on
// `git_folder` once one is set.
fn recording_composer(
    handed_ids: &Arc<Mutex<Vec<RuntimeBindingId>>>,
    git_folder: &Arc<Mutex<Option<FilesystemPath>>>,
) -> ProviderSessionOpeningComposer {
    let composer = test_opening_composer();
    let (handed_ids, git_folder) = (Arc::clone(handed_ids), Arc::clone(git_folder));
    Arc::new(move |session_id, provider_account_id| {
        let (composer, handed_ids) = (Arc::clone(&composer), Arc::clone(&handed_ids));
        let git_folder = lock(&git_folder).clone();
        async move {
            let mut opening = composer(session_id, provider_account_id).await?;
            if let Some(git_folder) = git_folder {
                opening.git_folder = git_folder;
            }
            opening.function_legs_for = Arc::new(move |binding_id| {
                lock(&handed_ids).push(binding_id.clone());
                ResumeFunctionLegs::default()
            });
            Ok(opening)
        }
        .boxed()
    })
}

// Reads every session's git folder as `git_folder` names it once one is set, else the root.
fn recording_git_folder(
    git_folder: &Arc<Mutex<Option<FilesystemPath>>>,
) -> ProviderSessionGitFolderReader {
    let git_folder = Arc::clone(git_folder);
    Arc::new(move |_session_id| {
        let git_folder = lock(&git_folder)
            .clone()
            .unwrap_or_else(|| FilesystemPath::new("/".to_owned()).expect("the root is a path"));
        async move { Ok(git_folder) }.boxed()
    })
}

// Records a row under `binding_id` ahead of the queue, so the queue's own record of it fails.
async fn take_row(store: &RuntimeBindingStore, binding_id: RuntimeBindingId, run_id: RunId) {
    store
        .create(CreateRuntimeBindingInput {
            id: binding_id,
            run_id,
            ..binding_input(
                spawn_config_on(test_provider_account_id()),
                spawned_build("1.0.0", "/opt/provider/bin"),
            )
        })
        .await
        .expect("the test takes the binding's row");
}

// Opening a session whose conversation an earlier daemon left resumes it, and a restart of its
// process brings it back the same way: each records the binding it minted on its predecessor's run,
// the binding's cursor open while the driver runs (the fixture's driver checks), and an opening
// also records its run's own binding, all under the one hold it took. Killed by the run's binding
// taking the session's lock again inside the open (the test times out), by the relaunch left
// unrecorded, and by a restart that opens no cursor before its process runs.
#[rstest]
#[case::open(false)]
#[case::restart(true)]
#[tokio::test]
async fn a_resume_or_a_restart_records_its_binding_under_its_own_hold(#[case] is_restart: bool) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;

    if is_restart {
        timeout(WAIT, opening.sessions.restart(opening.session_id))
            .await
            .expect("the restart takes its own lock once")
            .expect("the conversation comes back");
    } else {
        timeout(
            WAIT,
            opening.sessions.open(opening.session_id, opening.run_id),
        )
        .await
        .expect("the open takes its own lock once")
        .expect("the conversation resumes");
    }

    let bindings: Vec<(String, String)> = opening
        .database
        .reader()
        .prepare("SELECT id, run_id FROM runtime_bindings ORDER BY created_at, id")
        .expect("the test reads the bindings")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the bindings read")
        .collect::<Result<_, _>>()
        .expect("each binding reads");
    assert_eq!(
        bindings.len(),
        if is_restart { 2 } else { 3 },
        "{bindings:?}"
    );
    assert!(
        bindings
            .iter()
            .any(|(id, bound_run_id)| id == opening.handed_id().as_str()
                && bound_run_id == opening.earlier_run_id.text().as_str()),
        "the relaunch is recorded on its predecessor's run: {bindings:?}"
    );
    assert!(
        is_restart
            || bindings
                .iter()
                .any(|(id, bound_run_id)| id != opening.predecessor_id.as_str()
                    && bound_run_id == opening.run_id.text().as_str()),
        "the opening run has its own binding: {bindings:?}"
    );
    assert_eq!(
        opening.following.followed(),
        vec![opening.session_id],
        "the idle sleep follows the opened session awake"
    );
}

// A session with no conversation yet is created: the cursor of the binding its process runs under
// is open before the create runs, and the binding's row names the build and the conversation the
// create reported; a failed create leaves no row and no cursor. Killed by the cursor opened after
// the create, by a failed create's cursor kept, by the row written before the create (a failed one
// keeps it), and by a version or handle the create did not report.
#[rstest]
#[case::created(true)]
#[case::refused(false)]
#[tokio::test]
async fn a_create_records_what_its_process_reported_and_a_failed_one_nothing(
    #[case] is_created: bool,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, watch| {
        let (epochs, handed_ids) = (Arc::clone(&watch.epochs), Arc::clone(&watch.handed_ids));
        driver.expect_create_session().returning(move |_params| {
            let binding_id = lock(&handed_ids)
                .last()
                .cloned()
                .expect("the create's process was handed a binding");
            assert!(
                lock(&epochs).binding(&binding_id).is_ok(),
                "the create's cursor is open before the process runs"
            );
            async move {
                if !is_created {
                    return Err(DriverError::Internal("the test's create fails".into()));
                }
                Ok(ProviderSessionHandle {
                    provider_session_id: "provider-session".to_owned(),
                    resume_handle: "conversation-2".to_owned(),
                    spawned_version: spawned_build("2.0.0", "/opt/provider/bin"),
                })
            }
            .boxed()
        });
    })
    .await;
    let reader = opening.database.reader();
    reader
        .execute("DELETE FROM runtime_bindings", [])
        .expect("the session is left with no conversation");

    let opened = opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await;

    let rows: Vec<(String, String, String)> = reader
        .prepare(
            "SELECT id, cli_version_raw, resume_handle FROM runtime_bindings WHERE run_id = ?1",
        )
        .expect("the test reads the bindings")
        .query_map([opening.run_id.text().as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .expect("the bindings read")
        .collect::<Result<_, _>>()
        .expect("each binding reads");
    if is_created {
        assert!(opened.is_ok(), "{opened:?}");
        let [(id, version, handle)] = rows.as_slice() else {
            panic!("one binding is recorded: {rows:?}");
        };
        assert_eq!(
            (version.as_str(), handle.as_str()),
            ("2.0.0", "conversation-2")
        );
        let binding_id = RuntimeBindingId::new(id.clone()).expect("a stored binding id");
        assert!(
            lock(&opening.epochs).binding(&binding_id).is_ok(),
            "the binding's cursor is open"
        );
    } else {
        assert!(
            matches!(opened, Err(ProviderSessionError::Driver(_))),
            "{opened:?}"
        );
        assert_eq!(rows, Vec::new());
        assert!(
            lock(&opening.epochs).binding(&opening.handed_id()).is_err(),
            "a failed create's cursor is forgotten"
        );
    }
}

// A run admitted before a close, whose open waits out the close, is refused once the close's
// `session.closed` is written, and no process comes up for the closed session. Killed by the open
// no longer reading the session's state (the conversation resumes after the close), and by the
// close letting the session's transition lock go before it writes the event, or the opening taking
// a lock of its own (the resume lands while the event's write is held).
// A run admitted before a close, whose open waits out the close, and an idle sleep's wake that
// waits it out too, are refused once the close's `session.closed` is written, and no process comes
// up for the closed session. Killed by the open or the wake no longer reading the session's state
// (the conversation resumes after the close), and by the close letting the session's transition
// lock go before it writes the event, or the opening or the wake taking a lock of its own (the
// resume lands while the event's write is held).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_or_a_wake_waiting_out_a_close_is_refused_and_starts_no_process() {
    let resumes = Arc::new(AtomicUsize::new(0));
    let resumed = Arc::new(Notify::new());
    let closing = Arc::new(Notify::new());
    let (release_close, close_released) = mpsc::channel::<()>();
    let close_released = Mutex::new(close_released);
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            let resumed = Arc::clone(&resumed);
            move |_| {
                resumes.fetch_add(1, Ordering::SeqCst);
                resumed.notify_one();
            }
        }),
        Box::new({
            let closing = Arc::clone(&closing);
            move || {
                closing.notify_one();
                // Held on a worker the runtime hands its other tasks off from.
                tokio::task::block_in_place(|| {
                    close_released
                        .lock()
                        .expect("the release's lock holds")
                        .recv()
                        .expect("the test releases the close");
                });
            }
        }),
        |_, _| {},
    )
    .await;
    let session_id = opening.session_id;
    let run_id = opening.run_id;

    let close = tokio::spawn({
        let changes = Arc::clone(&opening.changes);
        async move { changes.close(session_id).await }
    });
    closing.notified().await;
    let open = tokio::spawn({
        let sessions = Arc::clone(&opening.sessions);
        async move { sessions.open(session_id, run_id).await }
    });
    let wake = tokio::spawn({
        let sessions = Arc::clone(&opening.sessions);
        async move { sessions.wake_process(session_id).await }
    });
    assert!(
        timeout(CLOSE_HELD, resumed.notified()).await.is_err(),
        "the resume waits while the close's event is held"
    );
    release_close
        .send(())
        .expect("the close waits for its release");

    timeout(WAIT, close)
        .await
        .expect("the close ends")
        .expect("the close's task ends whole")
        .expect("the session closes");
    let opened = timeout(WAIT, open)
        .await
        .expect("the open ends")
        .expect("the open's task ends whole");
    assert!(
        matches!(
            opened,
            Err(ProviderSessionError::Closed { session_id: refused }) if refused == session_id
        ),
        "the open is refused for the closed session: {opened:?}"
    );
    let woken = timeout(WAIT, wake)
        .await
        .expect("the wake ends")
        .expect("the wake's task ends whole");
    assert!(
        woken.as_ref().is_err_and(|error| matches!(
            error.downcast_ref::<ProviderSessionError>(),
            Some(ProviderSessionError::Closed { session_id: refused }) if *refused == session_id
        )),
        "the wake is refused for the closed session: {woken:?}"
    );
    assert_eq!(
        resumes.load(Ordering::SeqCst),
        0,
        "no process comes up for the closed session"
    );
}

// A closed session and one being deleted take no process, no restart, no run binding and no level
// change: each is refused under the session's hold and no process comes up. Killed by any of the
// four paths no longer reading the session's state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ended_session_is_refused_an_opening_a_restart_a_binding_and_a_level_change() {
    for state in [SessionState::Closed, SessionState::PurgeRequested] {
        let resumes = Arc::new(AtomicUsize::new(0));
        let opening = Opening::new(
            Box::new({
                let resumes = Arc::clone(&resumes);
                move |_| {
                    resumes.fetch_add(1, Ordering::SeqCst);
                }
            }),
            Box::new(|| {}),
            |_, _| {},
        )
        .await;
        let session_id = opening.session_id;
        let run_id = opening.run_id;
        opening
            .database
            .reader()
            .execute(
                "UPDATE sessions SET state = ?1 WHERE id = ?2",
                [<&'static str>::from(state), session_id.text().as_str()],
            )
            .expect("the session's state is stored");
        let refused = |answer: &ProviderSessionError| match state {
            SessionState::Closed => matches!(
                answer,
                ProviderSessionError::Closed { session_id: refused } if *refused == session_id
            ),
            SessionState::PurgeRequested => matches!(
                answer,
                ProviderSessionError::BeingDeleted { session_id: refused } if *refused == session_id
            ),
            SessionState::Provisioning | SessionState::Active | SessionState::Archived => false,
        };
        let opened = opening.sessions.open(session_id, run_id).await;
        assert!(
            opened.as_ref().is_err_and(refused),
            "the open is refused for the {state:?} session: {opened:?}"
        );
        let restarted = opening.sessions.restart(session_id).await;
        assert!(
            restarted.as_ref().is_err_and(refused),
            "the restart is refused for the {state:?} session: {restarted:?}"
        );
        let bound = opening.sessions.open_run_binding(run_id, session_id).await;
        assert!(
            bound.as_ref().is_err_and(refused),
            "the binding is refused for the {state:?} session: {bound:?}"
        );
        let changed = opening
            .sessions
            .change_level(session_id, PermissionLevel::Readonly)
            .await;
        assert!(
            changed.as_ref().is_err_and(refused),
            "the level change is refused for the {state:?} session: {changed:?}"
        );
        assert_eq!(
            resumes.load(Ordering::SeqCst),
            0,
            "no process comes up for the {state:?} session"
        );
    }
}

// A restart reaches no driver whose provider cannot resume: it is refused with its code and no
// process comes up. Killed by the capability check dropped: the driver that cannot resume is
// resumed.
#[tokio::test]
async fn a_restart_the_provider_cannot_take_is_refused_before_its_driver() {
    let resumes = Arc::new(AtomicUsize::new(0));
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            move |_| {
                resumes.fetch_add(1, Ordering::SeqCst);
            }
        }),
        Box::new(|| {}),
        |_, _| {},
    )
    .await;
    record_first_provider_capabilities(&opening.sessions.deps.providers, false);

    let restarted = opening.sessions.restart(opening.session_id).await;

    assert!(
        matches!(
            &restarted,
            Err(ProviderSessionError::Provider(refusal))
                if refusal.code == RefusalCode::ProviderCapabilityUnsupported
        ),
        "{restarted:?}"
    );
    assert_eq!(resumes.load(Ordering::SeqCst), 0, "no process comes up");
}

// A process gone with no restart pending is forgotten, so the next admission resumes the session
// again; one its driver brings back keeps its opening. Killed by a process gone that is not
// forgotten (the second open resumes nothing), and by forgetting a process the driver restarts.
#[rstest]
#[case::down(SessionProcessState::Down, 2)]
#[case::restarting(SessionProcessState::Restarting, 1)]
#[tokio::test]
async fn a_gone_process_is_forgotten_only_with_no_restart_pending(
    #[case] state: SessionProcessState,
    #[case] expected_resumes: usize,
) {
    let resumes = Arc::new(AtomicUsize::new(0));
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            move |_| {
                resumes.fetch_add(1, Ordering::SeqCst);
            }
        }),
        Box::new(|| {}),
        |driver, _| {
            driver.expect_session_process_state().return_const(state);
        },
    )
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");

    opening
        .sessions
        .forget_gone_process(opening.session_id)
        .await
        .expect("the driver answers");
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the session opens again");

    assert_eq!(resumes.load(Ordering::SeqCst), expected_resumes);
}

// A resume a process already up answers on the leg's own binding records no row, keeps the leg's
// cursor open and forgets the one minted for it. Killed by the answer's binding not compared with
// the minted one (its record fails on the leg's row and forgets the leg's cursor), and by the
// minted cursor kept.
#[tokio::test]
async fn a_resume_answered_on_the_legs_own_binding_records_nothing() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;
    *lock(&opening.came_up_on) = Some(opening.predecessor_id.clone());

    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the live process answers");

    let minted_id = opening.handed_id();
    let minted_rows: i64 = opening
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM runtime_bindings WHERE id = ?1",
            [minted_id.as_str()],
            |row| row.get(0),
        )
        .expect("the bindings count");
    assert_eq!(minted_rows, 0);
    let epochs = lock(&opening.epochs);
    assert!(epochs.binding(&opening.predecessor_id).is_ok());
    assert!(epochs.binding(&minted_id).is_err());
}

// A process whose binding's row fails to write is closed, on a create and on a resume alike, so
// none runs under a binding with no row. Killed by either opening leaving the process running.
#[rstest]
#[case::create(true)]
#[case::resume(false)]
#[tokio::test]
async fn a_process_whose_binding_row_fails_is_closed(#[case] is_create: bool) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, watch| {
        let (handed_ids, store) = (Arc::clone(&watch.handed_ids), Arc::clone(&watch.store));
        driver.expect_create_session().returning(move |_params| {
            let binding_id = lock(&handed_ids)
                .last()
                .cloned()
                .expect("the create's process was handed a binding");
            let store = Arc::clone(&store);
            async move {
                take_row(&store, binding_id, new_run_id()).await;
                Ok(ProviderSessionHandle {
                    provider_session_id: "provider-session".to_owned(),
                    resume_handle: "conversation-2".to_owned(),
                    spawned_version: spawned_build("2.0.0", "/opt/provider/bin"),
                })
            }
            .boxed()
        });
    })
    .await;
    if is_create {
        opening
            .database
            .reader()
            .execute("DELETE FROM runtime_bindings", [])
            .expect("the session is left with no conversation");
    } else {
        opening.is_row_taken.store(true, Ordering::SeqCst);
    }

    let opened = opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await;

    assert!(
        matches!(opened, Err(ProviderSessionError::Cursor(_))),
        "{opened:?}"
    );
    assert_eq!(opening.closes.load(Ordering::SeqCst), 1);
}
