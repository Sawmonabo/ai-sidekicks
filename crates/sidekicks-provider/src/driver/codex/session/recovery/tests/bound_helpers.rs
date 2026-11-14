//! A session's helpers across its service's recovery: each one still bound reopened on the new
//! connection after a reconnect, and each one's child run ended with the service's process.

use std::sync::Arc;
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;

use super::{Steps, exit_code, test_recovery};
use crate::driver::codex::delivery::rows::test_row_run;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::session::recovery::in_place_resume::{
    CodexInPlaceResumeCall, resume_codex_session_in_place,
};
use crate::driver::codex::session::recovery::never_left;
use crate::driver::codex::session::test_fixture::relaunches::RefusedRelaunchStep;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, fork_reply, no_turns,
};
use crate::driver::session_control::DriverResumeResult;
use crate::port::run_host::test_host::EngineCall;
use crate::run::state_entry::RunStateEntry;
use crate::runtime_binding::resume::ResumeFunctionLegs;
use crate::runtime_binding::store::mint_runtime_binding_id;

/// The newest turn of each helper.
const HELPER_TURN: &str = "turn-helper";

// Starts the helper on its conversation `thread_id` beneath a run of the lead's, by that run's
// spawn call and Codex's completed spawn item, answering the helper's `thread/read`, and answers
// its child run.
pub(super) async fn start_helper(session: &mut TestCodexSession, thread_id: &str) -> RunId {
    let mut lead = test_row_run();
    lead.session_id = session.task.record.session_id;
    let spawn_call = format!("spawn-{thread_id}");
    session
        .task
        .record
        .note_spawn_call(TEST_THREAD, &spawn_call, &lead);
    let spawned = json!({"threadId": TEST_THREAD, "item": {
        "type": "subAgentActivity", "id": spawn_call, "kind": "started",
        "agentThreadId": thread_id, "agentPath": format!("/root/{thread_id}"),
    }});
    let script = &mut session.scripted.script;
    let answer_read = async {
        let read = script
            .next_sent_within(Duration::from_secs(1))
            .await
            .expect("the spawned helper's conversation is read");
        assert_eq!(read["method"], "thread/read", "{read}");
        script.answer(&read, &json!({"thread": {"id": thread_id}}));
    };
    let handled = session.task.handle(CodexSessionInbound::Frame {
        method: "item/completed".to_owned(),
        params: RawValue::from_string(spawned.to_string()).expect("the params are JSON"),
    });
    tokio::join!(handled, answer_read);
    session.task.record.delivery.child_run_by_thread_id[thread_id]
        .bound
        .as_ref()
        .expect("the helper's child run started")
        .child_run_id
}

// After a reconnect the resume in place reopens each helper whose child run is still bound, and
// the one whose newest turn ended while the daemon was away has its child run ended completed,
// while the running one goes on. Kills: no reopen (no helper's resume comes), and the owed end not
// routed (the ended helper's run never moves).
#[tokio::test(start_paused = true)]
async fn a_reconnect_reopens_bound_helpers_and_ends_the_finished_one() {
    let mut session = TestCodexSession::start().await;
    // A resume keeps the version the service reported on its binding.
    session.scripted.report_version("codex-cli 0.163.0");
    let running_run = start_helper(&mut session, "thread-helper-running").await;
    let finished_run = start_helper(&mut session, "thread-helper-finished").await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let resume = CodexInPlaceResumeCall {
        establishment: Arc::new(session.establishment(folder.path())),
        service: Arc::clone(&session.scripted.service),
        binding_id: mint_runtime_binding_id(),
        function_legs: ResumeFunctionLegs::default(),
        writer_left: never_left(),
        held_lead_continue: None,
        answer_steers: session.answer_steers(),
        released: None,
    };
    let settings = session.task.record.thread_settings.clone();
    let mut helper_resumes: Vec<Value> = Vec::new();
    let script = &mut session.scripted.script;
    let service_side = async {
        loop {
            let sent = script.next_sent().await;
            let thread_id = sent["params"]["threadId"].clone();
            let answer = match sent["method"].as_str() {
                Some("config/read") => json!({"config": {}, "origins": {}}),
                Some("thread/resume") if thread_id == TEST_THREAD => {
                    fork_reply(TEST_THREAD, &settings)
                }
                Some("thread/resume") => {
                    helper_resumes.push(thread_id.clone());
                    let mut turn = json!({"id": HELPER_TURN, "items": [], "status": "inProgress"});
                    if thread_id == "thread-helper-finished" {
                        turn["status"] = json!("completed");
                        turn["completedAt"] = json!(1_767_000_000);
                    }
                    json!({
                        "thread": {"id": thread_id, "sessionId": "codex-session"},
                        "initialTurnsPage": {"data": [turn], "nextCursor": null},
                    })
                }
                Some("thread/turns/list") => no_turns(),
                Some("thread/settings/update") => json!({}),
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

    assert!(matches!(outcome.result, DriverResumeResult::Resumed { .. }));
    helper_resumes.sort_by_key(ToString::to_string);
    assert_eq!(
        helper_resumes,
        [
            json!("thread-helper-finished"),
            json!("thread-helper-running")
        ]
    );
    assert_eq!(
        session.engine.moves_of_run(finished_run),
        vec![RunStateEntry::Completed {
            intended_close: None
        }]
    );
    assert_eq!(session.engine.moves_of_run(running_run), Vec::new());
}

// A service's exit ends a helper's child run though its lead holds no turn, so the engine never
// reaches it beneath a lead's run. Kills: the helpers' child runs not drained at the exit.
#[tokio::test(start_paused = true)]
async fn a_service_exit_ends_a_helper_whose_lead_holds_no_turn() {
    let mut session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let steps = Arc::new(Steps::new(&session));
    let recovery = test_recovery(
        &session,
        folder.path(),
        &steps,
        RefusedRelaunchStep::Nothing,
    );
    let helper_run = start_helper(&mut session, "thread-helper").await;
    let service = Arc::clone(&session.scripted.service);

    session
        .task
        .drive(recovery.end_turns_on_exit(&service, Some(exit_code(1))))
        .await;

    assert_eq!(
        session.engine.turn_ends(),
        vec![EngineCall::EndTurnOnProcessExit(helper_run)]
    );
    assert!(
        session
            .task
            .record
            .delivery
            .child_run_by_thread_id
            .is_empty()
    );
}
