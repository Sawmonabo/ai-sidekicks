//! A session's conversation resumed: a run bound on it after the resume, and the idle sleep's
//! wake of a session no process holds.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use sidekicks_provider::driver::idle_sleep::{KeptSchedule, SessionSleepState};
use sidekicks_provider::driver::test_registry::new_run_id;
use sidekicks_provider::runtime_binding::store::mint_runtime_binding_id;
use sidekicks_session::idle_sleep::openings::SessionProcessWaker;
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::test_session_id;
use tokio::time::timeout;

use super::{Opening, READ_STATEMENT_CAPACITY, WAIT};

/// The recurring job the wake's test stores for the session.
const CRON: &str = "0 9 * * 1";

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
        |_, _| {},
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
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;
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
        |_, _| {},
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

// A stored resume, as a wake after a daemon restart composes one, and a side question's source
// open no status leg, since the driver that resumes asks the session directory for its own legs and
// the copy runs under no binding of the session's; only the queue's own relaunch opens the legs of
// the binding it hands its process. A leg opened by the compose would be retired by its drop,
// taking the woken process's leg on the same binding with it. Killed by the compose opening the
// legs of the binding it composes for.
#[tokio::test]
async fn only_a_relaunch_opens_status_legs_and_a_composed_resume_opens_none() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;
    let pool = DatabaseReadPool::new(opening.database.path(), READ_STATEMENT_CAPACITY);
    let leg = read_session_leg(&pool, opening.session_id)
        .await
        .expect("the leg reads")
        .expect("the session ran");

    let stored = opening
        .sessions
        .compose_resume(opening.session_id, &leg, mint_runtime_binding_id())
        .await
        .expect("the stored resume composes");
    let side_question = opening
        .sessions
        .side_question_source(opening.session_id)
        .await
        .expect("the side question's source composes")
        .expect("the session ran");

    assert!(stored.params.on_mcp_server_status.is_none());
    assert!(side_question.resume.on_mcp_server_status.is_none());
    assert_eq!(lock(&opening.handed_ids).len(), 0, "a compose opened legs");
    timeout(WAIT, opening.sessions.wake_process(opening.session_id))
        .await
        .expect("the wake takes its own lock once")
        .expect("the conversation resumes");
    assert_eq!(
        lock(&opening.handed_ids).len(),
        1,
        "the relaunch opens its binding's legs"
    );
}
