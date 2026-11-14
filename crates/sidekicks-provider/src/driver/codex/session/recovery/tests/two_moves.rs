//! A helper a terminal holds through two service moves in a row is reopened once, on the service
//! the session runs on after the second.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::task::TaskTracker;

use super::bound_helpers::start_helper;
use crate::driver::codex::service::supervisor::CODEX_UNLOAD_TIMEOUT;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
use crate::driver::codex::session::recovery::in_place_resume::{
    CodexInPlaceResumeCall, CodexReleasedConversations, resume_codex_session_in_place,
};
use crate::driver::codex::session::recovery::never_left;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, fork_reply, no_turns,
};
use crate::driver::codex::thread::settings::CodexThreadSettings;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::session_control::DriverResumeResult;
use crate::runtime_binding::resume::ResumeFunctionLegs;
use crate::runtime_binding::store::mint_runtime_binding_id;

/// The helper's conversation.
const HELPER_THREAD: &str = "thread-helper";

// Answers a service's requests as a resume in place and a helper's reopen send them, keeping the
// conversation of each helper reopened, until the caller stops polling.
async fn serve_resumes(
    script: &mut ScriptedService,
    settings: &CodexThreadSettings,
    helper_resumes: &mut Vec<Value>,
) {
    loop {
        let sent = script.next_sent().await;
        let thread_id = sent["params"]["threadId"].clone();
        let answer = match sent["method"].as_str() {
            Some("config/read") => json!({"config": {}, "origins": {}}),
            Some("thread/resume") if thread_id == TEST_THREAD => fork_reply(TEST_THREAD, settings),
            Some("thread/resume") => {
                helper_resumes.push(thread_id.clone());
                json!({
                    "thread": {"id": thread_id, "sessionId": "codex-session"},
                    "initialTurnsPage": {
                        "data": [{"id": "turn-helper", "items": [], "status": "inProgress"}],
                        "nextCursor": null,
                    },
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
}

// Move one, from A to B, waits for the helper a terminal holds on A; move two, from B to C, takes
// that wait over before it lets B's conversations go; the terminal then lets the helper go before
// move two resumes. The helper ends reopened on C alone: never on B, though the session's record
// still names B when the terminal lets go, and never left unopened. Kills: no take-over (move one's
// wait reads A again at the close), a stale reopen not passed over (B is asked to resume the
// helper), and the taken wait dropped (C never reopens it).
#[tokio::test(start_paused = true)]
async fn a_helper_held_through_two_moves_reopens_on_the_last_service_alone() {
    let mut session = TestCodexSession::start().await;
    // A resume keeps the version the service reported on its binding.
    session.scripted.report_version("codex-cli 0.163.0");
    let mut left = start_scripted_codex_service();
    let mut last = start_scripted_codex_service();
    last.report_version("codex-cli 0.163.0");
    start_helper(&mut session, HELPER_THREAD).await;
    let session_id = session.task.record.session_id;
    let settings = session.task.record.thread_settings.clone();
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = Arc::new(session.establishment(folder.path()));
    let tasks = TaskTracker::new();
    let answer_steers = session.answer_steers();
    let resume_on = |service, loaded_on| CodexInPlaceResumeCall {
        establishment: Arc::clone(&establishment),
        service,
        binding_id: mint_runtime_binding_id(),
        function_legs: ResumeFunctionLegs::default(),
        writer_left: never_left(),
        held_lead_continue: None,
        answer_steers: Arc::clone(&answer_steers),
        released: Some(CodexReleasedConversations {
            loaded_on,
            deadline: Instant::now() + CODEX_UNLOAD_TIMEOUT,
            tasks: tasks.clone(),
        }),
    };

    // Move one resumes on B, its wait for the helper held on A.
    let first = resume_on(
        Arc::clone(&session.scripted.service),
        HashMap::from([(HELPER_THREAD.to_owned(), Arc::clone(&left.service))]),
    );
    let mut resumed_on_middle = Vec::new();
    let (mut task, dependencies) = session.task.split();
    let (outcome, _routed) = tokio::select! {
        resumed = resume_codex_session_in_place(&mut task, dependencies, first) => resumed,
        () = serve_resumes(&mut session.scripted.script, &settings, &mut resumed_on_middle) => {
            unreachable!("the service answers until the resume ends")
        }
    };
    assert!(matches!(outcome.result, DriverResumeResult::Resumed { .. }));
    let held = left.next_request("thread/loaded/list").await;
    left.script
        .answer(&held, &json!({"data": [HELPER_THREAD], "nextCursor": null}));

    // Move two takes the wait over before it lets B's conversations go.
    let (reply, taken) = oneshot::channel();
    session
        .task
        .handle(CodexSessionInbound::Call(
            CodexSessionCall::TakeHelperReopenWaits { reply },
        ))
        .await;
    let taken = taken.await.expect("the session's task answers");
    assert_eq!(taken.keys().collect::<Vec<_>>(), [HELPER_THREAD]);
    assert!(Arc::ptr_eq(&taken[HELPER_THREAD], &left.service));

    // The terminal lets the helper go while the record still names B.
    left.script
        .send(&json!({"jsonrpc": "2.0", "method": "thread/closed",
        "params": {"threadId": HELPER_THREAD}}));
    let read_after_the_take = left.script.next_sent_within(Duration::from_secs(1)).await;
    assert!(
        read_after_the_take.is_none(),
        "move one's wait still read A: {read_after_the_take:?}"
    );
    // Move one's reopen, had it been queued before its wait ended, is passed over on B.
    let middle_id = session.scripted.service.id();
    let stale_reopen = CodexSessionInbound::Call(CodexSessionCall::ReopenHelper {
        thread_id: HELPER_THREAD.to_owned(),
        service_id: middle_id,
    });
    tokio::select! {
        () = session.task.handle(stale_reopen) => {}
        () = serve_resumes(&mut session.scripted.script, &settings, &mut resumed_on_middle) => {
            unreachable!("the service answers until the call ends")
        }
    }

    // Move two resumes on C and reopens the helper there once A reads it unloaded.
    let second = resume_on(Arc::clone(&last.service), taken);
    let mut resumed_on_last = Vec::new();
    let (mut task, dependencies) = session.task.split();
    let (outcome, _routed) = tokio::select! {
        resumed = resume_codex_session_in_place(&mut task, dependencies, second) => resumed,
        () = serve_resumes(&mut last.script, &settings, &mut resumed_on_last) => {
            unreachable!("the service answers until the resume ends")
        }
    };
    assert!(matches!(outcome.result, DriverResumeResult::Resumed { .. }));
    let unloaded = left.next_request("thread/loaded/list").await;
    left.script
        .answer(&unloaded, &json!({"data": [], "nextCursor": null}));
    tokio::select! {
        () = session.task.handle_next() => {}
        () = serve_resumes(&mut last.script, &settings, &mut resumed_on_last) => {
            unreachable!("the service answers until the reopen ends")
        }
    }

    assert_eq!(resumed_on_middle, Vec::<Value>::new());
    assert_eq!(resumed_on_last, [json!(HELPER_THREAD)]);
    assert!(
        last.service
            .threads_of(&session_id)
            .contains(&HELPER_THREAD.to_owned())
    );
}
