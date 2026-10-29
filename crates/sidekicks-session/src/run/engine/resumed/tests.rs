use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::AgentRunStepLimitReachedPayload;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::session_control::ProviderTurnAnswer;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::pause_point::ArmedPause;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_workspace::run_setup_gates::{
    RunSetupContext, RunSetupGate, RunSetupGateError, RunTerminalContext,
};

use crate::plan_holds::NoPlanHolds;
use crate::questions::schema::schema_parts;
use crate::run::engine::test_fixture::{append, stored_run_state, test_engine_with};
use crate::run::engine::tests::{
    SETTLE_WAIT, STEP_BOUND, events, hand_limit_interrupter, stored_events, turn, turn_started_at,
};
use crate::run::read::{LiveRun, RunRead};

// The step bound the session sets where a case counts its turn's steps.
const SESSION_STEP_BOUND: i64 = 3;

// A stand-in gate whose terminal hook records each run's end, as the approval gate's hook cancels
// the cards that run left pending.
#[derive(Default)]
struct TerminalRecorder {
    ends: Mutex<Vec<(RunId, RunState)>>,
}

impl RunSetupGate for TerminalRecorder {
    fn assert_run_ready<'a>(
        &'a self,
        _context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn on_run_terminal<'a>(
        &'a self,
        context: &'a RunTerminalContext,
        _hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        lock(&self.ends).push((context.run_id, context.terminal_state));
        Box::pin(std::future::ready(Ok(())))
    }
}

// What a case's log holds beyond its open turn, and what it checks once the run is finalized.
#[derive(Clone, Copy, Debug)]
enum Logged {
    // Nothing more.
    Turn,
    // Two steps of the open turn under the session's bound of three: the next step reaches it.
    StepsTaken,
    // The open turn reached its step limit and its interrupt was never handed.
    OwedStepLimit,
    // The daemon's step limit interrupt row names the open turn as cut.
    StepLimitRow,
}

// Killed by a fixed move to `running` (`waiting_on_an_approval_still_running`,
// `pausing_still_running`); by a paused run un-paused or a lead's pause dropped on a gone turn
// (`paused_gone`, `pausing_*`); by a gone turn left open, or a run settled as failed or by any
// trigger but `daemonRestart` (`running_gone`, `waiting_on_an_approval_gone`); by a run's end that
// skips its terminal hooks, which leaves the approval card pending (`waiting_on_an_approval_gone`);
// by a child held to the lead's pause rule (`child_paused_gone`); by a queued run moved
// (`queued_gone`); by a step count started from zero (`steps_rebuilt`), an owed step limit not
// handed again (`owed_step_limit_handed_again`) and a limit cut not loaded (`limit_cut_loaded`).
#[rstest]
#[case::running_still_running(RunState::Running, false, ProviderTurnAnswer::StillRunning, Logged::Turn, "running", &[], None)]
#[case::running_ended_by_provider(RunState::Running, false, ProviderTurnAnswer::EndedByProvider, Logged::Turn, "running", &[], None)]
#[case::running_gone(
    RunState::Running,
    false,
    ProviderTurnAnswer::Gone,
    Logged::Turn,
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ],
    Some("daemonRestart")
)]
#[case::waiting_on_an_approval_still_running(RunState::WaitingForApproval, false, ProviderTurnAnswer::StillRunning, Logged::Turn, "waitingForApproval", &[], None)]
#[case::waiting_on_an_approval_gone(
    RunState::WaitingForApproval,
    false,
    ProviderTurnAnswer::Gone,
    Logged::Turn,
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ],
    Some("daemonRestart")
)]
#[case::paused_gone(RunState::Paused, false, ProviderTurnAnswer::Gone, Logged::Turn, "paused", &[], None)]
#[case::pausing_still_running(RunState::Pausing, false, ProviderTurnAnswer::StillRunning, Logged::Turn, "pausing", &[], None)]
#[case::pausing_ended_by_provider(
    RunState::Pausing,
    false,
    ProviderTurnAnswer::EndedByProvider,
    Logged::Turn,
    "paused",
    &[("agent.run.paused", None, None)],
    None
)]
#[case::pausing_gone(
    RunState::Pausing,
    false,
    ProviderTurnAnswer::Gone,
    Logged::Turn,
    "paused",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.paused", None, None),
    ],
    None
)]
#[case::child_paused_gone(
    RunState::Paused,
    true,
    ProviderTurnAnswer::Gone,
    Logged::Turn,
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ],
    Some("daemonRestart")
)]
#[case::queued_gone(RunState::Queued, false, ProviderTurnAnswer::Gone, Logged::Turn, "queued", &[], None)]
#[case::steps_rebuilt(RunState::Running, false, ProviderTurnAnswer::StillRunning, Logged::StepsTaken, "running", &[], None)]
#[case::owed_step_limit_handed_again(RunState::Running, false, ProviderTurnAnswer::StillRunning, Logged::OwedStepLimit, "running", &[], None)]
#[case::limit_cut_loaded(RunState::Running, false, ProviderTurnAnswer::StillRunning, Logged::StepLimitRow, "running", &[], None)]
#[tokio::test]
async fn a_resumed_run_moves_as_its_state_before_and_its_providers_answer_decide(
    #[case] state_before: RunState,
    #[case] is_child: bool,
    #[case] answer: ProviderTurnAnswer,
    #[case] logged: Logged,
    #[case] state_after: &str,
    #[case] written: &[(&str, Option<&str>, Option<&str>)],
    #[case] trigger: Option<&str>,
) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let reader = database.reader();
    reader
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?1, ?2, ?3, 1)",
            params![
                run_id.text().as_str(),
                session_id.text().as_str(),
                <&'static str>::from(state_before),
            ],
        )
        .expect("the test writes the run");
    let terminals = Arc::new(TerminalRecorder::default());
    let engine = test_engine_with(
        &database,
        log.service,
        home.path(),
        Arc::new(NoPlanHolds),
        vec![Arc::clone(&terminals) as Arc<dyn RunSetupGate>],
    );
    let interventions = hand_limit_interrupter(&engine, 0);
    if state_before != RunState::Queued {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;
    }
    match logged {
        Logged::Turn => {}
        Logged::StepsTaken => {
            reader
                .execute(
                    &format!(
                        "INSERT INTO session_console_state (session_id, max_steps_per_turn,
                           updated_at)
                         VALUES (?1, ?2, {DATABASE_NOW_SQL})"
                    ),
                    params![session_id.text().as_str(), SESSION_STEP_BOUND],
                )
                .expect("the test sets the session's step bound");
            for call in ["call-1", "call-2"] {
                let step: SessionEvent = serde_json::from_value(json!({
                    "type": "agent.toolCall.completed",
                    "payload": {
                        "sessionId": session_id,
                        "runId": run_id,
                        "toolName": "edit",
                        "toolCallId": call,
                    },
                }))
                .expect("the test's tool completion reads as an event");
                append(&engine, session_id, &step).await;
            }
        }
        Logged::OwedStepLimit => {
            append(
                &engine,
                session_id,
                &SessionEvent::AgentRunStepLimitReached(AgentRunStepLimitReachedPayload {
                    session_id,
                    run_id,
                    count: STEP_BOUND,
                }),
            )
            .await;
        }
        Logged::StepLimitRow => {
            reader
                .execute(
                    &format!(
                        "INSERT INTO interventions (id, target_run_id, type, state, payload,
                           expected_run_version, client_idempotency_key, created_at)
                         VALUES (?1, ?2, 'interrupt', 'accepted', ?3, 1, ?1, {DATABASE_NOW_SQL})"
                    ),
                    params![
                        mint_uuid_v7().to_string(),
                        run_id.text().as_str(),
                        r#"{"limit":"stepLimit","turnNumber":1}"#,
                    ],
                )
                .expect("the test records the step limit's interrupt");
        }
    }
    let seeded = stored_events(&database, &run_id).len();
    let run = LiveRun {
        run_id,
        run: RunRead {
            version: 1,
            session_id,
            state: state_before,
        },
        parent_run_id: is_child
            .then(|| RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")),
        reached_by: None,
    };
    // Armed before the finalize, which hands an owed limit on a task of its own.
    let ArmedPause {
        reached: handed,
        release: hand_answer,
    } = interventions.held_hands.arm();

    engine
        .rearm_after_restart(&run)
        .await
        .expect("the run is re-armed from its log");
    engine
        .finalize_resumed_run(&run, state_before, answer, None)
        .await
        .expect("the resumed run is finalized");

    assert_eq!(stored_events(&database, &run_id)[seeded..], events(written));
    assert_eq!(stored_run_state(&database, &run_id).0, state_after);
    let end_trigger: Option<String> = reader
        .query_row(
            "SELECT json_extract(payload, '$.trigger') FROM session_events
              WHERE run_id = ?1 AND type = 'agent.run.interrupted'",
            [run_id.text().as_str()],
            |row| row.get(0),
        )
        .optional()
        .expect("the test reads the run's end")
        .flatten();
    assert_eq!(end_trigger.as_deref(), trigger);
    let terminal = (state_after == "interrupted").then_some((run_id, RunState::Interrupted));
    assert_eq!(
        lock(&terminals.ends).as_slice(),
        terminal.as_slice(),
        "the run's end runs its terminal hooks once"
    );
    match logged {
        Logged::Turn => {}
        Logged::StepsTaken => {
            // The third step reaches the bound only on a count that kept the two before it.
            let (stepped, ()) = tokio::time::timeout(SETTLE_WAIT, async {
                tokio::join!(engine.count_step(run_id), async {
                    handed.await.expect("the step reaches the turn's bound");
                    hand_answer
                        .send(false)
                        .expect("the stop waits for its answer");
                })
            })
            .await
            .expect("the third step reaches the bound");
            stepped.expect("the step's stop hands its interrupt");
            assert_eq!(*lock(&interventions.cut_turns), [Some(turn(1))]);
        }
        Logged::OwedStepLimit => {
            tokio::time::timeout(SETTLE_WAIT, handed)
                .await
                .expect("the owed step limit is handed again")
                .expect("the hand reaches the stand-in");
            hand_answer
                .send(false)
                .expect("the hand waits for its answer");
            assert_eq!(*lock(&interventions.cut_turns), [Some(turn(1))]);
        }
        Logged::StepLimitRow => {
            assert_eq!(
                engine.held_cut_limit(run_id, turn(1)),
                Some(RunLimit::StepLimit)
            );
        }
    }
}
