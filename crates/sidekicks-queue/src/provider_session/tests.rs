//! A session's provider session resumed from a conversation an earlier daemon left.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::idle_sleep::KeptSchedule;
use sidekicks_provider::driver::idle_sleep::SessionSleepState;
use sidekicks_provider::driver::session_control::{DriverResumeResult, ResumeSessionParams};
use sidekicks_provider::driver::test_registry::{new_run_id, registry_of_first_provider};
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
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;
use sidekicks_store::events::session::followers::SessionEventFollowers;
use tokio::sync::Notify;
use tokio::time::timeout;

use super::test_opening::{
    RecordedProcessFollowing, record_first_provider_capabilities, test_opening_composer,
};
use super::{ProviderSessionError, ProviderSessions, ProviderSessionsDeps};

/// The statements the test's read pool prepares.
const READ_STATEMENT_CAPACITY: usize = 16;

/// Bounds the open, which waits on its own lock forever when it takes it twice.
const WAIT: Duration = Duration::from_secs(5);

/// How long a resume that would land inside a close is given to land there.
const CLOSE_HELD: Duration = Duration::from_millis(500);

/// The recurring job the wake's test stores for the session.
const CRON: &str = "0 9 * * 1";

/// What runs inside the fixture's driver resume, given the params it was handed.
type ResumeHook = Box<dyn Fn(&ResumeSessionParams) + Send + Sync>;

/// What runs as the close's `session.closed` is appended, before its write is queued.
type ClosedAppendHook = Box<dyn Fn() + Send + Sync>;

// A session an earlier daemon ran on its binding, its provider sessions and its changes sharing
// the transition lock, over a driver that resumes the conversation and closes at once; each event
// changes the session's directory row, so a close leaves the session reading closed.
struct Opening {
    database: TestDatabase,
    session_id: SessionId,
    earlier_run_id: RunId,
    run_id: RunId,
    predecessor_id: RuntimeBindingId,
    relaunched_id: RuntimeBindingId,
    sessions: Arc<ProviderSessions>,
    changes: Arc<SessionChanges>,
    following: Arc<RecordedProcessFollowing>,
}

impl Opening {
    // `on_resume` runs inside the driver's resume, and `on_closed_append` as the close's
    // `session.closed` is appended, before its write is queued.
    async fn new(on_resume: ResumeHook, on_closed_append: ClosedAppendHook) -> Self {
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
        let runtime_bindings = Arc::new(RuntimeBindingStore::new(
            Arc::clone(&pool),
            Arc::clone(&writer),
        ));
        let binding_cursors = Arc::new(RunBindingCursors::new(
            Arc::clone(&pool),
            Arc::clone(&runtime_bindings),
            Arc::new(Mutex::new(ExecutionEpochs::new(
                NonZeroUsize::new(8).expect("the cap is not zero"),
            ))),
        ));
        let predecessor_id = binding_cursors
            .create(CreateRuntimeBindingInput {
                run_id: earlier_run_id,
                ..binding_input(
                    spawn_config_on(test_provider_account_id()),
                    spawned_build("1.0.0", "/opt/provider/bin"),
                )
            })
            .await
            .expect("the earlier daemon's binding is recorded")
            .id;
        let relaunched_id =
            RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a UUID is a binding id");
        let minted = relaunched_id.clone();
        let mut driver = MockProviderDriver::new();
        driver.expect_resume_session().returning(move |params| {
            assert_eq!(params.resume_handle, "conversation-1");
            on_resume(&params);
            let binding_id = minted.clone();
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
        let following = Arc::new(RecordedProcessFollowing::default());
        let sessions = Arc::new(ProviderSessions::new(ProviderSessionsDeps {
            pool,
            writer,
            runtime_bindings,
            binding_cursors,
            providers,
            compose_opening: test_opening_composer(),
            transition_lock: Arc::clone(changes.transition_lock()),
            process_follower: Arc::clone(&following) as Arc<dyn SessionProcessFollower>,
        }));
        Self {
            database,
            session_id,
            earlier_run_id,
            run_id,
            predecessor_id,
            relaunched_id,
            sessions,
            changes,
            following,
        }
    }
}

// Opening a session whose conversation an earlier daemon left resumes it, records the binding the
// resume minted on its predecessor's run, and records the opening run's own binding on it, all
// under the one hold the open took. Killed by the run's binding taking the session's lock again
// inside the open (the test times out), or by the relaunch left unrecorded.
#[tokio::test]
async fn open_resumes_a_conversation_and_binds_the_run_under_its_own_hold() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {})).await;

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
    assert_eq!(
        opening.following.followed(),
        vec![opening.session_id],
        "the idle sleep follows the opened session awake"
    );
}

// A run whose binding fails after its open resumed the session's conversation fails alone: the
// resumed process stays opened, so the next message binds its run to it and resumes nothing.
// Killed by a failed binding that forgets the opening (the next open resumes a second process).
#[tokio::test]
async fn a_failed_binding_after_a_resume_leaves_one_process_for_the_next_message() {
    let resumes = Arc::new(AtomicUsize::new(0));
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            move |_| {
                resumes.fetch_add(1, Ordering::SeqCst);
            }
        }),
        Box::new(|| {}),
    )
    .await;
    let reader = opening.database.reader();
    reader
        .execute_batch(&format!(
            "CREATE TRIGGER refuse_the_runs_binding BEFORE INSERT ON runtime_bindings
               WHEN NEW.run_id = '{}'
             BEGIN SELECT RAISE(ABORT, 'the test refuses the binding'); END;",
            opening.run_id.text().as_str()
        ))
        .expect("the test refuses the run's binding");

    let failed = timeout(
        WAIT,
        opening.sessions.open(opening.session_id, opening.run_id),
    )
    .await
    .expect("the open takes its own lock once");
    reader
        .execute_batch("DROP TRIGGER refuse_the_runs_binding")
        .expect("the test lets the binding through");
    let next_run_id = new_run_id();
    insert_running_run(&opening.database, opening.session_id, next_run_id);
    timeout(WAIT, opening.sessions.open(opening.session_id, next_run_id))
        .await
        .expect("the open takes its own lock once")
        .expect("the next run opens on the resumed process");
    let next_binding = timeout(
        WAIT,
        opening
            .sessions
            .open_run_binding(next_run_id, opening.session_id),
    )
    .await
    .expect("the binding takes its own lock once");

    assert!(failed.is_err(), "the run whose binding failed fails");
    assert!(next_binding.is_ok(), "{next_binding:?}");
    assert_eq!(resumes.load(Ordering::SeqCst), 1, "one process comes up");
}

// A run bound on a session's open leg carries the leg's recovery data, so a run opened before any
// usage report keeps the fixed start the provider stored on the leg. Killed by a new run's binding
// recorded with empty recovery data.
#[tokio::test]
async fn a_run_bound_on_the_leg_carries_its_recovery_data() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {})).await;
    timeout(
        WAIT,
        opening.sessions.open(opening.session_id, opening.run_id),
    )
    .await
    .expect("the open takes its own lock once")
    .expect("the conversation resumes");
    let reader = opening.database.reader();
    // The session's newest binding, the opening run's own, is its leg.
    reader
        .execute(
            "UPDATE runtime_bindings SET runtime_metadata = '{\"contextFixedStartTokens\":12000}'
             WHERE run_id = ?1",
            [opening.run_id.text().as_str()],
        )
        .expect("the test stores the leg's fixed start");
    let next_run_id = new_run_id();
    insert_running_run(&opening.database, opening.session_id, next_run_id);

    let next_binding = timeout(
        WAIT,
        opening
            .sessions
            .open_run_binding(next_run_id, opening.session_id),
    )
    .await
    .expect("the binding takes its own lock once")
    .expect("the next run binds on the leg");

    let recovery_data: String = reader
        .query_row(
            "SELECT runtime_metadata FROM runtime_bindings WHERE id = ?1",
            [next_binding.as_str()],
            |row| row.get(0),
        )
        .expect("the next run's binding reads");
    assert_eq!(recovery_data, r#"{"contextFixedStartTokens":12000}"#);
}

// The idle sleep's wake of a session no process holds, as after a daemon restart, resumes its
// conversation once with the timed fires the idle sleep stored for it and no other session's, and
// records it as the session's opening, so the next admission binds its run to that process and
// resumes nothing. Killed by a resume composed without the stored fires, by the wake no longer
// recording the opening (the open resumes a second time), and by an opening not telling the idle
// sleep (the session is not followed awake).
#[tokio::test]
async fn a_wake_resumes_a_sleeping_session_once_with_its_kept_schedules() {
    let resumes = Arc::new(Mutex::new(Vec::new()));
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            move |params| {
                lock(&resumes).push(params.kept_schedules.clone());
            }
        }),
        Box::new(|| {}),
    )
    .await;
    for (stored_session_id, cron) in [(opening.session_id, CRON), (test_session_id(), "0 0 * * *")]
    {
        opening
            .database
            .reader()
            .execute(
                "INSERT INTO session_kept_schedules (session_id, position, cron) \
                 VALUES (?1, 0, ?2)",
                [stored_session_id.text().as_str(), cron],
            )
            .expect("the test stores a kept schedule");
    }

    let woken = timeout(WAIT, opening.sessions.wake_process(opening.session_id))
        .await
        .expect("the wake takes its own lock once")
        .expect("the conversation resumes");
    assert_eq!(woken, SessionSleepState::Awake);
    timeout(
        WAIT,
        opening.sessions.open(opening.session_id, opening.run_id),
    )
    .await
    .expect("the open takes its own lock once")
    .expect("the run binds to the woken process");

    assert_eq!(
        *lock(&resumes),
        [vec![KeptSchedule::Recurring {
            cron: CRON.to_owned(),
            next_fire_at: None,
        }]],
        "one process comes up for the session, with its own kept schedules"
    );
    assert_eq!(
        opening.following.followed(),
        vec![opening.session_id],
        "the idle sleep follows the woken session awake"
    );
}

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
                move |_| {
                    resumes.fetch_add(1, Ordering::SeqCst);
                }
            }),
            Box::new(|| {}),
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
