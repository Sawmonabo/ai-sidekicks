//! A session's conversation resumed: the live runs it names to the provider, the provider's answer
//! for them handed on before the binding is recorded, a run bound on it after the resume, and the
//! idle sleep's wake of a session no process holds.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rstest::rstest;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::idle_sleep::{KeptSchedule, SessionSleepState};
use sidekicks_provider::driver::session_control::{
    LiveRunResume, OpenTurnResume, ProviderTurnAnswer, ResumedRunAnswer,
};
use sidekicks_provider::driver::test_registry::new_run_id;
use sidekicks_session::idle_sleep::openings::SessionProcessWaker;
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use tokio::time::timeout;

use super::{Opening, WAIT};
use crate::provider_session::resumed_runs::ResumedRuns;

/// The recurring job the wake's test stores for the session.
const CRON: &str = "0 9 * * 1";

/// The provider's own id of the lead's open turn.
const PROVIDER_TURN_ID: &str = "provider-turn-7";

/// The provider's own id of the lead's helper.
const SUBAGENT_ID: &str = "helper-3";

// Writes an event of `event_type` on `run_id` at `sequence` of the session's log, its turn number
// in its column where it has one, as the append would, and answers its id.
fn insert_run_event(
    database: &TestDatabase,
    session_id: SessionId,
    sequence: i64,
    (event_type, run_id, turn_number): (SessionEventType, RunId, Option<i64>),
    payload: &Value,
) -> String {
    let event_id = mint_uuid_v7().to_string();
    database
        .reader()
        .execute(
            "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
               category, type, payload, run_id, run_version, turn_number)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, 1, ?9)",
            params![
                event_id,
                session_id.text().as_str(),
                sequence,
                WireInstant::now().as_str(),
                event_type.category().as_str(),
                event_type.as_str(),
                payload.to_string(),
                run_id.text().as_str(),
                turn_number,
            ],
        )
        .expect("the test writes the run's event");
    event_id
}

// A resume after a restart names every live run of the session to the provider: the lead whose
// turn is open under the provider's turn id and the event id its start recorded, and its live
// helper under the helper id its start recorded, beneath the lead. Killed by a child left out, a
// turn id or a start's id dropped, an open turn left out, a helper's id not read and a helper's
// parent dropped.
#[tokio::test]
async fn a_resume_names_each_live_run_with_its_open_turns_and_helper_id() {
    let named = Arc::new(Mutex::new(Vec::new()));
    let opening = Opening::new(
        Box::new({
            let named = Arc::clone(&named);
            move |params| lock(&named).push(params.live_runs.clone())
        }),
        Box::new(|| {}),
        |_, _| {},
    )
    .await;
    let lead = opening.earlier_run_id;
    let child = new_run_id();
    opening
        .database
        .reader()
        .execute(
            "INSERT INTO runs (run_id, session_id, parent_run_id, reached_by, state, run_version)
             VALUES (?1, ?2, ?3, 'providerSubagent', 'running', 1)",
            params![
                child.text().as_str(),
                opening.session_id.text().as_str(),
                lead.text().as_str(),
            ],
        )
        .expect("the test writes the lead's helper");
    let started_event_id = insert_run_event(
        &opening.database,
        opening.session_id,
        100,
        (SessionEventType::AgentTurnStarted, lead, Some(1)),
        &json!({ "turnNumber": 1, "providerTurnId": PROVIDER_TURN_ID }),
    );
    insert_run_event(
        &opening.database,
        opening.session_id,
        101,
        (SessionEventType::AgentSubagentStarted, lead, None),
        &json!({
            "sessionId": opening.session_id.text().as_str(),
            "runId": lead.text().as_str(),
            "provider": PROVIDERS[0].id,
            "subagentId": SUBAGENT_ID,
            "childRunId": child.text().as_str(),
        }),
    );

    timeout(
        WAIT,
        opening.sessions.open(opening.session_id, opening.run_id),
    )
    .await
    .expect("the open takes its own lock once")
    .expect("the conversation resumes");

    let named = lock(&named).clone();
    let [live_runs] = named.as_slice() else {
        panic!("one resume names the live runs, not {named:?}");
    };
    let named_run = |run_id: RunId| {
        live_runs
            .iter()
            .find(|named| named.run_id == run_id)
            .cloned()
            .unwrap_or_else(|| panic!("the resume names run {run_id} among {live_runs:?}"))
    };
    assert_eq!(
        named_run(lead),
        LiveRunResume {
            run_id: lead,
            parent_run_id: None,
            open_turns: vec![OpenTurnResume {
                turn_number: SafeInt::new(1).expect("one is a turn number"),
                provider_turn_id: Some(
                    ProviderTurnId::new(PROVIDER_TURN_ID.to_owned()).expect("a turn id"),
                ),
                started_event_id: FreeFormText::new(started_event_id).expect("an event id"),
            }],
            subagent_id: None,
        }
    );
    assert_eq!(
        named_run(child),
        LiveRunResume {
            run_id: child,
            parent_run_id: Some(lead),
            open_turns: Vec::new(),
            subagent_id: Some(SubagentId::new(SUBAGENT_ID.to_owned()).expect("a helper id")),
        }
    );
}

// The provider's answer for each run a resume named reaches the resumed runs' ingress before the
// resumed binding is recorded, whether the driver answers on the binding the queue minted or a
// process already up answers on its own. Killed by the ingress called after the binding's record
// (the minted binding has its row as the ingress reads), and by the already-up branch skipping the
// ingress (its runs never arrive).
#[rstest]
#[case::minted(false)]
#[case::already_up(true)]
#[tokio::test]
async fn a_resumes_runs_reach_the_ingress_before_its_binding_is_recorded(
    #[case] is_already_up: bool,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;
    if is_already_up {
        *lock(&opening.came_up_on) = Some(opening.predecessor_id.clone());
    }

    timeout(
        WAIT,
        opening.sessions.open(opening.session_id, opening.run_id),
    )
    .await
    .expect("the open takes its own lock once")
    .expect("the conversation resumes");

    let gone = |run_id| ResumedRunAnswer {
        run_id,
        turn: ProviderTurnAnswer::Gone,
    };
    assert_eq!(
        opening.resumed_runs.taken(),
        [ResumedRuns {
            session_id: opening.session_id,
            runs: vec![gone(opening.earlier_run_id), gone(opening.run_id)],
        }],
        "the ingress takes every run the resume named, once"
    );
    assert_eq!(
        *lock(&opening.handed_rows_at_take),
        [false],
        "the binding the resume minted has no row as the ingress takes its runs"
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
