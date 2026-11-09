//! The server driven over an in-memory MCP connection: each request carries the HTTP parts its
//! route would, so the server reads its spawn's entry as it does on the listener.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use http::header::AUTHORIZATION;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, InitializeRequestParams,
    InitializeResult, JsonObject, ListToolsResult, PaginatedRequestParams,
};
use rmcp::service::{RequestContext, RunningService};
use rmcp::{ErrorData as McpError, RoleClient, RoleServer, ServerHandler, ServiceExt as _};
use serde_json::Value;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_provider::callback_tools::host::{
    CallbackToolActivityRecord, CallbackToolActivitySink, CallbackToolApprovalBasis,
    CallbackToolApprovalOutcome, CallbackToolApprovalSeam, CallbackToolExecutor, CallbackToolHost,
    CallbackToolPortError, CallbackToolSpawnRequest,
};
use sidekicks_provider::callback_tools::spawn_binding::{
    CallbackToolSpawnBinding, bind_callback_tools_for_spawn,
};
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::agent_tools::AgentToolCaller;
use sidekicks_provider::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::test_registry::{new_run_id, registry_of_first_providers};
use sidekicks_provider::port::tool_server_route::ToolServerConversation;
use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
use tokio::sync::Notify;

use super::{AgentToolServer, ToolServerPath};
use crate::tools::entries::{ToolServerEntries, ToolServerEntryGuard};
use crate::tools::session::rules::SHARED_RULES;
use crate::tools::session::{TOOLS, list, read, remind, wait};

pub(in crate::tools) const CLAUDE_SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const CODEX_SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abce";

/// The approval seam, executor and activity sink at once: the seam allows every call, and the
/// executor counts the calls it runs and holds `session_wait` open until it is dropped.
#[derive(Default)]
pub(in crate::tools) struct Ports {
    pub(in crate::tools) executed: AtomicUsize,
    wait_started: Notify,
    is_wait_dropped: Arc<AtomicBool>,
}

impl CallbackToolApprovalSeam for Ports {
    fn evaluate<'a>(
        &'a self,
        _invocation: &'a CallbackToolInvocation,
        _provider: &'a ProviderId,
    ) -> BoxFuture<'a, Result<CallbackToolApprovalOutcome, CallbackToolPortError>> {
        let basis = CallbackToolApprovalBasis::Policy;
        async move { Ok(CallbackToolApprovalOutcome::Allow { basis }) }.boxed()
    }
}

/// Sets its flag when the held call's work is dropped.
struct DropMark(Arc<AtomicBool>);

impl Drop for DropMark {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl CallbackToolExecutor for Ports {
    fn execute(
        &self,
        invocation: CallbackToolInvocation,
    ) -> BoxFuture<'_, Result<CallbackToolResult, CallbackToolPortError>> {
        self.executed.fetch_add(1, Ordering::SeqCst);
        if invocation.tool_name.as_str() == wait::DESCRIPTION.name {
            let mark = DropMark(Arc::clone(&self.is_wait_dropped));
            self.wait_started.notify_one();
            return async move {
                let _held = mark;
                std::future::pending().await
            }
            .boxed();
        }
        async {
            Ok(CallbackToolResult::Completed {
                output: Some(Value::from("two sessions")),
                session_links: Vec::new(),
            })
        }
        .boxed()
    }
}

impl CallbackToolActivitySink for Ports {
    fn record<'a>(
        &'a self,
        _record: &'a CallbackToolActivityRecord,
    ) -> BoxFuture<'a, Result<(), CallbackToolPortError>> {
        async { Ok(()) }.boxed()
    }
}

/// The server's handler with the HTTP parts of one route put on every request it serves.
struct Routed {
    server: AgentToolServer,
    path: String,
    secret: String,
}

impl Routed {
    fn route(&self, context: &mut RequestContext<RoleServer>) {
        let (parts, ()) = http::Request::builder()
            .uri(&self.path)
            .header(AUTHORIZATION, format!("Bearer {}", self.secret))
            .body(())
            .expect("the request builds")
            .into_parts();
        context.extensions.insert(parts);
    }
}

impl ServerHandler for Routed {
    fn get_info(&self) -> InitializeResult {
        self.server.get_info()
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        mut context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        self.route(&mut context);
        self.server.initialize(request, context).await
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        mut context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        self.route(&mut context);
        self.server.list_tools(request, context).await
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        mut context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        self.route(&mut context);
        self.server.call_tool(request, context).await
    }
}

/// The route of `session`'s own conversation on the daemon's server.
fn session_path(session: &str) -> ToolServerPath {
    let session_id = SessionId::new(session).expect("the text is a UUID");
    ToolServerPath {
        session_id,
        conversation: ToolServerConversation::of_session(session_id),
        server_name: DAEMON_TOOL_SERVER_NAME.to_owned(),
    }
}

/// The host, the entry table and the two providers' drivers every connection shares, and the
/// spawns of one Claude Code session and one Codex session, each a callback-tool binding, its
/// entry's guard and its secret.
pub(in crate::tools) struct Fixture {
    pub(in crate::tools) ports: Arc<Ports>,
    pub(in crate::tools) entries: Arc<ToolServerEntries>,
    pub(in crate::tools) server: Arc<dyn Fn() -> AgentToolServer>,
    pub(in crate::tools) spawns: Vec<(
        CallbackToolSpawnBinding,
        Option<ToolServerEntryGuard>,
        String,
    )>,
}

/// A driver whose every call maps to `run_id`.
fn driver_answering(run_id: RunId) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    driver.expect_calling_run().returning(move |_, _| {
        async move {
            Some(AgentToolCaller {
                run_id,
                tool_call_id: None,
            })
        }
        .boxed()
    });
    driver
}

pub(in crate::tools) fn fixture() -> Fixture {
    let ports = Arc::new(Ports::default());
    let host = Arc::new(CallbackToolHost::new(
        Arc::clone(&ports) as _,
        Arc::clone(&ports) as _,
        Some(Arc::clone(&ports) as _),
    ));
    let providers = Arc::new(registry_of_first_providers(vec![
        Arc::new(driver_answering(new_run_id())),
        Arc::new(driver_answering(new_run_id())),
    ]));
    let entries = Arc::new(ToolServerEntries::default());
    let spawns = [CLAUDE_SESSION, CODEX_SESSION]
        .into_iter()
        .zip(PROVIDERS)
        .map(|(session, descriptor)| {
            let session_id = SessionId::new(session).expect("the text is a UUID");
            let provider = ProviderId::new(descriptor.id.to_owned()).expect("a table id");
            let binding = bind_callback_tools_for_spawn(
                &host,
                CallbackToolSpawnRequest {
                    session_id,
                    provider: provider.clone(),
                    requested_tools: TOOLS
                        .iter()
                        .map(|tool| SessionCallbackTool {
                            name: tool.description.name.to_owned(),
                            description: tool.description.text(),
                            input_schema: JsonObject::new(),
                        })
                        .collect(),
                    provider_registration_unavailable: None,
                },
            );
            let token = BearerToken::mint().expect("the system's random source reads");
            let secret = token.text().to_owned();
            let guard = entries.insert(
                session_path(session),
                provider,
                token,
                Arc::clone(binding.dispatcher()),
                None,
            );
            (binding, Some(guard), secret)
        })
        .collect();
    let server_entries = Arc::clone(&entries);
    Fixture {
        ports,
        entries,
        server: Arc::new(move || {
            AgentToolServer::new(
                Arc::clone(&server_entries),
                Arc::clone(&providers),
                Arc::clone(&host),
            )
        }),
        spawns,
    }
}

/// A client connected to the server on `session`'s route, spawn `spawn` of the fixture.
async fn connect(fixture: &Fixture, spawn: usize, session: &str) -> RunningService<RoleClient, ()> {
    let routed = Routed {
        server: (fixture.server)(),
        path: session_path(session).to_string(),
        secret: fixture.spawns[spawn].2.clone(),
    };
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let running = routed.serve(server_io).await.expect("the server starts");
        running.waiting().await.expect("the server ends cleanly");
    });
    ().serve(client_io).await.expect("the client connects")
}

fn text_of(result: &CallToolResult) -> &str {
    result
        .content
        .first()
        .and_then(|block| block.as_text())
        .map_or("", |text| text.text.as_str())
}

// Each provider gets the listing its descriptor asks for, the rules where it takes them on
// connection, and a call that reaches the daemon's handler. Killed by listing `session_remind`
// for Claude Code, whose own wake-up tool stands in for it, or by an up-front tool without the
// mark Claude Code loads it by.
#[tokio::test]
async fn each_provider_lists_its_tools_as_it_loads_them_and_a_call_reaches_the_handler() {
    let fixture = fixture();
    let claude = connect(&fixture, 0, CLAUDE_SESSION).await;
    let codex = connect(&fixture, 1, CODEX_SESSION).await;

    let claude_tools = claude
        .list_all_tools()
        .await
        .expect("Claude Code's listing");
    assert_eq!(claude_tools.len(), 11);
    assert!(
        claude_tools
            .iter()
            .all(|tool| tool.name != remind::DESCRIPTION.name)
    );
    for tool in &claude_tools {
        let meta = tool
            .meta
            .as_ref()
            .expect("an up-front tool carries its mark");
        assert_eq!(meta.get("anthropic/alwaysLoad"), Some(&Value::Bool(true)));
    }
    let codex_tools = codex.list_all_tools().await.expect("Codex's listing");
    assert_eq!(codex_tools.len(), 12);
    assert!(
        codex_tools
            .iter()
            .any(|tool| tool.name == remind::DESCRIPTION.name)
    );
    assert!(codex_tools.iter().all(|tool| tool.meta.is_none()));
    let claude_info = claude.peer_info().expect("Claude Code was answered");
    assert_eq!(claude_info.instructions.as_deref(), Some(SHARED_RULES));
    let codex_info = codex.peer_info().expect("Codex was answered");
    assert_eq!(codex_info.instructions, None);

    let listed = claude
        .call_tool(CallToolRequestParams::new(list::DESCRIPTION.name))
        .await
        .expect("the call is answered");
    assert_eq!(listed.is_error, Some(false));
    assert_eq!(text_of(&listed), "two sessions");
    assert_eq!(fixture.ports.executed.load(Ordering::SeqCst), 1);
}

// A call whose arguments the received check refuses is answered with the check's words naming
// the field, and no handler runs. Killed by dispatching the call before the check.
#[tokio::test]
async fn a_call_the_received_check_refuses_names_the_field_and_runs_no_handler() {
    let fixture = fixture();
    let codex = connect(&fixture, 1, CODEX_SESSION).await;
    let arguments = JsonObject::from_iter([
        ("session".to_owned(), Value::from("builder")),
        ("session_id".to_owned(), Value::from("s-8f21")),
    ]);

    let refused = codex
        .call_tool(CallToolRequestParams::new(read::DESCRIPTION.name).with_arguments(arguments))
        .await
        .expect("the call is answered");

    assert_eq!(refused.is_error, Some(true));
    assert!(
        text_of(&refused).contains("session_id"),
        "{}",
        text_of(&refused)
    );
    assert_eq!(fixture.ports.executed.load(Ordering::SeqCst), 0);
}

// A held call whose provider process went away, its spawn's entry dropped with the stream still
// open, is canceled and its handler's work dropped. Killed by canceling on `notifications/cancelled`
// alone.
#[tokio::test]
async fn a_held_call_is_canceled_and_its_work_dropped_when_its_process_is_gone() {
    let mut fixture = fixture();
    let codex = connect(&fixture, 1, CODEX_SESSION).await;
    let call = codex.call_tool(CallToolRequestParams::new(wait::DESCRIPTION.name));
    tokio::pin!(call);

    tokio::select! {
        () = fixture.ports.wait_started.notified() => {}
        answered = &mut call => panic!("the held call answered: {answered:?}"),
    }
    assert!(!fixture.ports.is_wait_dropped.load(Ordering::SeqCst));
    drop(fixture.spawns[1].1.take());

    assert!(
        call.await.is_err(),
        "the canceled call is answered with an error"
    );
    assert!(fixture.ports.is_wait_dropped.load(Ordering::SeqCst));
    assert!(
        fixture
            .entries
            .admitted(
                &session_path(CODEX_SESSION),
                Some(format!("Bearer {}", fixture.spawns[1].2).as_bytes()),
            )
            .is_none()
    );
}
