//! The entries a Codex conversation's `mcp_servers` table carries for the daemon's own tool
//! servers, each at its address on the daemon's route with the spawn's secret in its headers: the
//! up-front tools' entry, the deferred tools' entry, and the hooks entry whose tools only the
//! conversation's hook rows call.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::callback_tools::host::{CallbackToolHost, CallbackToolSpawnRequest};
use crate::callback_tools::spawn_binding::{
    CallbackToolSpawnBinding, bind_callback_tools_for_spawn,
};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::hooks::tools::CodexHookTools;
use crate::driver::codex::mcp::config::server_entry::{
    DEFAULT_TOOLS_APPROVAL_MODE_MEMBER, HTTP_HEADERS_MEMBER, OMIT_TOOLS_FROM_MEMBER,
    REQUIRED_MEMBER, TOOL_INPUT_SCHEMA_MAX_BYTES_MEMBER, TOOL_TIMEOUT_SEC_MEMBER, URL_MEMBER,
};
use crate::driver::codex::service::command_line::CODEX_HOOK_TIMEOUT;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::write::ENTRY_SWITCH_MEMBER;
use crate::port::hook_tool_server::HookToolServer;
use crate::port::tool_server_route::{
    OpenedToolServerRoute, ToolServerConversation, ToolServerRoute, ToolServerSpawn,
};
use crate::tool_server_name::{DAEMON_HOOKS_TOOL_SERVER_NAME, DAEMON_TOOL_SERVER_NAME};

/// The name of the daemon's entry for the tools Codex keeps behind its tool search, the workflow
/// and browser tools, since Codex defers only a whole entry.
pub(crate) const CODEX_DEFERRED_TOOL_SERVER_NAME: &str = "sidekicks_workflow_browser";

/// The names of the daemon's own entries in a Codex conversation's table, each one Codex runs
/// whatever the person switched on.
pub(crate) const CODEX_DAEMON_TOOL_SERVER_NAMES: &[&str] = &[
    DAEMON_TOOL_SERVER_NAME,
    CODEX_DEFERRED_TOOL_SERVER_NAME,
    DAEMON_HOOKS_TOOL_SERVER_NAME,
];

/// The daemon's entries a spawn opens: the one its tools load from at once and the hooks entry,
/// but no deferred one, because the daemon's server lists no deferred group, so a deferred entry
/// would reach Codex empty.
pub(crate) const CODEX_OPENED_TOOL_SERVER_NAMES: &[&str] =
    &[DAEMON_TOOL_SERVER_NAME, DAEMON_HOOKS_TOOL_SERVER_NAME];

/// Seconds Codex waits on one call to the daemon's tool server: Codex's own default, above the
/// 120 s a session ask is held and the route's own bound, so the route answers first.
const CODEX_DAEMON_TOOL_TIMEOUT_SECONDS: u64 = 300;

/// The surface the up-front entry's tools are kept off, so they load at once and never wait
/// behind Codex's tool search.
const DEFERRED_SURFACE: &str = "deferred";

/// Every surface the model reads tools from, all of which the hooks entry's tools are kept off.
const MODEL_SURFACES: [&str; 3] = ["direct", DEFERRED_SURFACE, "code_mode"];

/// One spawn's hold on the daemon's tool servers: its own callback-tool installation and the
/// entries opened on the route under the secrets derived for their addresses, admitted while
/// this is kept.
pub(crate) struct CodexDaemonToolServers {
    /// The callback tools the session asked for, which every later spawn installs again.
    callback_tools: Vec<SessionCallbackTool>,
    /// The spawn's entries.
    route: OpenedToolServerRoute,
    /// The spawn's installation, whose dispatcher the entries answer calls through.
    binding: CallbackToolSpawnBinding,
}

impl CodexDaemonToolServers {
    /// Opens the daemon's entries for a new spawn of `session_id`'s conversation on `service`, its
    /// hook rows' calls answered by `hook_tools`, and installs `callback_tools` for it, replacing
    /// the earlier spawn's installation; the earlier spawn's entries stay admitted until its hold
    /// is let go. None until the route's owner registered it. Fails when the callback-tool host is
    /// not registered beside the route.
    pub(crate) fn open(
        route: &PortRegistration<Arc<dyn ToolServerRoute>>,
        host: &PortRegistration<Arc<CallbackToolHost>>,
        hook_tools: &Arc<CodexHookTools>,
        service: &Arc<CodexService>,
        session_id: SessionId,
        callback_tools: Vec<SessionCallbackTool>,
    ) -> Result<Option<Self>, CodexError> {
        Self::open_on(
            route,
            host,
            hook_tools.for_session(session_id, service),
            session_id,
            callback_tools,
            |route, spawn| route.open(spawn, CODEX_OPENED_TOOL_SERVER_NAMES),
        )
    }

    /// Opens the daemon's entries as [`Self::open`] does for a conversation Codex still holds
    /// loaded from an earlier start of the daemon, which keeps the address and secret that start
    /// gave it: while this is kept, its calls there are answered by this spawn.
    pub(crate) fn adopt(
        route: &PortRegistration<Arc<dyn ToolServerRoute>>,
        host: &PortRegistration<Arc<CallbackToolHost>>,
        hook_tools: &Arc<CodexHookTools>,
        service: &Arc<CodexService>,
        session_id: SessionId,
        callback_tools: Vec<SessionCallbackTool>,
    ) -> Result<Option<Self>, CodexError> {
        Self::open_on(
            route,
            host,
            hook_tools.for_session(session_id, service),
            session_id,
            callback_tools,
            |route, spawn| route.adopt(spawn, CODEX_OPENED_TOOL_SERVER_NAMES),
        )
    }

    // Installs `callback_tools` for a new spawn and opens its entries on the route through
    // `open_entries`, its hook rows answered by `hook_tools`.
    fn open_on(
        route: &PortRegistration<Arc<dyn ToolServerRoute>>,
        host: &PortRegistration<Arc<CallbackToolHost>>,
        hook_tools: Arc<dyn HookToolServer>,
        session_id: SessionId,
        callback_tools: Vec<SessionCallbackTool>,
        open_entries: impl FnOnce(&dyn ToolServerRoute, ToolServerSpawn) -> OpenedToolServerRoute,
    ) -> Result<Option<Self>, CodexError> {
        let Some(route) = route.port() else {
            return Ok(None);
        };
        let host = host
            .require_port()
            .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))?;
        let binding = bind_callback_tools_for_spawn(
            host,
            CallbackToolSpawnRequest {
                session_id,
                provider: DESCRIPTOR.provider_id(),
                requested_tools: callback_tools.clone(),
                provider_registration_unavailable: None,
            },
        );
        let route = open_entries(
            route.as_ref(),
            ToolServerSpawn {
                session_id,
                // A key of the spawn's own, so a spawn that never establishes leaves the one it
                // would have followed admitted.
                conversation: ToolServerConversation::mint(),
                provider: DESCRIPTOR.provider_id(),
                dispatcher: Arc::clone(binding.dispatcher()),
                hook_tools: Some(hook_tools),
            },
        );
        Ok(Some(Self {
            callback_tools,
            route,
            binding,
        }))
    }

    /// The callback tools the session asked for.
    pub(crate) fn callback_tools(&self) -> &[SessionCallbackTool] {
        &self.callback_tools
    }

    /// The spawn's entries.
    pub(crate) fn route(&self) -> &OpenedToolServerRoute {
        &self.route
    }

    /// Lets go of a spawn that never established: its entries leave and the installation it
    /// replaced answers again.
    pub(crate) fn rollback(self) {
        self.binding.rollback();
    }
}

/// Inserts into `servers` each of the daemon's own entries `route` opened for the spawn, switched
/// on at its address and sending its headers, replacing any entry of the same name; the up-front
/// entry's tools are kept off the deferred surface, and the hooks entry's off every surface the
/// model reads, which the conversation does not start without and whose calls wait as long as a
/// hook row does.
pub(crate) fn insert_codex_daemon_tool_servers(
    servers: &mut Map<String, Value>,
    route: &OpenedToolServerRoute,
) {
    for entry in CODEX_DAEMON_TOOL_SERVER_NAMES
        .iter()
        .filter_map(|server_name| route.entry(server_name))
    {
        let http_headers: Map<String, Value> = entry
            .http_headers
            .iter()
            .map(|(name, value)| (name.clone(), Value::String(value.clone())))
            .collect();
        let mut members = json!({
            URL_MEMBER: entry.url,
            HTTP_HEADERS_MEMBER: http_headers,
            ENTRY_SWITCH_MEMBER: true,
            // The daemon judges each of its own calls itself, so Codex asks nothing first.
            DEFAULT_TOOLS_APPROVAL_MODE_MEMBER: "approve",
            TOOL_TIMEOUT_SEC_MEMBER: CODEX_DAEMON_TOOL_TIMEOUT_SECONDS,
            // Codex compacts a schema past this, its field descriptions first, so the route's
            // largest keeps every one whole for the model.
            TOOL_INPUT_SCHEMA_MAX_BYTES_MEMBER: entry.tool_input_schema_max_bytes,
        });
        if entry.server_name == DAEMON_TOOL_SERVER_NAME {
            members[OMIT_TOOLS_FROM_MEMBER] = json!([DEFERRED_SURFACE]);
        }
        if entry.server_name == DAEMON_HOOKS_TOOL_SERVER_NAME {
            // A hook that cannot reach the daemon lets its call through, so none starts without.
            members[REQUIRED_MEMBER] = json!(true);
            members[OMIT_TOOLS_FROM_MEMBER] = json!(MODEL_SURFACES);
            members[TOOL_TIMEOUT_SEC_MEMBER] = json!(CODEX_HOOK_TIMEOUT.as_secs());
        }
        servers.insert(entry.server_name.clone(), members);
    }
}
