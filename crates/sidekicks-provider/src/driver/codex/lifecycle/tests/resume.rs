//! A session resumed through the driver, its conversation's fixed start carried from binding to
//! binding.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::SessionContextReading;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::super::CodexDriver;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::test_fixture::{
    OneFolder, TEST_THREAD, TestDaemonTurnBindings, no_turns,
};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::schema::schema_parts;
use crate::driver::session_control::{DriverResumeResult, ResumeSessionParams};
use crate::driver::test_registry::{new_session_id, test_driver_services};
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::run::posture::compose_execution_posture;
use crate::runtime_binding::resume::{ResumeFunctionLegs, compose_resume_session_params};
use crate::runtime_binding::store::{
    RuntimeBinding, RuntimeBindingRelaunch, RuntimeBindingStore, mint_runtime_binding_id,
    read_binding,
};
use crate::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};

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

// The resume params `binding` composes for `session_id`.
fn resume_params(session_id: SessionId, binding: &RuntimeBinding) -> ResumeSessionParams {
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
        ResumeFunctionLegs::default(),
        Vec::new(),
    )
    .expect("the binding resumes")
}

// Resumes `binding` through `driver`, answering as the service a fork of `from` onto `to`, and
// records the binding it minted on `binding`'s row, as the daemon does, in `database`.
async fn resume_and_record(
    driver: &CodexDriver,
    script: &mut ScriptedService,
    (bindings, database): (&RuntimeBindingStore, &TestDatabase),
    session_id: SessionId,
    binding: &RuntimeBinding,
    (from, to): (&str, &str),
) -> RuntimeBinding {
    let resuming = driver.resume_session(resume_params(session_id, binding));
    tokio::pin!(resuming);
    let resumed = loop {
        tokio::select! {
            resumed = &mut resuming => break resumed.expect("the resume answers"),
            sent = script.next_sent() => answer_resume_request(script, &sent, from, to),
        }
    };
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

// Answers one request a resume sends, as the service: the fork of `from` onto `to` under the
// profile it asks for, and every other step of the move as done.
fn answer_resume_request(script: &ScriptedService, sent: &Value, from: &str, to: &str) {
    let answer = match sent["method"].as_str() {
        Some("thread/fork") => {
            assert_eq!(sent["params"]["threadId"], from);
            json!({
                "thread": {"id": to, "sessionId": "codex-session"},
                "activePermissionProfile": {"id": sent["params"]["permissions"]},
            })
        }
        Some("thread/turns/list") => no_turns(),
        Some("thread/backgroundTerminals/list") => json!({"data": []}),
        Some("thread/backgroundTerminals/clean" | "thread/settings/update") => json!({}),
        Some("thread/unsubscribe") => json!({"status": "unsubscribed"}),
        Some("account/rateLimits/read") => json!({"rateLimits": null}),
        other => panic!("the resume sent {other:?}"),
    };
    script.answer(sent, &answer);
}

// A session whose binding carries its fixed start is resumed, then restarted again with no usage
// report between: the binding the second resume reads still carries the fixed start, and the
// conversation's first reading after it has its bottom stop there. Killed by a resumed binding
// recorded with no recovery data, the carry at bind time dropped.
#[tokio::test]
async fn a_resume_and_a_restart_with_no_report_keep_the_fixed_start() {
    let folder = tempfile::tempdir().expect("a test folder");
    let mut scripted = start_scripted_codex_service();
    scripted.report_version("codex-cli 0.163.0");
    let database = TestDatabase::new(schema_parts());
    let bindings = Arc::new(open_store(&database).await);
    let engine = Arc::new(RecordingRunEngine::default());
    let readings = Arc::new(CollectedReadings::default());
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
    let agent_id = AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id");
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
    let mut driver = CodexDriver::new(&services);
    driver.registry = CodexServiceRegistry::holding(&scripted);
    let session_id = new_session_id();
    let mut input = binding_input(
        spawn_config_on(test_provider_account_id()),
        spawned_build("0.130.0", "/opt/codex/bin"),
    );
    input.resume_handle = Some(TEST_THREAD.to_owned());
    input.runtime_metadata = Map::from_iter([(
        "contextFixedStartTokens".to_owned(),
        Value::from(FIXED_START_TOKENS),
    )]);
    let first = bindings
        .create(input)
        .await
        .expect("the binding is recorded");

    let resumed = resume_and_record(
        &driver,
        &mut scripted.script,
        (&bindings, &database),
        session_id,
        &first,
        (TEST_THREAD, "thread-2"),
    )
    .await;
    let restarted = resume_and_record(
        &driver,
        &mut scripted.script,
        (&bindings, &database),
        session_id,
        &resumed,
        ("thread-2", "thread-3"),
    )
    .await;
    assert_eq!(restarted.runtime_metadata, first.runtime_metadata);

    // A report of the restored conversation, which is no conversation's start.
    scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": "thread-3",
            "turnId": "turn-1",
            "tokenUsage": {
                "total": {"inputTokens": 50_000, "outputTokens": 0, "totalTokens": 50_000},
                "last": {"inputTokens": 2_000, "outputTokens": 0, "totalTokens": 2_000},
                "modelContextWindow": WINDOW_TOKENS,
            },
        },
    }));
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
