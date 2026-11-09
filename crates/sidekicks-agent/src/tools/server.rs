//! The daemon's MCP server for its own agent tools, on rmcp. Every request reads its route afresh
//! from the HTTP request it came on: the session and tool server its path names, and the spawn
//! entry its secret admits, so a replaced spawn is never answered from a connection's memory. A
//! listing shows each tool the way the spawn's provider loads it; a call is mapped to the run that
//! made it, checked against its tool's schema before any handler runs, held with progress, and
//! canceled when its caller goes away.

use std::error::Error;
use std::fmt;
use std::future::ready;
use std::sync::Arc;
use std::time::Duration;

use http::header::AUTHORIZATION;
use http::request::Parts;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, DiscoverResult,
    Extensions, Implementation, InitializeRequestParams, InitializeResult, JsonObject,
    ListToolsResult, MetaObject, PaginatedRequestParams, ProgressNotificationParam,
    ServerCapabilities, Tool,
};
use rmcp::service::{MaybeSendFuture, RequestContext};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::Value;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::callback_tools::host::CallbackToolHost;
use sidekicks_provider::driver::ProviderDescriptor;
use sidekicks_provider::driver::agent_tools::{AgentToolInstructions, AgentToolLoading};
use sidekicks_provider::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
use tokio::time::{Instant, interval_at};

use crate::tools::entries::{ToolServerEntries, ToolServerEntry};
use crate::tools::group::{AgentTool, AgentToolGroup, ToolGroupLoading};
use crate::tools::session::rules::SHARED_RULES;

#[cfg(test)]
mod tests;

/// How often a held call tells its caller it is still running, inside both providers' idle limits.
const PROGRESS_PERIOD: Duration = Duration::from_secs(45);

/// The first segment of every tool server's path on the daemon's listener.
const TOOL_SERVER_PATH_ROOT: &str = "tools";

/// What a call is answered when its `_meta` names no run of its session.
const NO_CALLING_RUN: &str =
    "The daemon could not tell which run made this call, so the call was not run.";

/// What a denied or failed call is answered when the host gave no words of its own.
const NO_WORDS: &str = "The call was not run.";

/// Where a request reached the daemon's tool servers: the session and the tool server its path
/// names, `/tools/<session id>/<server name>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolServerPath {
    /// The session.
    pub session_id: SessionId,
    /// The tool server's name on the session's route.
    pub server_name: String,
}

impl ToolServerPath {
    /// Reads a request's path; `None` for a path naming no session and tool server.
    pub fn parse(path: &str) -> Option<Self> {
        let mut segments = path.strip_prefix('/')?.split('/');
        let (Some(TOOL_SERVER_PATH_ROOT), Some(session), Some(server_name), None) = (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ) else {
            return None;
        };
        Some(Self {
            session_id: SessionId::new(session).ok()?,
            server_name: (!server_name.is_empty()).then(|| server_name.to_owned())?,
        })
    }
}

impl fmt::Display for ToolServerPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "/{TOOL_SERVER_PATH_ROOT}/{}/{}",
            self.session_id, self.server_name
        )
    }
}

/// The daemon's server for its own agent tools, one for every session and provider: it reads each
/// request's spawn entry, asks the spawn's driver which run made a call, and dispatches the call
/// through the entry's dispatcher, so the host's approval seam and activity records run on it.
pub struct AgentToolServer {
    /// Every live spawn's entry.
    entries: Arc<ToolServerEntries>,
    /// Each provider's driver and fixed facts.
    providers: Arc<ProviderRegistry>,
    /// Records a call whose arguments the received check refused.
    host: Arc<CallbackToolHost>,
}

// A request's route: where it came, and the spawn entry its secret admits there.
struct AdmittedRoute {
    path: ToolServerPath,
    entry: Arc<ToolServerEntry>,
    descriptor: &'static ProviderDescriptor,
}

impl AgentToolServer {
    /// A server over `entries`, reading each spawn's provider from `providers` and recording
    /// refused arguments through `host`.
    pub fn new(
        entries: Arc<ToolServerEntries>,
        providers: Arc<ProviderRegistry>,
        host: Arc<CallbackToolHost>,
    ) -> Self {
        Self {
            entries,
            providers,
            host,
        }
    }

    // The route of the request whose `extensions` hold its HTTP parts. Fails for a request with no
    // parts, a path naming no tool server, a secret no live entry admits, or a provider no driver
    // answers.
    fn admitted(&self, extensions: &Extensions) -> Result<AdmittedRoute, McpError> {
        let parts = extensions
            .get::<Parts>()
            .ok_or_else(|| McpError::invalid_request("the request came on no tool route", None))?;
        let path = ToolServerPath::parse(parts.uri.path()).ok_or_else(|| {
            McpError::invalid_request("the request's path names no tool server", None)
        })?;
        let authorization = parts
            .headers
            .get(AUTHORIZATION)
            .map(http::HeaderValue::as_bytes);
        let entry = self
            .entries
            .admitted(path.session_id, &path.server_name, authorization)
            .ok_or_else(|| {
                McpError::invalid_request("the request's secret admits no live spawn", None)
            })?;
        let descriptor = self
            .providers
            .descriptor(entry.provider())
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        Ok(AdmittedRoute {
            path,
            entry,
            descriptor,
        })
    }

    // What the server answers on connection for `route`, the shared rules among it for a provider
    // that takes them there.
    fn info_for(&self, route: &AdmittedRoute) -> InitializeResult {
        let info = self.get_info();
        match route.descriptor.agent_tool_instructions {
            AgentToolInstructions::OnConnection => info.with_instructions(SHARED_RULES),
            AgentToolInstructions::OnConversation => info,
        }
    }

    // The handshake's answer: the negotiated version and what the route's provider takes on
    // connection.
    fn answer_initialize(
        &self,
        request: &InitializeRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        let route = self.admitted(&context.extensions)?;
        context.peer.set_peer_info(request.clone());
        let negotiated = self.negotiate_initialize(request)?;
        Ok(self
            .info_for(&route)
            .with_protocol_version(negotiated.protocol_version))
    }

    // What a client that opens without a handshake reads of the server.
    fn answer_discover(
        &self,
        context: &RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, McpError> {
        let route = self.admitted(&context.extensions)?;
        Ok(DiscoverResult::from_server_info(
            self.supported_protocol_versions().into_owned(),
            self.info_for(&route),
        ))
    }

    // The route's tools as its provider loads them, each up-front tool marked where the provider
    // reads a mark.
    fn answer_list_tools(
        &self,
        context: &RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let route = self.admitted(&context.extensions)?;
        let mark = match route.descriptor.agent_tool_loading {
            AgentToolLoading::MarkedOnListing { meta_key } => Some(meta_key),
            AgentToolLoading::EntryPerLoading => None,
        };
        let mut tools = Vec::new();
        for group in listed_groups(route.descriptor, &route.path.server_name) {
            for tool in &group.tools {
                let listed = list_tool(tool)?;
                tools.push(match mark {
                    Some(meta_key) if group.loading == ToolGroupLoading::UpFront => listed
                        .with_meta(MetaObject(JsonObject::from_iter([(
                            meta_key.to_owned(),
                            Value::Bool(true),
                        )]))),
                    Some(_) | None => listed,
                });
            }
        }
        Ok(ListToolsResult::with_all_items(tools))
    }

    // Answers one call on `route`: its run, its arguments' check, then the entry's dispatcher.
    async fn answer_call(
        &self,
        route: &AdmittedRoute,
        tool: AgentTool,
        request: CallToolRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let session_id = route.path.session_id;
        let driver = self
            .providers
            .lookup(route.entry.provider())
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let Some(caller) = driver
            .calling_run(session_id, context.meta.0.0.clone())
            .await
        else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                NO_CALLING_RUN,
            )]));
        };
        let tool_call_id = match caller.tool_call_id {
            Some(tool_call_id) => tool_call_id,
            None => ToolCallId::new(context.id.to_string()).map_err(|error| {
                McpError::invalid_params(
                    format!("the call's request id is no call id: {error}"),
                    None,
                )
            })?,
        };
        let tool_name = FreeFormText::new(tool.description.name.to_owned())
            .expect("a tool's declared name is a provider tool name");
        let arguments = request.arguments.unwrap_or_default();
        let fault = (tool.received_fault)(&Value::Object(arguments.clone())).map_err(|error| {
            McpError::internal_error(format!("the tool's check does not build: {error}"), None)
        })?;
        let result = match fault {
            Some(fault) => {
                self.host
                    .refuse_invalid_arguments(
                        session_id,
                        caller.run_id,
                        tool_name,
                        tool_call_id,
                        &fault,
                    )
                    .await
            }
            None => {
                (route.entry.dispatcher())(CallbackToolInvocation {
                    tool_name,
                    arguments,
                    tool_call_id,
                    session_id,
                    run_id: caller.run_id,
                })
                .await
            }
        };
        Ok(compose_call_result(result))
    }
}

impl ServerHandler for AgentToolServer {
    fn get_info(&self) -> InitializeResult {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                DAEMON_TOOL_SERVER_NAME,
                env!("CARGO_PKG_VERSION"),
            ))
    }

    fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<InitializeResult, McpError>> + MaybeSendFuture + '_ {
        ready(self.answer_initialize(&request, &context))
    }

    fn discover(
        &self,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<DiscoverResult, McpError>> + MaybeSendFuture + '_ {
        ready(self.answer_discover(&context))
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + MaybeSendFuture + '_ {
        ready(self.answer_list_tools(&context))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let route = self.admitted(&context.extensions)?;
        let groups = listed_groups(route.descriptor, &route.path.server_name);
        let Some((group, tool)) = groups.iter().find_map(|group| {
            let tool = group
                .tools
                .iter()
                .find(|tool| tool.description.name == request.name)?;
            Some((group, *tool))
        }) else {
            return Err(McpError::invalid_params(
                format!("the session offers no tool named {}", request.name),
                None,
            ));
        };
        let is_cancelable = group.can_cancel(tool.description.name);
        let answer = self.answer_call(&route, tool, request, &context);
        tokio::pin!(answer);
        let progress_token = context.meta.get_progress_token();
        let mut progress = interval_at(Instant::now() + PROGRESS_PERIOD, PROGRESS_PERIOD);
        let mut beats = 0_u32;
        loop {
            tokio::select! {
                biased;
                // Either ending drops the answer's future, and with it the handler's work.
                () = context.ct.cancelled(), if is_cancelable => {
                    return Err(McpError::internal_error("the caller canceled the call", None));
                }
                () = route.entry.ended(), if is_cancelable => {
                    return Err(McpError::internal_error("the caller's process is gone", None));
                }
                answer = &mut answer => return answer.map(CallToolResponse::from),
                _ = progress.tick(), if progress_token.is_some() => {
                    beats += 1;
                    let token = progress_token.clone().expect("the arm runs only with a token");
                    let beat = ProgressNotificationParam::new(token, f64::from(beats));
                    // A beat that cannot be sent means the stream is gone, which cancels the call.
                    if let Err(error) = context.peer.notify_progress(beat).await {
                        tracing::debug!(
                            error = &error as &(dyn Error + 'static),
                            "a held call's progress did not reach its caller"
                        );
                    }
                }
            }
        }
    }
}

// The groups the session's spawn lists on the tool server `server_name`: every group for a
// provider that marks what it loads up front, and only the up-front groups on the daemon's own
// entry, the deferred ones on any other, for a provider that defers whole entries.
fn listed_groups(descriptor: &ProviderDescriptor, server_name: &str) -> Vec<AgentToolGroup> {
    let groups = [AgentToolGroup::session(descriptor.own_wake_up_tool)];
    match descriptor.agent_tool_loading {
        AgentToolLoading::MarkedOnListing { .. } => groups.into(),
        AgentToolLoading::EntryPerLoading => {
            let loading = if server_name == DAEMON_TOOL_SERVER_NAME {
                ToolGroupLoading::UpFront
            } else {
                ToolGroupLoading::Deferred
            };
            groups
                .into_iter()
                .filter(|group| group.loading == loading)
                .collect()
        }
    }
}

// `tool` as a listing shows it, from its declared description and its arguments' schema.
fn list_tool(tool: &AgentTool) -> Result<Tool, McpError> {
    let schema = (tool.listed_schema)().map_err(|error| {
        McpError::internal_error(format!("a tool's schema does not write: {error}"), None)
    })?;
    let Value::Object(schema) = schema else {
        return Err(McpError::internal_error(
            "a tool's schema is not an object",
            None,
        ));
    };
    Ok(Tool::new(
        tool.description.name,
        tool.description.text(),
        Arc::new(schema),
    ))
}

// The host's answer as the provider reads it: a completed call's output as text, and a denied or
// failed one as an error result carrying its words, which the model reads.
fn compose_call_result(result: CallbackToolResult) -> CallToolResult {
    match result {
        CallbackToolResult::Completed { output, .. } => {
            CallToolResult::success(output.map_or_else(Vec::new, |output| {
                let text = output
                    .as_str()
                    .map_or_else(|| output.to_string(), str::to_owned);
                vec![ContentBlock::text(text)]
            }))
        }
        CallbackToolResult::Denied { error } | CallbackToolResult::Failed { error } => {
            CallToolResult::error(vec![ContentBlock::text(
                error.unwrap_or_else(|| NO_WORDS.to_owned()),
            )])
        }
    }
}
