//! A session's provider session resumed from a conversation an earlier daemon left, and the
//! controls that act on its process.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionCodeReviewStartRequest, SessionMode, SessionReviewTarget,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver, SessionProcessState};
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderSessionHandle, ResumeSessionParams,
};
use sidekicks_provider::driver::test_registry::{new_run_id, registry_of_first_provider};
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBindingSpawnConfig, RuntimeBindingStore,
};
use sidekicks_provider::runtime_binding::test_store::{binding_input, spawned_build};
use sidekicks_session::changes::{SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges};
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::directory::row::{DirectoryEvent, directory_statements_for};
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
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;
use sidekicks_store::events::session::followers::SessionEventFollowers;
use tokio::sync::Notify;
use tokio::time::timeout;

use super::test_opening::{record_first_provider_capabilities, test_opening_composer};
use super::{ProviderSessionError, ProviderSessions, ProviderSessionsDeps};

/// The statements the test's read pool prepares.
const READ_STATEMENT_CAPACITY: usize = 16;

/// Bounds the open, which waits on its own lock forever when it takes it twice.
const WAIT: Duration = Duration::from_secs(5);

/// How long a resume that would land inside a close is given to land there.
const CLOSE_HELD: Duration = Duration::from_millis(500);

/// What runs inside the fixture's driver resume.
type ResumeHook = Box<dyn Fn() + Send + Sync>;

/// What runs as the close's `session.closed` is appended, before its write is queued.
type ClosedAppendHook = Box<dyn Fn() + Send + Sync>;

// A session an earlier daemon ran on its binding, its provider sessions and its changes sharing
// the transition lock, over a driver that resumes the conversation, the first resume on the binding
// `relaunched_id` and each later one on a fresh one, and closes at once; each event changes the
// session's directory row, so a close leaves the session reading closed.
struct Opening {
    database: TestDatabase,
    session_id: SessionId,
    earlier_run_id: RunId,
    run_id: RunId,
    predecessor_id: RuntimeBindingId,
    relaunched_id: RuntimeBindingId,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    sessions: Arc<ProviderSessions>,
    changes: Arc<SessionChanges>,
}

impl Opening {
    // `on_resume` runs inside the driver's resume, `on_closed_append` as the close's
    // `session.closed` is appended, before its write is queued, and `expect` adds the test's own
    // expectations to the driver.
    async fn new(
        on_resume: ResumeHook,
        on_closed_append: ClosedAppendHook,
        expect: impl FnOnce(&mut MockProviderDriver),
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
        let binding_cursors = Arc::new(RunBindingCursors::new(
            Arc::clone(&pool),
            Arc::new(RuntimeBindingStore::new(
                Arc::clone(&pool),
                Arc::clone(&writer),
            )),
            Arc::clone(&epochs),
        ));
        let predecessor_id = binding_cursors
            .create(CreateRuntimeBindingInput {
                run_id: earlier_run_id,
                ..binding_input(
                    RuntimeBindingSpawnConfig::default(),
                    spawned_build("1.0.0", "/opt/provider/bin"),
                )
            })
            .await
            .expect("the earlier daemon's binding is recorded")
            .id;
        let relaunched_id =
            RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a UUID is a binding id");
        let first_minted = Mutex::new(Some(relaunched_id.clone()));
        let mut driver = MockProviderDriver::new();
        driver.expect_resume_session().returning(move |params| {
            assert_eq!(params.resume_handle, "conversation-1");
            on_resume();
            let binding_id = first_minted
                .lock()
                .expect("the minted id's lock holds")
                .take()
                .unwrap_or_else(|| {
                    RuntimeBindingId::new(mint_uuid_v7().to_string())
                        .expect("a UUID is a binding id")
                });
            async move {
                Ok(DriverResumeResult::Resumed {
                    binding_id,
                    session_position: SafeInt::new(1).expect("a position"),
                    resume_handle: NonEmptyText::new("conversation-1".to_owned())
                        .expect("a resume handle"),
                    spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
                })
            }
            .boxed()
        });
        driver
            .expect_close_session()
            .returning(|_params| async { Ok(()) }.boxed());
        expect(&mut driver);
        let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
        record_first_provider_capabilities(&providers);
        let changes = Arc::new(SessionChanges::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_CHANGES_STATEMENT_CAPACITY,
            )),
            event_log,
            Arc::clone(&providers),
        ));
        let sessions = Arc::new(ProviderSessions::new(ProviderSessionsDeps {
            pool,
            writer,
            binding_cursors,
            providers,
            compose_opening: test_opening_composer(),
            transition_lock: Arc::clone(changes.transition_lock()),
        }));
        Self {
            database,
            session_id,
            earlier_run_id,
            run_id,
            predecessor_id,
            relaunched_id,
            epochs,
            sessions,
            changes,
        }
    }
}

// Opening a session whose conversation an earlier daemon left resumes it, records the binding the
// resume minted on its predecessor's run, and records the opening run's own binding on it, all
// under the one hold the open took. Killed by the run's binding taking the session's lock again
// inside the open (the test times out), or by the relaunch left unrecorded.
#[tokio::test]
async fn open_resumes_a_conversation_and_binds_the_run_under_its_own_hold() {
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |_| {}).await;

    timeout(
        WAIT,
        opening.sessions.open(opening.session_id, opening.run_id),
    )
    .await
    .expect("the open takes its own lock once")
    .expect("the conversation resumes");

    let bindings: Vec<(String, String)> = opening
        .database
        .reader()
        .prepare("SELECT id, run_id FROM runtime_bindings ORDER BY created_at, id")
        .expect("the test reads the bindings")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the bindings read")
        .collect::<Result<_, _>>()
        .expect("each binding reads");
    assert_eq!(bindings.len(), 3, "{bindings:?}");
    assert!(
        bindings
            .iter()
            .any(|(id, bound_run_id)| id == opening.relaunched_id.as_str()
                && bound_run_id == opening.earlier_run_id.text().as_str()),
        "the relaunch is recorded on its predecessor's run: {bindings:?}"
    );
    assert!(
        bindings
            .iter()
            .any(|(id, bound_run_id)| id != opening.predecessor_id.as_str()
                && bound_run_id == opening.run_id.text().as_str()),
        "the opening run has its own binding: {bindings:?}"
    );
}

// A session with no conversation yet is created: the row of the binding its process runs under
// names the build and the conversation the create reported, with its cursor open, and a failed
// create leaves no row. Killed by the row written before the create (a failed one keeps it), and by
// a version or handle the create did not report.
#[rstest]
#[case::created(true)]
#[case::refused(false)]
#[tokio::test]
async fn a_create_records_what_its_process_reported_and_a_failed_one_nothing(
    #[case] is_created: bool,
) {
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |driver| {
        driver.expect_create_session().returning(move |_params| {
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
    }
}

// A run admitted before a close, whose open waits out the close, is refused once the close's
// `session.closed` is written, and no process comes up for the closed session. Killed by the open
// no longer reading the session's state (the conversation resumes after the close), and by the
// close letting the session's transition lock go before it writes the event, or the opening taking
// a lock of its own (the resume lands while the event's write is held).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_waiting_out_a_close_is_refused_and_starts_no_process() {
    let resumes = Arc::new(AtomicUsize::new(0));
    let resumed = Arc::new(Notify::new());
    let closing = Arc::new(Notify::new());
    let (release_close, close_released) = mpsc::channel::<()>();
    let close_released = Mutex::new(close_released);
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            let resumed = Arc::clone(&resumed);
            move || {
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
        |_| {},
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
    assert_eq!(
        resumes.load(Ordering::SeqCst),
        0,
        "no process comes up for the closed session"
    );
}

// A closed session and one being deleted take no process, no run binding and no level change:
// each is refused under the session's hold and no process comes up. Killed by any of the three
// paths no longer reading the session's state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ended_session_is_refused_an_opening_a_binding_and_a_level_change() {
    for state in [SessionState::Closed, SessionState::PurgeRequested] {
        let resumes = Arc::new(AtomicUsize::new(0));
        let opening = Opening::new(
            Box::new({
                let resumes = Arc::clone(&resumes);
                move || {
                    resumes.fetch_add(1, Ordering::SeqCst);
                }
            }),
            Box::new(|| {}),
            |_| {},
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

// A mode move on a session whose process is down only stores it, leaving the driver alone; on one
// whose process runs or whose driver brings it back, the driver moves first, and its refusal
// leaves the stored mode as it was. Killed by storing before the move, and by a restarting process
// that skips the driver.
#[rstest]
#[case::live(SessionProcessState::Live)]
#[case::restarting(SessionProcessState::Restarting)]
#[case::down(SessionProcessState::Down)]
#[tokio::test]
async fn a_mode_move_reaches_the_driver_first_unless_the_process_is_down(
    #[case] state: SessionProcessState,
) {
    let is_down = state == SessionProcessState::Down;
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |driver| {
        driver.expect_session_process_state().return_const(state);
        driver
            .expect_update_session_mode()
            .times(usize::from(!is_down))
            .returning(|_params| {
                async {
                    Err(DriverError::Refused(DomainError::new(
                        "The provider refused the mode.",
                        RefusalCode::SessionModeNotOffered,
                    )))
                }
                .boxed()
            });
    })
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");

    let moved = opening
        .sessions
        .change_mode(opening.session_id, SessionMode::Plan)
        .await;

    let stored = read_session_mode(&opening.database.reader(), &opening.session_id)
        .expect("the stored mode reads");
    if is_down {
        assert!(moved.is_ok(), "{moved:?}");
        assert_eq!(stored, SessionMode::Plan);
    } else {
        assert!(
            matches!(moved, Err(ProviderSessionError::Driver(_))),
            "{moved:?}"
        );
        assert_eq!(stored, SessionMode::Build);
    }
}

// A side question's copy is forked from the session's newest conversation whether or not a
// process runs it, and a session that never ran has none to fork. Killed by resume material only
// for a session this daemon has not opened, and by none at all.
#[tokio::test]
async fn a_side_question_forks_the_newest_conversation_whatever_the_process() {
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |driver| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
    })
    .await;
    let resume_handle =
        |resume: Option<ResumeSessionParams>| resume.map(|params| params.resume_handle);

    let at_rest = opening
        .sessions
        .side_question_resume(opening.session_id)
        .await
        .expect("the resume material composes");
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let running = opening
        .sessions
        .side_question_resume(opening.session_id)
        .await
        .expect("the resume material composes");
    let never_ran = test_session_id();
    insert_session_row(
        &opening.database.reader(),
        never_ran.text().as_str(),
        None,
        None,
    );
    let none = opening
        .sessions
        .side_question_resume(never_ran)
        .await
        .expect("a session with no conversation reads");

    assert_eq!(resume_handle(at_rest).as_deref(), Some("conversation-1"));
    assert_eq!(resume_handle(running).as_deref(), Some("conversation-1"));
    assert!(none.is_none());
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
            move || {
                resumes.fetch_add(1, Ordering::SeqCst);
            }
        }),
        Box::new(|| {}),
        |driver| {
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

// On a session whose process runs, a review starts through the driver at once and nothing is
// queued; on one whose process is down or being brought back, the review is queued as the
// session's next item and the driver is not called. Killed by a direct driver call that skips the
// queue, and by queueing a review a running process could start.
#[rstest]
#[case::live(SessionProcessState::Live)]
#[case::restarting(SessionProcessState::Restarting)]
#[case::down(SessionProcessState::Down)]
#[tokio::test]
async fn a_review_starts_at_once_only_on_a_running_process(#[case] state: SessionProcessState) {
    let is_live = state == SessionProcessState::Live;
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |driver| {
        driver.expect_session_process_state().return_const(state);
        driver
            .expect_start_review()
            .times(usize::from(is_live))
            .returning(|_params| async { Ok(()) }.boxed());
    })
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let request = SessionCodeReviewStartRequest {
        session_id: opening.session_id,
        target: SessionReviewTarget::WorkingTree,
    };
    let queued = Mutex::new(Vec::new());

    opening
        .sessions
        .start_review(request.clone(), |request| {
            queued
                .lock()
                .expect("the queued reviews' lock holds")
                .push(request);
            std::future::ready(Ok(()))
        })
        .await
        .expect("the review starts");

    let queued = queued.into_inner().expect("the queued reviews' lock holds");
    if is_live {
        assert!(queued.is_empty(), "{queued:?}");
    } else {
        assert_eq!(queued, [request]);
    }
}
