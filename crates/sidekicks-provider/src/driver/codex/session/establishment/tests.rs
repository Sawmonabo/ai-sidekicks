use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use super::CodexEstablishedSession;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service, start_scripted_joined_service,
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
use crate::driver::session_control::{
    CreateSessionParams, DriverResumeResult, LiveRunResume, OpenTurnResume, ProviderTurnAnswer,
};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::run_host::test_host::EngineCall;
use crate::process_identity::ProviderProcessIds as _;
use crate::run::posture::compose_execution_posture;
use crate::run::turn_end::TurnOutcome;
use crate::runtime_binding::resume::{ResumeFunctionLegs, compose_resume_session_params};
use crate::runtime_binding::store::mint_runtime_binding_id;
use crate::runtime_binding::test_store::{
    binding_input, spawn_config_on, spawned_build, test_provider_account_id,
};

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

/// The conversation a resume by handle adopts, beside the test session's own.
const ADOPTED_THREAD: &str = "thread-adopted";

/// The lead run's turn the end of its service cut.
const CUT_TURN: &str = "turn-cut";

/// The first turn of the cut turn's chain.
const ROOT_TURN: &str = "turn-root";

/// The turn Codex starts for the continuation.
const CONTINUATION_TURN: &str = "turn-continued";

/// The cut turn's number within its run.
const CUT_TURN_NUMBER: u64 = 2;

// A lead run standing at `run_state` with the cut turn open.
fn lead_run(run_id: RunId, run_state: RunState) -> LiveRunResume {
    LiveRunResume {
        run_id,
        parent_run_id: None,
        open_turns: vec![OpenTurnResume {
            turn_number: SafeInt::<1>::new(CUT_TURN_NUMBER).expect("two is a turn number"),
            provider_turn_id: Some(ProviderTurnId::new(CUT_TURN.to_owned()).expect("a turn id")),
            started_event_id: FreeFormText::new(mint_uuid_v7().to_string())
                .expect("a minted UUID is an event id"),
        }],
        subagent_id: None,
        is_stopping: false,
        run_state,
    }
}

// What a resume by handle did: its result, the session it established, and each `turn/start` it
// sent.
struct Adoption {
    result: DriverResumeResult,
    established: Option<CodexEstablishedSession>,
    turn_starts: Vec<Value>,
}

impl Adoption {
    // The answer for `run_id` the result gives.
    fn answer_of(&self, run_id: RunId) -> ProviderTurnAnswer {
        let DriverResumeResult::Resumed { runs, .. } = &self.result else {
            panic!("the conversation is adopted: {:?}", self.result);
        };
        runs.iter()
            .find(|answer| answer.run_id == run_id)
            .map(|answer| answer.turn)
            .expect("the run is answered")
    }
}

// Adopts `ADOPTED_THREAD` by its handle on the test session's service, naming `live_runs`: the
// service holds it unloaded, reads it idle once resumed, lists `listed_turns`, and answers each
// `turn/start` with `turn_start_answer` (a refusal where it holds an error).
async fn adopt(
    session: &mut TestCodexSession,
    live_runs: Vec<LiveRunResume>,
    listed_turns: Value,
    turn_start_answer: Value,
) -> Adoption {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    session.scripted.report_version("codex-cli 0.163.0");
    let mut input = binding_input(
        spawn_config_on(test_provider_account_id()),
        spawned_build("0.163.0", "/opt/codex/bin"),
    );
    input.resume_handle = Some(ADOPTED_THREAD.to_owned());
    let binding = session
        .bindings
        .create(input)
        .await
        .expect("the binding is recorded");
    let params = compose_resume_session_params(
        new_session_id(),
        AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        &binding,
        mint_runtime_binding_id(),
        ProviderToken::new("gpt-5".to_owned()).expect("the model fits"),
        None,
        SessionMode::Build,
        compose_execution_posture(
            PermissionLevel::Readonly,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
        ),
        Vec::new(),
        ProviderRowValues::default(),
        Vec::new(),
        live_runs,
    )
    .expect("the binding resumes");
    let script = &mut session.scripted.script;
    let mut turn_starts = Vec::new();
    let resuming = establishment.resume_by_handle(&params);
    tokio::pin!(resuming);
    let resumed = loop {
        tokio::select! {
            resumed = &mut resuming => break resumed,
            sent = script.next_sent() => match sent["method"].as_str() {
                Some("thread/loaded/list") => {
                    script.answer(&sent, &json!({"data": [], "nextCursor": null}));
                }
                Some("thread/resume") => script.answer(
                    &sent,
                    &json!({
                        "thread": {
                            "id": sent["params"]["threadId"],
                            "sessionId": "codex-session",
                            "status": {"type": "idle"},
                        },
                        "activePermissionProfile": {"id": sent["params"]["permissions"]},
                    }),
                ),
                Some("thread/turns/list") => {
                    script.answer(&sent, &json!({"data": listed_turns, "nextCursor": null}));
                }
                Some("thread/settings/update") => script.answer(&sent, &json!({})),
                Some("turn/start") => {
                    turn_starts.push(sent.clone());
                    if turn_start_answer.get("error").is_some() {
                        let mut refusal = turn_start_answer.clone();
                        refusal["jsonrpc"] = json!("2.0");
                        refusal["id"] = sent["id"].clone();
                        script.send(&refusal);
                    } else {
                        script.answer(&sent, &turn_start_answer);
                    }
                }
                method => panic!("the service was not asked {method:?}"),
            },
        }
    };
    Adoption {
        result: resumed.result,
        established: resumed.established,
        turn_starts,
    }
}

// The turn ends among `calls`: the daemon's own, then those its provider reported.
fn turn_ends(calls: &[EngineCall]) -> (Vec<EngineCall>, Vec<EngineCall>) {
    let daemon_ends = calls
        .iter()
        .filter(|call| matches!(call, EngineCall::RecordDaemonTurnEnd(..)))
        .cloned()
        .collect();
    let provider_ends = calls
        .iter()
        .filter(|call| matches!(call, EngineCall::RecordTurnEnd(..)))
        .cloned()
        .collect();
    (daemon_ends, provider_ends)
}

// The cut turn's end the daemon writes for `run_id`.
fn cut_turn_end(run_id: RunId) -> EngineCall {
    EngineCall::RecordDaemonTurnEnd(
        run_id,
        SafeInt::<1>::new(CUT_TURN_NUMBER).expect("two is a turn number"),
        TurnOutcome::Interrupted(Some(TurnEndCause::DaemonRestart)),
    )
}

// A running lead whose turn the end of the daemon's own service cut, listed interrupted with no end
// time or not listed at all, continues in one turn carrying Codex's own continuation words: the
// cut turn ends in the log as the daemon's restart interrupted it, the new turn is the run's and
// the cut one is not, and the run answers still running. Killed by `Gone` kept (no turn sent), by
// the cut turn left bound (its listed end would end the run), by the cut turn left open in the log
// (a later restart binds it), by its end written as Codex's (the run ends), by a message id sent,
// and by the cut turn's own id sent as the root.
#[rstest]
#[case::listed_interrupted(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted", "rootTurnId": ROOT_TURN}]),
    Some(ROOT_TURN)
)]
#[case::not_listed(json!([]), None)]
#[tokio::test(start_paused = true)]
async fn a_lead_run_its_services_end_cut_continues_in_one_turn_of_codexs_words(
    #[case] listed_turns: Value,
    #[case] root_turn_id: Option<&str>,
) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        listed_turns,
        json!({"turn": {"id": CONTINUATION_TURN, "items": [], "status": "inProgress"}}),
    )
    .await;

    let [turn_start] = adoption.turn_starts.as_slice() else {
        panic!("one turn is sent: {:?}", adoption.turn_starts);
    };
    let params = &turn_start["params"];
    assert_eq!(params["threadId"], ADOPTED_THREAD);
    assert_eq!(
        params["input"][0]["text"],
        "The server restarted and interrupted the previous turn. Continue the unfinished work \
         from the saved conversation. Check the current state before repeating actions that may \
         already have completed."
    );
    assert_eq!(params["turnTrigger"], "daemon_recovery");
    assert_eq!(
        params.get("rootTurnId").and_then(Value::as_str),
        root_turn_id
    );
    assert!(params["collaborationMode"].is_object());
    assert!(params["environments"].is_array());
    assert_eq!(params.get("clientUserMessageId"), None);
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![cut_turn_end(run_id)], Vec::new())
    );
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CONTINUATION_TURN),
        Some(run_id)
    );
    assert_eq!(established.record.active_turn_run(CUT_TURN), None);
    assert!(session.task.run_routes.binding_for(run_id).is_some());
}

// No turn continues a run the rows leave as it stands: a cut turn listed over, one stopped with its
// end time, a run pausing or waiting on the person, a lead held for its paused helper, and the
// same listing on a service the daemon only joined, where Codex continues its own. Each answers as
// Codex's listing has it, with no end written. Killed by the continuation on a finished turn, on a
// stopped turn, on a run not running, on a lead held for its helper, and on a joined service.
#[rstest]
#[case::listed_completed(
    json!([{"id": CUT_TURN, "items": [], "status": "completed", "completedAt": 1_767_000_000}]),
    RunState::Running,
    None,
    false
)]
#[case::interrupted_with_its_end_time(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted", "completedAt": 1_767_000_000}]),
    RunState::Running,
    None,
    false
)]
#[case::pausing(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Pausing,
    None,
    false
)]
#[case::waiting_for_approval(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::WaitingForApproval,
    None,
    false
)]
#[case::helper_paused(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    Some(RunState::Paused),
    false
)]
#[case::joined_service(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    None,
    true
)]
#[tokio::test(start_paused = true)]
async fn no_turn_continues_a_run_the_rows_leave_as_it_stands(
    #[case] listed_turns: Value,
    #[case] lead_state: RunState,
    #[case] helper_state: Option<RunState>,
    #[case] is_joined: bool,
) {
    let scripted = if is_joined {
        start_scripted_joined_service()
    } else {
        start_scripted_codex_service()
    };
    let mut session = TestCodexSession::start_on(scripted).await;
    let run_id = new_run_id();
    let mut live_runs = vec![lead_run(run_id, lead_state)];
    if let Some(helper_state) = helper_state {
        live_runs.push(LiveRunResume {
            run_id: new_run_id(),
            parent_run_id: Some(run_id),
            open_turns: Vec::new(),
            subagent_id: Some(SubagentId::new("thread-helper".to_owned()).expect("a helper id")),
            is_stopping: false,
            run_state: helper_state,
        });
    }

    let adoption = adopt(
        &mut session,
        live_runs,
        listed_turns,
        json!({"turn": {"id": CONTINUATION_TURN, "items": [], "status": "inProgress"}}),
    )
    .await;

    assert_eq!(adoption.turn_starts, Vec::<Value>::new());
    assert_eq!(
        adoption.answer_of(run_id),
        ProviderTurnAnswer::EndedByProvider
    );
    assert_eq!(turn_ends(&session.engine.calls()), (Vec::new(), Vec::new()));
}

// A continuation Codex refuses answers the run gone, its cut turn already ended in the log, and
// holds no turn for the run. Killed by `StillRunning` kept on a refusal.
#[tokio::test(start_paused = true)]
async fn a_refused_continuation_answers_the_run_gone() {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        json!([{"id": CUT_TURN, "items": [], "status": "interrupted", "rootTurnId": ROOT_TURN}]),
        json!({"error": {"code": -32600, "message": "the turn is refused"}}),
    )
    .await;

    assert_eq!(adoption.turn_starts.len(), 1);
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::Gone);
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![cut_turn_end(run_id)], Vec::new())
    );
    let established = adoption.established.expect("the session is established");
    assert_eq!(established.record.newest_active_turn_for_run(run_id), None);
    assert!(session.task.run_routes.binding_for(run_id).is_none());
}
