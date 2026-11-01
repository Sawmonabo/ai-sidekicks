//! A session resumed through the driver: its conversation's fixed start carried from binding to
//! binding, a loaded conversation joined as it runs, and a resume Codex refused while closing the
//! conversation sent again.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::SessionContextReading;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;

use super::super::CodexDriver;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::driver::codex::session::test_fixture::{
    OneFolder, TEST_THREAD, TestDaemonTurnBindings, no_turns,
};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::schema::schema_parts;
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, OpenTurnResume, ProviderTurnAnswer, ResumeSessionParams,
    ResumedRunAnswer,
};
use crate::driver::test_registry::{new_run_id, new_session_id, test_driver_services};
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::port::permission_ask::test_port::RecordedAsks;
use crate::port::run_host::test_host::{EngineCall, RecordingRunEngine};
use crate::run::delivery::LateAppendableRow;
use crate::run::posture::compose_execution_posture;
use crate::runtime_binding::resume::compose_resume_session_params;
use crate::runtime_binding::store::{
    RuntimeBinding, RuntimeBindingRelaunch, RuntimeBindingStore, mint_runtime_binding_id,
    read_binding,
};
use crate::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};

/// The conversation of the helper the joined conversation runs.
const HELPER_THREAD: &str = "thread-helper";

/// The turn the joined conversation runs.
const LEAD_TURN: &str = "turn-1";

/// The fixed start the first binding carries, in tokens.
const FIXED_START_TOKENS: u64 = 12_000;

/// The window the usage report names, in tokens.
const WINDOW_TOKENS: u64 = 258_400;

/// Every context reading the driver publishes, in order.
#[derive(Default)]
struct CollectedReadings(Mutex<Vec<SessionContextReading>>);

impl ContextReadingPublisher for CollectedReadings {
    fn publish_context_reading(&self, reading: SessionContextReading) {
        lock(&self.0).push(reading);
    }
}

// The resume params `binding` composes for `session_id`, naming `live_runs`.
fn resume_params(
    session_id: SessionId,
    binding: &RuntimeBinding,
    live_runs: Vec<LiveRunResume>,
) -> ResumeSessionParams {
    compose_resume_session_params(
        session_id,
        AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        binding,
        mint_runtime_binding_id(),
        FreeFormText::new("gpt-5".to_owned()).expect("a model"),
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
    .expect("the binding resumes")
}

/// A driver on a scripted service, with the stores and ports a resume reaches, and a binding of
/// [`TEST_THREAD`] to resume.
struct ResumeHarness {
    scripted: ScriptedCodexService,
    database: TestDatabase,
    bindings: Arc<RuntimeBindingStore>,
    engine: Arc<RecordingRunEngine>,
    readings: Arc<CollectedReadings>,
    asks: Arc<RecordedAsks>,
    driver: CodexDriver,
    session_id: SessionId,
    binding: RuntimeBinding,
    _folder: TempDir,
}

impl ResumeHarness {
    // A harness whose binding keeps `runtime_metadata`.
    async fn start(runtime_metadata: Map<String, Value>) -> Self {
        let folder = tempfile::tempdir().expect("a test folder");
        let scripted = start_scripted_codex_service();
        scripted.report_version("codex-cli 0.163.0");
        let database = TestDatabase::new(schema_parts());
        let bindings = Arc::new(open_store(&database).await);
        let engine = Arc::new(RecordingRunEngine::default());
        let readings = Arc::new(CollectedReadings::default());
        let asks = Arc::new(RecordedAsks::default());
        let mut services = test_driver_services();
        services.runtime_bindings = Arc::clone(&bindings) as _;
        let ports = &services.ports;
        assert!(ports.run_engine.register(Arc::clone(&engine) as _).is_ok());
        assert!(
            ports
                .inbound_dispatch
                .register(Arc::clone(&engine) as _)
                .is_ok()
        );
        let agent_id =
            AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id");
        assert!(
            ports
                .daemon_turn_bindings
                .register(Arc::new(TestDaemonTurnBindings::new(agent_id)))
                .is_ok()
        );
        assert!(
            ports
                .spawn_contexts
                .register(Arc::new(OneFolder(folder.path().join("work"))) as _)
                .is_ok()
        );
        assert!(
            ports
                .context_readings
                .register(Arc::clone(&readings) as _)
                .is_ok()
        );
        assert!(
            ports
                .permission_asks
                .register(Arc::clone(&asks) as _)
                .is_ok()
        );
        let mut driver = CodexDriver::new(&services);
        driver.registry = CodexServiceRegistry::holding(&scripted);
        let mut input = binding_input(
            spawn_config_on(test_provider_account_id()),
            spawned_build("0.130.0", "/opt/codex/bin"),
        );
        input.resume_handle = Some(TEST_THREAD.to_owned());
        input.runtime_metadata = runtime_metadata;
        let binding = bindings
            .create(input)
            .await
            .expect("the binding is recorded");
        Self {
            scripted,
            database,
            bindings,
            engine,
            readings,
            asks,
            driver,
            session_id: new_session_id(),
            binding,
            _folder: folder,
        }
    }

    // Resumes the harness's binding naming `live_runs`, `answer` answering as the service each
    // request the resume sends.
    async fn resume(
        &mut self,
        live_runs: Vec<LiveRunResume>,
        answer: impl FnMut(&ScriptedService, &Value),
    ) -> DriverResumeResult {
        let params = resume_params(self.session_id, &self.binding, live_runs);
        Box::pin(drive_resume(
            &self.driver,
            &mut self.scripted.script,
            params,
            answer,
        ))
        .await
    }
}

// Drives `params`' resume through `driver`, `answer` answering as the service each request it
// sends, and answers its result.
async fn drive_resume(
    driver: &CodexDriver,
    script: &mut ScriptedService,
    params: ResumeSessionParams,
    mut answer: impl FnMut(&ScriptedService, &Value),
) -> DriverResumeResult {
    let resuming = driver.resume_session(params);
    tokio::pin!(resuming);
    loop {
        tokio::select! {
            resumed = &mut resuming => return resumed.expect("the resume answers"),
            sent = script.next_sent() => answer(script, &sent),
        }
    }
}

// Resumes `binding` through `driver`, answering as the service a cold resume of its conversation
// in place, and records the binding it minted on `binding`'s row, as the daemon does, in
// `database`.
async fn resume_and_record(
    driver: &CodexDriver,
    script: &mut ScriptedService,
    (bindings, database): (&RuntimeBindingStore, &TestDatabase),
    session_id: SessionId,
    binding: &RuntimeBinding,
) -> RuntimeBinding {
    let params = resume_params(session_id, binding, Vec::new());
    let resumed = Box::pin(drive_resume(driver, script, params, answer_resume_request)).await;
    let DriverResumeResult::Resumed {
        binding_id,
        resume_handle,
        spawned_version,
        ..
    } = resumed
    else {
        panic!("the conversation resumes: {resumed:?}");
    };
    bindings
        .record_relaunch(RuntimeBindingRelaunch {
            predecessor_id: binding.id.clone(),
            binding_id: binding_id.clone(),
            resume_handle: resume_handle.as_str().to_owned(),
            spawned_version,
            left_conversations: Vec::new(),
        })
        .await
        .expect("the resumed binding is recorded");
    read_binding(&database.reader(), &binding_id)
        .expect("the binding reads")
        .expect("the resumed binding has a row")
}

// Answers one request a resume sends, as the service holding no conversation loaded: the resume of
// the conversation in place under the profile it asks for, and every other step as done.
fn answer_resume_request(script: &ScriptedService, sent: &Value) {
    let answer = match sent["method"].as_str() {
        Some("thread/loaded/list") => json!({"data": [], "nextCursor": null}),
        Some("thread/resume") => resumed_thread(sent, &json!({"type": "idle"})),
        Some("thread/turns/list") => no_turns(),
        Some("thread/backgroundTerminals/list") => json!({"data": []}),
        Some("thread/backgroundTerminals/clean" | "thread/settings/update") => json!({}),
        Some("thread/unsubscribe") => json!({"status": "unsubscribed"}),
        Some("account/rateLimits/read") => json!({"rateLimits": null}),
        other => panic!("the resume sent {other:?}"),
    };
    script.answer(sent, &answer);
}

// The reply to the `thread/resume` `sent`: its conversation, standing at `status`, under the
// profile it asks for.
fn resumed_thread(sent: &Value, status: &Value) -> Value {
    json!({
        "thread": {
            "id": sent["params"]["threadId"],
            "sessionId": "codex-session",
            "status": status,
        },
        "activePermissionProfile": {"id": sent["params"]["permissions"]},
    })
}

// The settings a `thread/resume` `sent` carries: each of its params with a value but the
// conversation and the history's paging.
fn sent_settings(sent: &Value) -> Vec<String> {
    sent["params"]
        .as_object()
        .expect("a resume sends params")
        .iter()
        .filter(|(name, value)| {
            !value.is_null() && name.as_str() != "threadId" && name.as_str() != "excludeTurns"
        })
        .map(|(name, _)| name.clone())
        .collect()
}

// A session whose binding carries its fixed start is resumed, then restarted again with no usage
// report between: the binding the second resume reads still carries the fixed start, and the
// conversation's first reading after it has its bottom stop there. Killed by a resumed binding
// recorded with no recovery data, the carry at bind time dropped.
#[tokio::test]
async fn a_resume_and_a_restart_with_no_report_keep_the_fixed_start() {
    let mut harness = ResumeHarness::start(Map::from_iter([(
        "contextFixedStartTokens".to_owned(),
        Value::from(FIXED_START_TOKENS),
    )]))
    .await;
    let first = harness.binding.clone();

    let resumed = resume_and_record(
        &harness.driver,
        &mut harness.scripted.script,
        (&harness.bindings, &harness.database),
        harness.session_id,
        &first,
    )
    .await;
    let restarted = resume_and_record(
        &harness.driver,
        &mut harness.scripted.script,
        (&harness.bindings, &harness.database),
        harness.session_id,
        &resumed,
    )
    .await;
    assert_eq!(restarted.runtime_metadata, first.runtime_metadata);

    // A report of the restored conversation, which is no conversation's start.
    harness.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": "turn-1",
            "tokenUsage": {
                "total": {"inputTokens": 50_000, "outputTokens": 0, "totalTokens": 50_000},
                "last": {"inputTokens": 2_000, "outputTokens": 0, "totalTokens": 2_000},
                "modelContextWindow": WINDOW_TOKENS,
            },
        },
    }));
    let readings = &harness.readings;
    let reported = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reported = lock(&readings.0)
                .iter()
                .find(|reading| reading.usage.is_some())
                .cloned();
            if let Some(reported) = reported {
                return reported;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the report's reading is published");
    // A tenth of the window above the fixed start's share, rounded up.
    assert_eq!(reported.compaction.bottom_stop_percent, Percent::new(15.0));
}

// A conversation the service holds loaded, with a turn running, an approval waiting and a helper
// running, is joined in place: the resume sends `thread/resume` with no setting and no
// `thread/fork`, both runs answer still running, the waiting approval reaches the permission
// pipeline under Codex's own request id on the lead's run, and the next words of the turn and of
// the helper land on the lead's run and the helper's child run. Killed by the fork kept for a
// loaded conversation (the answer refuses `thread/fork`), by settings sent on the join, and by the
// helper's record left unrestored (its words land on no run).
#[tokio::test]
async fn a_loaded_conversation_is_joined_as_it_runs() {
    let mut harness = ResumeHarness::start(Map::new()).await;
    let lead_run = new_run_id();
    let helper_run = new_run_id();
    let live_runs = vec![
        LiveRunResume {
            run_id: lead_run,
            parent_run_id: None,
            open_turns: vec![OpenTurnResume {
                turn_number: SafeInt::<1>::new(1).expect("one is a turn number"),
                provider_turn_id: Some(
                    ProviderTurnId::new(LEAD_TURN.to_owned()).expect("a turn id"),
                ),
                started_event_id: FreeFormText::new(mint_uuid_v7().to_string())
                    .expect("a minted UUID is an event id"),
            }],
            subagent_id: None,
        },
        LiveRunResume {
            run_id: helper_run,
            parent_run_id: Some(lead_run),
            open_turns: Vec::new(),
            subagent_id: Some(SubagentId::new(HELPER_THREAD.to_owned()).expect("a helper id")),
        },
    ];
    let mut resumes = Vec::new();

    let resumed = harness
        .resume(live_runs, |script, sent| match sent["method"].as_str() {
            Some("thread/loaded/list") => script.answer(
                sent,
                &json!({"data": [TEST_THREAD, HELPER_THREAD], "nextCursor": null}),
            ),
            Some("thread/resume") => {
                resumes.push(sent.clone());
                script.answer(
                    sent,
                    &resumed_thread(
                        sent,
                        &json!({"type": "active", "activeFlags": ["waitingOnApproval"]}),
                    ),
                );
                // Codex sends a joined conversation's waiting asks again right after its reply.
                script.send(&json!({
                    "jsonrpc": "2.0",
                    "id": 42,
                    "method": "item/commandExecution/requestApproval",
                    "params": {
                        "threadId": TEST_THREAD,
                        "turnId": LEAD_TURN,
                        "itemId": "call-1",
                        "command": "cargo test",
                    },
                }));
            }
            Some("thread/fork") => panic!("a loaded conversation is forked"),
            Some("thread/turns/list") => script.answer(
                sent,
                &json!({
                    "data": [{"id": LEAD_TURN, "items": [], "status": "inProgress"}],
                    "nextCursor": null,
                }),
            ),
            _ => answer_resume_request(script, sent),
        })
        .await;

    let [resume] = resumes.as_slice() else {
        panic!("one resume is sent: {resumes:?}");
    };
    assert_eq!(resume["params"]["threadId"], TEST_THREAD);
    assert_eq!(sent_settings(resume), Vec::<String>::new());
    let DriverResumeResult::Resumed { runs, .. } = resumed else {
        panic!("the conversation is joined: {resumed:?}");
    };
    assert_eq!(
        runs,
        [
            ResumedRunAnswer {
                run_id: lead_run,
                turn: ProviderTurnAnswer::StillRunning,
            },
            ResumedRunAnswer {
                run_id: helper_run,
                turn: ProviderTurnAnswer::StillRunning,
            },
        ]
    );
    let ask = tokio::time::timeout(Duration::from_secs(10), harness.asks.first())
        .await
        .expect("the waiting approval reaches the permission pipeline");
    assert_eq!((ask.request_id.as_str(), ask.run_id), ("42", lead_run));

    for (thread_id, turn_id, item_id) in [
        (TEST_THREAD, LEAD_TURN, "message-lead"),
        (HELPER_THREAD, "helper-turn", "message-helper"),
    ] {
        harness.scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "delta": "still at it",
            },
        }));
    }
    let landed = |item_id: &'static str| {
        let landing = harness.engine.wait_until(move |calls| {
            calls.iter().find_map(|call| match call {
                EngineCall::Deliver(delivery) => match &delivery.row {
                    Some(LateAppendableRow::AgentMessageSent(payload))
                        if payload.provider_message_id.as_str() == item_id =>
                    {
                        Some(payload.run_id)
                    }
                    _ => None,
                },
                EngineCall::StartTurn(_)
                | EngineCall::CountStep(_)
                | EngineCall::RecordTurnEnd(..)
                | EngineCall::StartDaemonTurn(_)
                | EngineCall::EndTurnOnProcessExit(_)
                | EngineCall::EndTurnOnClose(_) => None,
            })
        });
        tokio::time::timeout(Duration::from_secs(10), landing)
    };
    let lead_landed = landed("message-lead").await;
    assert_eq!(lead_landed.expect("the turn's words land"), lead_run);
    let helper_landed = landed("message-helper").await;
    assert_eq!(helper_landed.expect("the helper's words land"), helper_run);
}

// A resume Codex refuses while it closes the loaded conversation waits for the close and loads the
// conversation again with the session's settings. Killed by no retry: the refusal fails the resume.
#[tokio::test]
async fn a_resume_refused_while_closing_is_sent_again() {
    let mut harness = ResumeHarness::start(Map::new()).await;
    let mut resumes = Vec::new();
    let mut loaded_reads = 0;

    let resumed = harness
        .resume(Vec::new(), |script, sent| match sent["method"].as_str() {
            Some("thread/loaded/list") => {
                loaded_reads += 1;
                // Loaded at the resume's first read, closed by the read that confirms the close.
                let loaded = if loaded_reads == 1 {
                    json!([TEST_THREAD])
                } else {
                    json!([])
                };
                script.answer(sent, &json!({"data": loaded, "nextCursor": null}));
            }
            Some("thread/resume") => {
                resumes.push(sent.clone());
                if resumes.len() == 1 {
                    script.send(&json!({
                        "jsonrpc": "2.0",
                        "id": sent["id"],
                        "error": {
                            "code": -32600,
                            "message": format!(
                                "thread {TEST_THREAD} is closing; retry thread/resume after the \
                                 thread is closed"
                            ),
                        },
                    }));
                } else {
                    script.answer(sent, &resumed_thread(sent, &json!({"type": "idle"})));
                }
            }
            _ => answer_resume_request(script, sent),
        })
        .await;

    assert!(
        matches!(resumed, DriverResumeResult::Resumed { .. }),
        "the conversation resumes: {resumed:?}"
    );
    let [joined, loaded] = resumes.as_slice() else {
        panic!("the resume is sent twice: {resumes:?}");
    };
    // The join of the loaded conversation sends no setting; the load after its close sends them.
    assert_eq!(sent_settings(joined), Vec::<String>::new());
    assert!(sent_settings(loaded).contains(&"model".to_owned()));
}
