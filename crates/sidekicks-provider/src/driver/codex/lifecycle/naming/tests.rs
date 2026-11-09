mod one_shot;
mod rest;
mod spent_deadline;
mod usage;

use std::sync::Arc;

use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{CODEX_NAMING_DEADLINE, TitleRequest, draw_title};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::pricing::{CodexRecorderPricing, CodexRequestPricer};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexHomeResolver, CodexServiceRegistry};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::side_questions::copy_turn::SessionUsageFiling;
use crate::driver::codex::session::test_fixture::{TestDaemonTurnBindings, turn_reply};
use crate::driver::codex::transport::connection::scripted_service::{
    ScriptedService, scripted_connection,
};
use crate::driver::contract::error::DriverError;
use crate::driver::ports::DriverPorts;
use crate::driver::test_registry::{new_agent_id, new_session_id, test_driver_services};
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::pricing::live::LivePricing;
use crate::runtime_binding::store::mint_runtime_binding_id;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The session's folder, which the title conversation is read and started under.
const FOLDER: &str = "/work/repository";

/// The title conversation the scripted service starts.
const TITLE_THREAD: &str = "title-thread";

/// The title conversation's turn.
const TITLE_TURN: &str = "title-turn";

/// The session's own model.
const SESSION_MODEL: &str = "gpt-5";

// The scripted service's home for the one account a test names; any other account has no home,
// and the person's own folder is one no service runs on.
struct AccountHome {
    provider_account_id: ProviderAccountId,
    home: CodexServiceHome,
}

impl CodexHomeResolver for AccountHome {
    fn codex_home_for<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>> {
        let home = (provider_account_id == &self.provider_account_id)
            .then(|| self.home.clone())
            .ok_or_else(|| DriverError::Internal("no home for that account".into()));
        Box::pin(async move { home })
    }

    fn terminal_reach_home(&self) -> CodexServiceHome {
        CodexServiceHome {
            codex_home: self.home.codex_home.join("personal-folder"),
            kind: CodexHomeKind::PersonalFolder,
        }
    }
}

// A driver whose only service is the scripted one, on `provider_account_id`'s home, each stored leg
// read from `engine`, its session pieces composing.
fn driver_on_account(
    scripted: &ScriptedCodexService,
    engine: &Arc<RecordingRunEngine>,
    provider_account_id: ProviderAccountId,
) -> CodexDriver {
    let services = test_driver_services();
    let ports = &services.ports;
    assert!(ports.run_engine.register(Arc::clone(engine) as _).is_ok());
    assert!(
        ports
            .inbound_dispatch
            .register(Arc::clone(engine) as _)
            .is_ok()
    );
    let agent_id = new_agent_id();
    assert!(
        ports
            .daemon_turn_bindings
            .register(Arc::new(TestDaemonTurnBindings::new(agent_id)))
            .is_ok()
    );
    let mut driver = CodexDriver::new(&services);
    driver.registry = CodexServiceRegistry::holding_on(
        scripted,
        Arc::new(AccountHome {
            provider_account_id,
            home: scripted.service.home().clone(),
        }),
    );
    driver
}

// A filing of a new session's spend on a binding of its own through `ports`.
fn filing_over(ports: &DriverPorts) -> SessionUsageFiling {
    SessionUsageFiling {
        usage: Arc::clone(&ports.usage),
        session_id: new_session_id(),
        binding_id: mint_runtime_binding_id(),
        provider_account_id: test_provider_account_id(),
        pricing: CodexRecorderPricing::new(Arc::new(LivePricing::new(
            DESCRIPTOR.provider_id(),
            Arc::new(CodexRequestPricer),
            ports,
        ))),
    }
}

// A title pass over a scripted connection that files nothing, run on its own task until `cancel`
// fires; the script, and the service it runs on, which the caller keeps for the pass's length.
fn start_pass(
    cancel: CancellationToken,
) -> (
    tokio::task::JoinHandle<Result<Option<String>, CodexError>>,
    ScriptedService,
    ScriptedCodexService,
) {
    let scripted = start_scripted_codex_service();
    let filing = filing_over(&DriverPorts::new());
    let service = Arc::clone(&scripted.service);
    let (pass, script) = start_filed_pass(cancel, Some(SESSION_MODEL), filing, service);
    (pass, script, scripted)
}

// A title pass of a session on `session_model` over a scripted connection, its spend filed through
// `filing` with its region read on `service`, run on its own task until `cancel` fires, and the
// script.
fn start_filed_pass(
    cancel: CancellationToken,
    session_model: Option<&str>,
    filing: SessionUsageFiling,
    service: Arc<CodexService>,
) -> (
    tokio::task::JoinHandle<Result<Option<String>, CodexError>>,
    ScriptedService,
) {
    let (connection, script, frames) = scripted_connection();
    let request = TitleRequest {
        session_id: filing.session_id,
        service,
        thread_id: Some("thread-1".to_owned()),
        working_directory: FOLDER.into(),
        session_model: session_model.map(str::to_owned),
        prompt: "Name this.".to_owned(),
    };
    let pass = tokio::spawn(async move {
        let deadline = Instant::now() + CODEX_NAMING_DEADLINE;
        draw_title(connection, frames, &request, filing, &cancel, deadline).await
    });
    (pass, script)
}

// The `config/read` the pass sends first, answered with two MCP servers, one named with a dot.
async fn answer_config_read(script: &mut ScriptedService) {
    let read = script.next_sent().await;
    assert_eq!(read["method"], "config/read");
    assert_eq!(
        read["params"],
        json!({"cwd": FOLDER, "includeLayers": false})
    );
    script.answer(
        &read,
        &json!({
            "config": {
                "model": "gpt-5",
                "mcp_servers": {"docs": {"command": "docs"}, "team.search": {"url": "http://x"}},
            },
            "origins": {},
        }),
    );
}

// The catalog read the pass sends next, answered with `models`.
async fn answer_model_list(script: &mut ScriptedService, models: &[&str]) {
    let listed = script.next_sent().await;
    assert_eq!(listed["method"], "model/list");
    let rows: Vec<Value> = models
        .iter()
        .map(|id| json!({"id": id, "displayName": id, "hidden": false}))
        .collect();
    script.answer(&listed, &json!({"data": rows, "nextCursor": null}));
}

// The start of the title conversation answered as running under `sandbox_type` on the session's
// model at the priority tier, as Codex resolves them, and the start as sent.
async fn answer_thread_start(script: &mut ScriptedService, sandbox_type: &str) -> Value {
    let started = script.next_sent().await;
    assert_eq!(started["method"], "thread/start");
    script.answer(
        &started,
        &json!({
            "thread": {"id": TITLE_THREAD, "sessionId": "codex-session"},
            "sandbox": {"type": sandbox_type, "networkAccess": false},
            "model": SESSION_MODEL,
            "serviceTier": "priority",
        }),
    );
    started
}

// The `turn/start` the pass sends on the title conversation, unanswered.
async fn next_turn_start(script: &mut ScriptedService) -> Value {
    let turn = script.next_sent().await;
    assert_eq!(turn["method"], "turn/start");
    assert_eq!(turn["params"]["threadId"], TITLE_THREAD);
    turn
}

// Answers the title turn's start, then sends its one answer `title` and its completion.
fn complete_title_turn(script: &ScriptedService, turn: &Value, title: &str) {
    script.answer(turn, &turn_reply(TITLE_TURN));
    let answer = json!({"title": title}).to_string();
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TITLE_THREAD,
            "turnId": TITLE_TURN,
            "item": {"type": "agentMessage", "id": "item-1", "text": answer},
        },
    }));
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "turn/completed",
        "params": {
            "threadId": TITLE_THREAD,
            "turn": {"id": TITLE_TURN, "items": [], "status": "completed"},
        },
    }));
}

// Every config key Codex's own terminal sets on a throwaway structured conversation, with the two
// servers the config read named disabled.
fn locked_down_config() -> Value {
    json!({
        "features.apps": false,
        "features.code_mode": false,
        "features.code_mode_only": false,
        "features.context_management": false,
        "features.current_time_reminder": false,
        "features.deferred_executor": false,
        "features.enable_fanout": false,
        "features.goals": false,
        "features.hooks": false,
        "features.image_generation": false,
        "features.memories": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.plugins": false,
        "features.request_permissions_tool": false,
        "features.shell_snapshot": false,
        "features.shell_tool": false,
        "features.standalone_web_search": false,
        "features.token_budget": false,
        "features.tool_suggest": false,
        "features.unified_exec": false,
        "features.view_image": false,
        "cloud.skills.enabled": false,
        "skills.include_instructions": false,
        "tools.experimental_request_user_input.enabled": false,
        "tools.update_plan.enabled": false,
        "web_search": "disabled",
        "default_permissions": ":read-only",
        "mcp_servers": {"docs": {"enabled": false}, "team.search": {"enabled": false}},
    })
}

// Killed by dropping any one key of the title conversation's config or any one field of its
// start, by starting it before the config read, by dropping the answer's 8 KiB cap (the long
// answer would name the session), and by dropping the fallback to the session's model or the small
// model where the catalog offers it.
#[rstest]
#[case::a_short_answer_on_the_offered_title_model(
    "A short title".to_owned(),
    &["gpt-5", "gpt-5.6-luna"],
    "gpt-5.6-luna",
    Some("low"),
    Some("A short title")
)]
#[case::an_answer_past_the_cap_on_the_session_model(
    "x".repeat(9 * 1024),
    &["gpt-5"],
    SESSION_MODEL,
    None,
    None
)]
#[tokio::test(start_paused = true)]
async fn a_title_pass_reads_the_config_then_starts_locked_down_and_reads_a_capped_answer(
    #[case] title: String,
    #[case] catalog: &[&str],
    #[case] model: &str,
    #[case] effort: Option<&str>,
    #[case] named: Option<&str>,
) {
    let (pass, mut script, _scripted) = start_pass(CancellationToken::new());
    answer_config_read(&mut script).await;
    answer_model_list(&mut script, catalog).await;

    let started = answer_thread_start(&mut script, "readOnly").await;
    let params = &started["params"];
    assert_eq!(params["config"], locked_down_config());
    assert_eq!(params["model"], model);
    assert_eq!(params["cwd"], FOLDER);
    assert_eq!(params["ephemeral"], true);
    assert_eq!(params["sandbox"], "read-only");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["threadSource"], "thread_title");
    for empty in [
        "runtimeWorkspaceRoots",
        "environments",
        "dynamicTools",
        "selectedCapabilityRoots",
    ] {
        assert_eq!(params[empty], json!([]), "{empty} is sent empty");
    }
    let turn = next_turn_start(&mut script).await;
    assert_eq!(turn["params"].get("effort").and_then(Value::as_str), effort);
    complete_title_turn(&script, &turn, &title);

    let drawn = pass.await.expect("the pass's task ends");
    assert_eq!(drawn.expect("the pass ran").as_deref(), named);
}

// Killed by keeping the pass's connection once the pass ends: its ephemeral title conversation
// would stay loaded, never unloading on the service.
#[tokio::test(start_paused = true)]
async fn a_title_pass_lets_its_connection_go_when_it_ends() {
    let (pass, mut script, _scripted) = start_pass(CancellationToken::new());
    answer_config_read(&mut script).await;
    answer_model_list(&mut script, &[SESSION_MODEL]).await;
    answer_thread_start(&mut script, "readOnly").await;
    let turn = next_turn_start(&mut script).await;
    complete_title_turn(&script, &turn, "A title");
    let drawn = pass.await.expect("the pass's task ends");

    let closed = tokio::time::timeout(CODEX_NAMING_DEADLINE, script.sent.recv()).await;

    assert_eq!(drawn.expect("the pass ran").as_deref(), Some("A title"));
    assert_eq!(closed, Ok(None), "the connection outlived the pass");
}

/// How a title pass's start is refused before any turn runs.
enum Refusal {
    /// The config naming the MCP servers could not be read.
    UnreadConfig,
    /// The conversation started under another sandbox.
    WritableSandbox,
}

// Killed by reading past a failed `config/read`, and by dropping the check of the start's sandbox:
// either would start a turn on a conversation not known to be locked down.
#[rstest]
#[case::an_unread_config(Refusal::UnreadConfig)]
#[case::a_writable_sandbox(Refusal::WritableSandbox)]
#[tokio::test(start_paused = true)]
async fn a_title_pass_that_cannot_name_its_servers_or_runs_writable_starts_no_turn(
    #[case] refusal: Refusal,
) {
    let (pass, mut script, _scripted) = start_pass(CancellationToken::new());
    match refusal {
        Refusal::UnreadConfig => {
            let read = script.next_sent().await;
            assert_eq!(read["method"], "config/read");
            script.send(&json!({
                "jsonrpc": "2.0",
                "id": read["id"],
                "error": {"code": -32603, "message": "the config could not be loaded"},
            }));
        }
        Refusal::WritableSandbox => {
            answer_config_read(&mut script).await;
            answer_model_list(&mut script, &[SESSION_MODEL]).await;
            answer_thread_start(&mut script, "workspaceWrite").await;
        }
    }

    assert!(pass.await.expect("the pass's task ends").is_err());
    assert!(
        script.sent.try_recv().is_err(),
        "the pass sent nothing more"
    );
}

// Killed by dropping the interrupt, and by not waiting for the start's answer to name the turn:
// the pass would end with its turn still running. Its deadline stops the turn the same way, which
// the spent-deadline test proves.
#[tokio::test(start_paused = true)]
async fn a_title_pass_canceled_during_its_turns_start_interrupts_the_turn() {
    let cancel = CancellationToken::new();
    let (pass, mut script, _scripted) = start_pass(cancel.clone());
    answer_config_read(&mut script).await;
    answer_model_list(&mut script, &[SESSION_MODEL]).await;
    answer_thread_start(&mut script, "readOnly").await;
    let turn = next_turn_start(&mut script).await;
    cancel.cancel();
    // The pass takes the cancel while the start still waits for its answer.
    tokio::task::yield_now().await;
    script.answer(&turn, &turn_reply(TITLE_TURN));

    let interrupt = script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": TITLE_THREAD, "turnId": TITLE_TURN})
    );
    script.answer(&interrupt, &json!({}));
    let drawn = pass.await.expect("the pass's task ends");
    assert_eq!(drawn.expect("the pass ran"), None);
}
