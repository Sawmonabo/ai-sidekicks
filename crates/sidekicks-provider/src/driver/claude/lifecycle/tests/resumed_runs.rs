//! What a resume answers of each run it names, the turn of the run in progress a fresh process
//! continues on that run, the resume that starts no process where every run waits, the lead is
//! pausing, or stops, and a held lead's continue on a live process.

use std::sync::Arc;

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::PathRules;

use super::start_params;
use crate::driver::claude::run::routes::ClaudeChildRunRoute;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, resume_params};
use crate::driver::claude::session::scripted::{binding_id, hand_scripted_frame, settle};
use crate::driver::claude::session::slots::ClaudeResumeSlot;
use crate::driver::claude::session::transport::user_message::ClaudeWriteDelivery;
use crate::driver::session_control::held_run_continue::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, OpenTurnResume, ProviderTurnAnswer, ResumeSessionParams,
    ResumedRunAnswer,
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
        model_id: None,
        is_stopping: false,
        run_state: RunState::Running,
    }
}

// A helper's run started beneath `parent_run_id`, its turn 1 open.
fn helper_run(run_id: RunId, parent_run_id: RunId) -> LiveRunResume {
    LiveRunResume {
        run_id,
        parent_run_id: Some(parent_run_id),
        open_turns: vec![open_turn(1)],
        subagent_id: Some(SubagentId::new("helper-1".to_owned()).expect("a helper id fits")),
        model_id: None,
        is_stopping: false,
        run_state: RunState::Running,
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

// A resume the session's live process answers says that process still runs the turn of the run
// holding the session's turn and of the helper's run started beneath it, and holds no turn of any
// other run the resume named. Killed by every run answered `Gone` on that arm (the run whose turn
// still runs would end), and by a helper's run beneath the held turn answered `Gone`.
#[tokio::test(start_paused = true)]
async fn a_resume_the_live_process_answers_holds_only_the_turn_it_runs() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.closed_session_resumed_on(Arc::default()).await;
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
            is_refused: false,
        },
    );
    let named = |run_id| LiveRunResume {
        run_id,
        parent_run_id: None,
        open_turns: Vec::new(),
        subagent_id: None,
        model_id: None,
        is_stopping: false,
        run_state: RunState::Running,
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
    let session_id = fixture.closed_session_resumed_on(Arc::default()).await;
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
    let session_id = fixture.closed_session_resumed_on(Arc::default()).await;
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
            EngineCall::StartDaemonTurn(_) | EngineCall::StartTurn(..)
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

// A session whose runs in progress all wait on the person or stop, or whose one run is a pausing
// lead, starts no process: the resume is deferred with each run's answer, a held run `Waiting` and
// a stopping run or a lone pausing lead `Gone`, and the slot is freed, so a later resume of a lead
// with work spawns. Killed by the spawn kept (a start recorded), by a held lead continued
// (`StillRunning`), by a held helper answered `Gone`, by a waiting run its stop waits on read as
// held (`Waiting` in the stopping case), by a pausing lead taken as the run in progress
// (`StillRunning`) or as a lead a process is owed for (a start recorded), and by the claim kept
// (the slot cannot be claimed at once).
#[rstest]
#[case::lead_waits_on_an_ask(RunState::WaitingForApproval, None, false)]
#[case::helper_waits_on_a_question(RunState::Running, Some(RunState::WaitingForInput), false)]
#[case::helper_is_paused(RunState::Running, Some(RunState::Paused), false)]
#[case::waiting_lead_and_helper_stop(
    RunState::WaitingForApproval,
    Some(RunState::WaitingForInput),
    true
)]
#[case::lone_lead_pauses(RunState::Pausing, None, false)]
#[tokio::test(start_paused = true)]
async fn a_session_whose_runs_all_wait_or_stop_starts_no_process(
    #[case] lead_state: RunState,
    #[case] helper_state: Option<RunState>,
    #[case] is_stopping: bool,
) {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.closed_session_resumed_on(Arc::default()).await;
    let lead = new_run_id();
    let mut live_runs = vec![LiveRunResume {
        is_stopping,
        run_state: lead_state,
        ..lead_run(lead, vec![open_turn(1)])
    }];
    let helper = new_run_id();
    if let Some(helper_state) = helper_state {
        live_runs.push(LiveRunResume {
            is_stopping,
            run_state: helper_state,
            ..helper_run(helper, lead)
        });
    }
    let establishment = &fixture
        .driver
        .composed_parts()
        .expect("composed")
        .establishment;

    let deferred = establishment
        .resume(ResumeSessionParams {
            live_runs: live_runs.clone(),
            ..resume_params(session_id)
        })
        .await
        .expect("the resume answers");

    // A lead's own pause is no hold, so its turn is gone with the process, as a stopping run's is.
    let held = if is_stopping || lead_state == RunState::Pausing {
        ProviderTurnAnswer::Gone
    } else {
        ProviderTurnAnswer::Waiting
    };
    let expected: Vec<_> = live_runs
        .iter()
        .map(|run| answer(run.run_id, held))
        .collect();
    assert_eq!(
        deferred.result,
        DriverResumeResult::Deferred { runs: expected }
    );
    assert!(!deferred.has_started_process);
    assert!(
        fixture.starts.take_started().is_empty(),
        "no process starts"
    );

    // Claimed at once: a claim the deferral kept would hold the next resume waiting on the slot.
    let claim = establishment
        .slots
        .claim_resume(session_id)
        .now_or_never()
        .expect("the deferred resume freed the slot")
        .expect("the slot holds no quarantined process");
    assert!(matches!(claim, ClaudeResumeSlot::Claimed(_)));
    drop(claim);
    let resumed = fixture
        .driver
        .resume_session(ResumeSessionParams {
            live_runs: vec![lead_run(new_run_id(), vec![open_turn(1)])],
            ..resume_params(session_id)
        })
        .await
        .expect("the resume answers");
    assert!(matches!(resumed, DriverResumeResult::Resumed { .. }));
    fixture.next_start().await;
}

// A resume carrying a held lead's continue spawns the process that continues the lead with the
// person's answers as its words: a helper's approval names the helper and asks the lead to continue
// it by message to its id. Killed by the continue ignored (Claude Code's own words stand) and by
// the words left off the spawn.
#[tokio::test(start_paused = true)]
async fn a_held_lead_s_continue_carries_the_answers_to_its_process() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.closed_session_resumed_on(Arc::default()).await;
    let (lead, helper) = (new_run_id(), new_run_id());
    let helper_answer = ContinueEntry {
        run_id: helper,
        subagent_id: Some(SubagentId::new("helper-1".to_owned()).expect("a helper id fits")),
        answer: ContinueAnswer::Approval {
            approval_request_id: ApprovalRequestId::try_from(mint_uuid_v7())
                .expect("a minted UUID is an ask's id"),
            subject: "rm -rf build".to_owned(),
            tool_name: Some("Bash".to_owned()),
            decision: ApprovalDecision::Approved,
            decline_reason: None,
            edited_action: None,
        },
    };

    let resumed = fixture
        .driver
        .resume_session(ResumeSessionParams {
            live_runs: vec![lead_run(lead, vec![open_turn(1)]), helper_run(helper, lead)],
            held_run_continue: Some(HeldRunContinue {
                lead_run_id: lead,
                entries: vec![helper_answer],
                missed_fires: Vec::new(),
            }),
            ..resume_params(session_id)
        })
        .await
        .expect("the resume answers");
    let started = fixture.next_start().await;

    assert!(matches!(resumed, DriverResumeResult::Resumed { .. }));
    let value = |name| PathRules::Posix.environment_value(&started.environment, name);
    assert_eq!(value("CLAUDE_CODE_RESUME_INTERRUPTED_TURN"), Some("1"));
    assert_eq!(
        value("CLAUDE_CODE_RESUME_PROMPT"),
        Some(
            "While the app restarted, the person answered what you were waiting on:\n\
             Your helper helper-1 asked to approve Bash: rm -rf build. The person approved it. \
             Continue that helper with SendMessage to its id helper-1, not by starting a new one."
        )
    );
}

// A resume the session's live process answers sends a held lead's continue to that process as the
// lead's next message, never ending it, and answers the lead still running so its answers stay
// taken. The answers land in the turn continued, so the next message that is no steer opens the
// next turn. Killed by the send dropped (no message reaches the process and the lead answers
// gone), and by the answers written as no steer (they open the next turn in its place).
#[tokio::test(start_paused = true)]
async fn a_live_process_is_sent_a_held_lead_s_answers_as_its_next_message() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture
        .closed_session_resumed_on(Arc::clone(&channel))
        .await;
    let params = resume_params(session_id);
    fixture
        .driver
        .restart_session(params.clone())
        .await
        .expect("the restart answers");
    fixture.next_start().await;
    let lead = new_run_id();
    let lead_answer = ContinueEntry {
        run_id: lead,
        subagent_id: None,
        answer: ContinueAnswer::Question {
            question_id: QuestionId::try_from(mint_uuid_v7())
                .expect("a minted UUID is a question's id"),
            question: "Which branch?".to_owned(),
            answer: "main".to_owned(),
        },
    };

    let resumed = fixture
        .driver
        .resume_session(ResumeSessionParams {
            live_runs: vec![lead_run(lead, vec![open_turn(2)])],
            held_run_continue: Some(HeldRunContinue {
                lead_run_id: lead,
                entries: vec![lead_answer],
                missed_fires: Vec::new(),
            }),
            ..params
        })
        .await
        .expect("the resume answers");

    let DriverResumeResult::Resumed { runs, .. } = resumed else {
        unreachable!("the live process answers the resume: {resumed:?}")
    };
    assert_eq!(runs, [answer(lead, ProviderTurnAnswer::StillRunning)]);
    assert!(
        fixture.starts.take_started().is_empty(),
        "no process starts"
    );
    let contents: Vec<_> = channel
        .user_frames()
        .into_iter()
        .map(|frame| frame["message"]["content"].clone())
        .collect();
    assert_eq!(
        contents,
        [json!(
            "While the app restarted, the person answered what you were waiting on:\n\
             You asked: Which branch? The person answered: main."
        )]
    );
    let parts = fixture
        .driver
        .composed_parts()
        .expect("the pieces are composed");
    let mut prompts = parts
        .run_start
        .prompts
        .lock()
        .expect("the prompts' lock holds");
    prompts.record_written(session_id, lead, "later", false);
    assert_eq!(
        prompts.take_turn_opening(session_id).as_deref(),
        Some("later")
    );
}

// A held lead's continue whose message the live process never took leaves the stream reading the
// turn it read before and the lead with no steer waiting, whether the write surely failed or may
// have reached the process. Killed by the continued turn left open on the failed write, and by the
// answers not recorded dropped after a write that may have reached the process (the lead would
// read as owed a turn for them).
#[rstest]
#[case::unsent(ClaudeWriteDelivery::Unsent)]
#[case::indeterminate(ClaudeWriteDelivery::Indeterminate)]
#[tokio::test(start_paused = true)]
async fn a_failed_continue_write_leaves_the_stream_s_turn_as_it_was(
    #[case] delivery: ClaudeWriteDelivery,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture
        .closed_session_resumed_on(Arc::clone(&channel))
        .await;
    let params = resume_params(session_id);
    fixture
        .driver
        .restart_session(params.clone())
        .await
        .expect("the restart answers");
    fixture.next_start().await;
    let stream = fixture
        .driver
        .composed_parts()
        .expect("the pieces are composed")
        .establishment
        .streams
        .get(session_id)
        .expect("the live session has a stream");
    let before = stream.open_turn();
    let lead = new_run_id();
    channel.fail_next_user_write(delivery);

    fixture
        .driver
        .resume_session(ResumeSessionParams {
            live_runs: vec![lead_run(lead, vec![open_turn(2)])],
            held_run_continue: Some(HeldRunContinue {
                lead_run_id: lead,
                entries: vec![ContinueEntry {
                    run_id: lead,
                    subagent_id: None,
                    answer: ContinueAnswer::Question {
                        question_id: QuestionId::try_from(mint_uuid_v7())
                            .expect("a minted UUID is a question's id"),
                        question: "Which branch?".to_owned(),
                        answer: "main".to_owned(),
                    },
                }],
                missed_fires: Vec::new(),
            }),
            ..params
        })
        .await
        .expect_err("the continue's write fails");

    assert_eq!(stream.open_turn(), before);
    let parts = fixture
        .driver
        .composed_parts()
        .expect("the pieces are composed");
    assert!(
        !parts
            .run_start
            .prompts
            .lock()
            .expect("the prompts' lock holds")
            .has_untaken_steer(lead)
    );
}
