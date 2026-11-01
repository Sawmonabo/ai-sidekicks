use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::codex_session_inbound;
use crate::driver::codex::session::test_fixture::status_sink::{
    CountingStatusSink, mcp_server_startup,
};
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, create_session_params, fork_reply, no_turns,
};
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::ProviderAxis;
use crate::driver::mcp_server::status::McpServerStatusProducer;
use crate::driver::session_control::{CreateSessionParams, DriverResumeResult};
use crate::process_identity::ProviderProcessIds as _;
use crate::runtime_binding::resume::ResumeFunctionLegs;
use crate::runtime_binding::store::mint_runtime_binding_id;

// Killed by dropping the profile's read-back, and by dropping the let-go of the conversation a
// refused read-back leaves.
#[tokio::test(start_paused = true)]
async fn a_start_whose_profile_reads_back_wrong_lets_its_conversation_go_and_installs_nothing() {
    let mut session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let params = create_session_params(session_id);

    let created = tokio::spawn(async move { establishment.create(&params).await.map(|_| ()) });
    let script = &mut session.scripted.script;
    let started = script.next_sent().await;
    assert_eq!(started["method"], "thread/start");
    script.answer(
        &started,
        &json!({
            "thread": {"id": "thread-started", "sessionId": "codex-session"},
            "activePermissionProfile": {"id": "another-profile"},
        }),
    );
    let unsubscribed = script.next_sent().await;
    assert_eq!(unsubscribed["method"], "thread/unsubscribe");
    assert_eq!(unsubscribed["params"]["threadId"], "thread-started");
    script.answer(&unsubscribed, &json!({"status": "unsubscribed"}));

    assert!(matches!(
        created.await.expect("the create's task ends"),
        Err(CodexError::Transport { .. })
    ));
    assert_eq!(
        session.scripted.service.threads_of(&session_id),
        Vec::<String>::new()
    );
}

// Killed by a start that takes an effort its model's catalog row does not list, and by one that
// checks the effort only once the conversation started.
#[rstest]
#[case::listed("high", false)]
#[case::not_listed("max", true)]
#[tokio::test(start_paused = true)]
async fn a_start_refuses_an_effort_its_models_row_does_not_list_before_any_conversation(
    #[case] effort: &str,
    #[case] is_refused: bool,
) {
    let mut session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let params = CreateSessionParams {
        effort: Some(ProviderToken::new(effort.to_owned()).expect("the effort fits")),
        ..create_session_params(session_id)
    };
    let agent_id = params.agent_id;

    let created = tokio::spawn(async move { establishment.create(&params).await.map(|_| ()) });
    let script = &mut session.scripted.script;
    let listed = script.next_sent().await;
    assert_eq!(listed["method"], "model/list");
    script.answer(
        &listed,
        &json!({
            "data": [{
                "id": "gpt-5",
                "displayName": "GPT-5",
                "hidden": false,
                "supportedReasoningEfforts": [{"reasoningEffort": "high", "description": "Deep"}],
            }],
            "nextCursor": null,
        }),
    );

    if is_refused {
        let Err(CodexError::Driver(DriverError::ProviderAxisInvalid(invalid))) =
            created.await.expect("the create's task ends")
        else {
            panic!("an effort the model's row does not list is refused for the session's lead");
        };
        assert_eq!(invalid.agent_id, agent_id);
        assert_eq!(invalid.axis, ProviderAxis::Effort);
        assert_eq!(invalid.value, Value::from(effort));
    } else {
        assert_eq!(script.next_sent().await["method"], "thread/start");
        created.abort();
    }
}

// Resumes the test session's conversation in place on a second service whose process is
// `process_id` and which the session is attached to, reporting on `function_legs`, its script
// answering the resume and its history, the mode's update with `mode_answer` (an error where it
// holds one) and the auth read a failure is classified by.
async fn resume_on_second_service(
    session: &mut TestCodexSession,
    process_id: u32,
    mode_answer: Value,
    function_legs: ResumeFunctionLegs,
) -> (ScriptedCodexService, DriverResumeResult) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let mut second = start_scripted_codex_service();
    second.report_version("codex-cli 0.163.0");
    second.report_process(process_id);
    // Attached first, as a move to a new service attaches the session before it resumes there.
    second
        .service
        .attach_session(session.task.record.inbound.clone());
    let settings = session.task.record.thread_settings.clone();
    let script = &mut second.script;
    let service_side = async {
        loop {
            let sent = script.next_sent().await;
            match sent["method"].as_str() {
                Some("thread/resume") => script.answer(&sent, &fork_reply(TEST_THREAD, &settings)),
                Some("thread/turns/list") => script.answer(&sent, &no_turns()),
                Some("thread/settings/update") if mode_answer.get("error").is_some() => {
                    let mut refusal = mode_answer.clone();
                    refusal["jsonrpc"] = json!("2.0");
                    refusal["id"] = sent["id"].clone();
                    script.send(&refusal);
                }
                Some("thread/settings/update") => script.answer(&sent, &mode_answer),
                Some("account/read") => script.answer(&sent, &json!({"account": null})),
                method => panic!("the service was not asked {method:?}"),
            }
        }
    };
    let (mut task, _) = session.task.split();
    let resume = establishment.resume_in_place(
        &mut task,
        Arc::clone(&second.service),
        mint_runtime_binding_id(),
        function_legs,
        || async { false },
    );
    let resumed = tokio::select! {
        resumed = resume => resumed,
        () = service_side => unreachable!("the service answers until the resume ends"),
    };
    (second, resumed.outcome.result)
}

// Killed by dropping the release of the registration the resume made, and by moving the record
// onto the new service before the mode's update answers.
#[tokio::test(start_paused = true)]
async fn a_resume_whose_mode_update_fails_leaves_the_record_and_the_new_service_as_they_were() {
    let mut session = TestCodexSession::start().await;
    let session_id = session.task.record.session_id;

    let (second, result) = resume_on_second_service(
        &mut session,
        4242,
        json!({"error": {"code": -32600, "message": "the mode is refused"}}),
        ResumeFunctionLegs::default(),
    )
    .await;

    assert!(matches!(result, DriverResumeResult::Failed { .. }));
    let record = &session.task.record;
    assert!(Arc::ptr_eq(&record.service, &session.scripted.service));
    assert_eq!(record.binding_id, None);
    assert_eq!(second.service.threads_of(&session_id), Vec::<String>::new());
    assert_eq!(
        session.scripted.service.threads_of(&session_id),
        [TEST_THREAD.to_owned()]
    );
    assert_eq!(session.processes.process_identity(&session_id), None);
}

// Killed by dropping the adoption's record of the service's process, by minting a sequence for
// each session on one process, by dropping the let-go's or the exit's removal, and by reusing the
// sequence for a process that replaced the service's under the same pid.
#[tokio::test(start_paused = true)]
async fn an_established_session_is_kept_under_its_service_process_until_it_lets_go() {
    let mut session = TestCodexSession::start().await;
    let session_id = session.task.record.session_id;
    let folder = tempfile::tempdir().expect("the test makes a folder");

    let (second, result) =
        resume_on_second_service(&mut session, 4242, json!({}), ResumeFunctionLegs::default())
            .await;

    assert!(matches!(result, DriverResumeResult::Resumed { .. }));
    assert!(Arc::ptr_eq(&session.task.record.service, &second.service));
    let identity = session
        .processes
        .process_identity(&session_id)
        .expect("the session's service process is recorded");
    assert_eq!(identity.process_id, 4242);
    // Another session on the same process is kept under the same identity.
    let other_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let (other_inbound, _other_items) = codex_session_inbound(other_id);
    second.service.attach_session(other_inbound);
    let establishment = session.establishment(folder.path());
    establishment.record_service_process(other_id, &second.service);
    assert_eq!(
        session.processes.process_identity(&other_id),
        Some(identity)
    );

    establishment.let_go_service_process(session_id);
    assert_eq!(session.processes.process_identity(&session_id), None);
    assert_eq!(
        session.processes.process_identity(&other_id),
        Some(identity)
    );
    establishment.forget_service_process(&second.service);
    assert_eq!(session.processes.process_identity(&other_id), None);
    // The service's process replaced by one the system gave the same pid.
    second.report_process(4242);
    let next_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    establishment.record_service_process(next_id, &second.service);
    let next = session
        .processes
        .process_identity(&next_id)
        .expect("the next session's service process is recorded");
    assert_eq!(next.process_id, 4242);
    assert_ne!(next.spawn_sequence, identity.spawn_sequence);
}

// A resume in place ends the leg the record held once, reports on the resumed conversation's own
// leg, and forgets the startups the left conversation reported, so a server it left starting
// cannot hold back the new round's list. Killed by leaving the old leg open, by keeping the old
// producer, by ending the new leg, and by keeping the old startups.
#[tokio::test(start_paused = true)]
async fn a_resume_in_place_ends_the_held_leg_and_reports_on_its_own() {
    let mut session = TestCodexSession::start().await;
    let old_sink = Arc::new(CountingStatusSink::default());
    let new_sink = Arc::new(CountingStatusSink::default());
    session.task.record.on_mcp_server_status =
        Some(Arc::clone(&old_sink) as McpServerStatusProducer);
    session
        .task
        .handle(mcp_server_startup(TEST_THREAD, "github", "starting", None))
        .await;
    let legs = ResumeFunctionLegs {
        on_mcp_server_status: Some(Arc::clone(&new_sink) as McpServerStatusProducer),
    };

    let (_second, result) = resume_on_second_service(&mut session, 4242, json!({}), legs).await;

    assert!(matches!(result, DriverResumeResult::Resumed { .. }));
    assert_eq!(old_sink.ends(), 1, "the held leg ends once");
    assert_eq!(new_sink.ends(), 0, "the resumed leg stays open");
    let held = session
        .task
        .record
        .on_mcp_server_status
        .as_ref()
        .expect("the record holds the resumed leg's producer");
    assert!(Arc::ptr_eq(
        held,
        &(Arc::clone(&new_sink) as McpServerStatusProducer)
    ));
    assert!(
        session.task.record.mcp_server_startups.is_empty(),
        "the left conversation's startups were kept"
    );
}
