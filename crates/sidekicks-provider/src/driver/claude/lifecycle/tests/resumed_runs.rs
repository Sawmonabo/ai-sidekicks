//! What a resume answers of each run it names, and the turn of the run in progress a fresh process
//! continues on that run.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{resume_params, start_params};
use crate::driver::claude::run::routes::ClaudeChildRunRoute;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::{binding_id, hand_scripted_frame, settle};
use crate::driver::session_control::{
    CloseSessionParams, DriverResumeResult, LiveRunResume, OpenTurnResume, ProviderTurnAnswer,
    ResumeSessionParams, ResumedRunAnswer,
};
use crate::driver::test_registry::new_run_id;
use crate::port::run_host::test_host::EngineCall;

// A run started on its own with `open_turns`, as a resume names it.
fn lead_run(run_id: RunId, open_turns: Vec<OpenTurnResume>) -> LiveRunResume {
    LiveRunResume {
        run_id,
        parent_run_id: None,
        open_turns,
        subagent_id: None,
    }
}

// A helper's run started beneath `parent_run_id`, its turn 1 open.
fn helper_run(run_id: RunId, parent_run_id: RunId) -> LiveRunResume {
    LiveRunResume {
        run_id,
        parent_run_id: Some(parent_run_id),
        open_turns: vec![open_turn(1)],
        subagent_id: Some(SubagentId::new("helper-1".to_owned()).expect("a helper id fits")),
    }
}

// Turn `turn_number`, started and not ended.
fn open_turn(turn_number: u64) -> OpenTurnResume {
    OpenTurnResume {
        turn_number: SafeInt::<1>::new(turn_number).expect("a turn number"),
        provider_turn_id: Some(
            ProviderTurnId::new(format!("turn-{turn_number}")).expect("a turn id fits"),
        ),
        started_event_id: FreeFormText::new(mint_uuid_v7().to_string()).expect("an event id fits"),
    }
}

fn answer(run_id: RunId, turn: ProviderTurnAnswer) -> ResumedRunAnswer {
    ResumedRunAnswer { run_id, turn }
}

// A scripted driver whose session ran, was closed, and has its next process scripted, so a resume
// of it brings a fresh process up.
async fn closed_session(fixture: &ScriptedDriver) -> SessionId {
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    fixture.next_start().await;
    fixture
        .driver
        .close_session(CloseSessionParams { session_id })
        .await
        .expect("the close succeeds");
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    session_id
}

// A resume the session's live process answers says that process still runs the turn of the run
// holding the session's turn and of the helper's run started beneath it, and holds no turn of any
// other run the resume named. Killed by every run answered `Gone` on that arm (the run whose turn
// still runs would end), and by a helper's run beneath the held turn answered `Gone`.
#[tokio::test(start_paused = true)]
async fn a_resume_the_live_process_answers_holds_only_the_turn_it_runs() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    fixture.next_start().await;
    fixture
        .driver
        .close_session(CloseSessionParams { session_id })
        .await
        .expect("the close succeeds");
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    let params = resume_params(session_id);
    fixture
        .driver
        .restart_session(params.clone())
        .await
        .expect("the restart answers");
    fixture.next_start().await;
    let (held, helper, other) = (new_run_id(), new_run_id(), new_run_id());
    fixture
        .driver
        .start_run(start_params(session_id, held))
        .await
        .expect("the run starts");
    let routes = &fixture
        .driver
        .composed_parts()
        .expect("composed")
        .run_start
        .routes;
    routes.bind_child_run(
        helper,
        ClaudeChildRunRoute {
            session_id,
            agent_id: "helper-1".to_owned(),
            parent_run_id: held,
            binding_id: binding_id("lead"),
        },
    );
    let named = |run_id| LiveRunResume {
        run_id,
        parent_run_id: None,
        open_turns: Vec::new(),
        subagent_id: None,
    };

    let resumed = fixture
        .driver
        .resume_session(ResumeSessionParams {
            live_runs: vec![named(held), named(helper), named(other)],
            ..params
        })
        .await
        .expect("the resume answers");

    let DriverResumeResult::Resumed { runs, .. } = resumed else {
        unreachable!("the live process answers the resume: {resumed:?}")
    };
    let answer = |run_id, turn| ResumedRunAnswer { run_id, turn };
    assert_eq!(
        runs,
        [
            answer(held, ProviderTurnAnswer::StillRunning),
            answer(helper, ProviderTurnAnswer::StillRunning),
            answer(other, ProviderTurnAnswer::Gone),
        ]
    );
    assert!(
        fixture.starts.take_started().is_empty(),
        "no process starts"
    );
}

// A fresh process continues the newest open turn of the lead run in progress, with Claude Code's
// resume flag set on it, and holds no other run's turn, a helper's included; a resume naming no
// run in progress sets no flag and answers every run gone. Killed by the flag dropped, by a
// helper's open turn answered `StillRunning` or taken for the run in progress, and by every run
// answered `Gone` where one is in progress.
#[rstest]
#[case::in_progress(true)]
#[case::none_in_progress(false)]
#[tokio::test(start_paused = true)]
async fn a_fresh_process_continues_only_the_turn_of_the_run_in_progress(
    #[case] is_in_progress: bool,
) {
    let fixture = ScriptedDriver::new();
    let session_id = closed_session(&fixture).await;
    let (lead, helper, other) = (new_run_id(), new_run_id(), new_run_id());
    let lead_turns = if is_in_progress {
        vec![open_turn(1), open_turn(2)]
    } else {
        Vec::new()
    };

    let resumed = fixture
        .driver
        .resume_session(ResumeSessionParams {
            live_runs: vec![
                lead_run(lead, lead_turns),
                helper_run(helper, lead),
                lead_run(other, Vec::new()),
            ],
            ..resume_params(session_id)
        })
        .await
        .expect("the resume answers");
    let started = fixture.next_start().await;

    let DriverResumeResult::Resumed { runs, .. } = resumed else {
        unreachable!("a fresh process answers the resume: {resumed:?}")
    };
    let lead_turn = if is_in_progress {
        ProviderTurnAnswer::StillRunning
    } else {
        ProviderTurnAnswer::Gone
    };
    assert_eq!(
        runs,
        [
            answer(lead, lead_turn),
            answer(helper, ProviderTurnAnswer::Gone),
            answer(other, ProviderTurnAnswer::Gone),
        ]
    );
    let has_flag = started
        .environment
        .iter()
        .any(|(name, value)| name == "CLAUDE_CODE_RESUME_INTERRUPTED_TURN" && value == "1");
    assert_eq!(has_flag, is_in_progress);
}

// The turn a fresh process continues runs on its run as the open turn it was: its `system/init`
// opens no run, its tool call counts a step of that run, and its `result` ends that run's turn 2
// on the resumed binding, with no turn started. Killed by the hold skipped (the init opens a run of
// its own) and by the stream left unseeded (a turn 3 start is asked of the engine).
#[tokio::test(start_paused = true)]
async fn a_continued_turn_runs_on_its_run_and_ends_as_that_turn() {
    let fixture = ScriptedDriver::new();
    let session_id = closed_session(&fixture).await;
    let lead = new_run_id();
    let params = resume_params(session_id);
    let resumed_binding = params.binding_id.clone();
    let conversation = params.resume_handle.clone();
    fixture
        .driver
        .resume_session(ResumeSessionParams {
            live_runs: vec![lead_run(lead, vec![open_turn(2)])],
            ..params
        })
        .await
        .expect("the resume answers");
    let started = fixture.next_start().await;
    let calls_before = fixture.engine.calls().len();
    let routes = &fixture
        .driver
        .composed_parts()
        .expect("composed")
        .run_start
        .routes;

    for frame in [
        json!({"type": "system", "subtype": "init", "session_id": conversation}),
        json!({
            "type": "assistant",
            "session_id": conversation,
            "message": {
                "id": "message-1",
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "call-1",
                        "name": "Bash",
                        "input": {"command": "ls"},
                    },
                ],
            },
        }),
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done",
            "session_id": conversation,
        }),
    ] {
        hand_scripted_frame(&*started.listener, routes, session_id, &frame);
    }
    settle().await;

    let calls = fixture.engine.calls().split_off(calls_before);
    assert!(
        !calls.iter().any(|call| matches!(
            call,
            EngineCall::StartDaemonTurn(_) | EngineCall::StartTurn(_)
        )),
        "no run and no turn starts: {calls:?}"
    );
    assert!(calls.contains(&EngineCall::CountStep(lead)));
    let ends: Vec<_> = calls
        .into_iter()
        .filter_map(|call| {
            let EngineCall::Deliver(delivery) = call else {
                return None;
            };
            let change = delivery.change?;
            Some((
                change.run_id,
                delivery.binding_id,
                delivery.ended_turn_number,
            ))
        })
        .collect();
    assert_eq!(
        ends,
        [(
            lead,
            Some(resumed_binding),
            Some(SafeInt::<1>::new(2).expect("a turn number")),
        )]
    );
}
