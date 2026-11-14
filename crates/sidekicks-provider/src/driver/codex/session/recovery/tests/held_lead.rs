//! The person's restart of a session whose conversation resumes in place carries the answers its
//! held lead is owed.

use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::driver::codex::session::establishment::continuation::{
    CODEX_CONTINUATION_TEXT, CodexHeldLeadContinue,
};
use crate::driver::codex::session::recovery::in_place_resume::{
    CodexInPlaceResumeCall, resume_codex_session_in_place,
};
use crate::driver::codex::session::recovery::never_left;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, fork_reply, no_turns, turn_reply,
};
use crate::driver::session_control::held_run_continue::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use crate::driver::session_control::{DriverResumeResult, LiveRunResume, ProviderTurnAnswer};
use crate::driver::test_registry::new_run_id;
use crate::runtime_binding::resume::ResumeFunctionLegs;
use crate::runtime_binding::store::mint_runtime_binding_id;

// The line the person's approval of `npm publish` reads as in the continuation.
const ANSWER_LINE: &str = "You asked to approve Bash: npm publish. The person approved it.";

// A running lead the service's end left with no turn, whose answer the person gave, is continued
// by the restart's resume in place in one turn holding Codex's continuation words, then the
// answer, and answers still running, so the queue keeps the answer taken. Killed by the resume in
// place not reading the answers (no turn is sent and the lead is not answered still running, so
// the queue gives the answer back and the lead never reads it).
#[tokio::test(start_paused = true)]
async fn a_persons_restart_carries_the_held_leads_answers_in_place() {
    let mut session = TestCodexSession::start().await;
    // A resume keeps the version the service reported on its binding.
    session.scripted.report_version("codex-cli 0.163.0");
    let run_id = new_run_id();
    let card = ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id");
    let held_lead_continue = CodexHeldLeadContinue {
        held_run_continue: HeldRunContinue {
            lead_run_id: run_id,
            entries: vec![ContinueEntry {
                run_id,
                subagent_id: None,
                answer: ContinueAnswer::Approval {
                    approval_request_id: card,
                    subject: "npm publish".to_owned(),
                    tool_name: Some("Bash".to_owned()),
                    decision: ApprovalDecision::Approved,
                    decline_reason: None,
                    edited_action: None,
                },
            }],
            missed_fires: Vec::new(),
        },
        live_runs: vec![LiveRunResume {
            run_id,
            parent_run_id: None,
            open_turns: Vec::new(),
            subagent_id: None,
            model_id: None,
            is_stopping: false,
            run_state: RunState::Running,
        }],
        agent_id: session.daemon_turn_bindings.agent_id,
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let resume = CodexInPlaceResumeCall {
        establishment: Arc::new(session.establishment(folder.path())),
        service: Arc::clone(&session.scripted.service),
        binding_id: mint_runtime_binding_id(),
        function_legs: ResumeFunctionLegs::default(),
        writer_left: never_left(),
        held_lead_continue: Some(held_lead_continue),
        answer_steers: session.answer_steers(),
        released: None,
    };
    let settings = session.task.record.thread_settings.clone();
    let mut turn_starts: Vec<Value> = Vec::new();
    let script = &mut session.scripted.script;
    let service_side = async {
        loop {
            let sent = script.next_sent().await;
            let answer = match sent["method"].as_str() {
                Some("config/read") => json!({"config": {}, "origins": {}}),
                Some("thread/resume") => {
                    let mut reply = fork_reply(TEST_THREAD, &settings);
                    reply["thread"]["status"] = json!({"type": "idle"});
                    reply
                }
                Some("thread/turns/list") => no_turns(),
                Some("thread/settings/update") => json!({}),
                Some("turn/start") => {
                    turn_starts.push(sent.clone());
                    turn_reply("turn-answers")
                }
                Some("account/read") => json!({"account": null}),
                Some("account/rateLimits/read") => json!({"rateLimits": null}),
                method => panic!("the service was not asked {method:?}"),
            };
            script.answer(&sent, &answer);
        }
    };
    let (mut task, dependencies) = session.task.split();
    let (outcome, _routed) = tokio::select! {
        resumed = resume_codex_session_in_place(&mut task, dependencies, resume) => resumed,
        () = service_side => unreachable!("the service answers until the resume ends"),
    };

    let [turn_start] = turn_starts.as_slice() else {
        panic!("one turn is sent: {turn_starts:?}");
    };
    let text = turn_start["params"]["input"][0]["text"]
        .as_str()
        .expect("the turn holds words");
    assert!(text.starts_with(CODEX_CONTINUATION_TEXT), "{text}");
    assert!(text.ends_with(ANSWER_LINE), "{text}");
    let DriverResumeResult::Resumed { runs, .. } = &outcome.result else {
        panic!("the conversation resumes: {:?}", outcome.result);
    };
    let lead = runs.iter().find(|answer| answer.run_id == run_id);
    assert_eq!(
        lead.map(|answer| answer.turn),
        Some(ProviderTurnAnswer::StillRunning)
    );
}
