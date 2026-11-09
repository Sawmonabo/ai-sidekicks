//! The entries a Codex conversation's `mcp_servers` table carries for the daemon's own tool
//! servers, each at its address on the daemon's route with the spawn's secret in its headers.

use std::error::Error;
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
use crate::driver::codex::mcp::config::server_entry::{
    DEFAULT_TOOLS_APPROVAL_MODE_MEMBER, HTTP_HEADERS_MEMBER, TOOL_TIMEOUT_SEC_MEMBER, URL_MEMBER,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::write::ENTRY_SWITCH_MEMBER;
use crate::port::tool_server_route::{
    OpenedToolServerRoute, ToolServerConversation, ToolServerRoute, ToolServerSpawn,
};
use crate::tool_server_name::DAEMON_TOOL_SERVER_NAME;

/// The names of the daemon's own entries in a Codex conversation's table, each one Codex runs
/// whatever the person switched on.
pub(crate) const CODEX_DAEMON_TOOL_SERVER_NAMES: &[&str] = &[DAEMON_TOOL_SERVER_NAME];

/// Seconds Codex waits on one call to the daemon's tool server: Codex's own default, above the
/// route's own bound, so the route answers first.
const CODEX_DAEMON_TOOL_TIMEOUT_SECONDS: u64 = 300;

/// One spawn's hold on the daemon's tool servers: its own callback-tool installation and the
/// entries opened on the route under secrets minted for it, admitted while this is kept.
pub(crate) struct CodexDaemonToolServers {
    /// The callback tools the session asked for, which every later spawn installs again.
    callback_tools: Vec<SessionCallbackTool>,
    /// The spawn's entries.
    route: OpenedToolServerRoute,
    /// The spawn's installation, whose dispatcher the entries answer calls through.
    binding: CallbackToolSpawnBinding,
}

impl CodexDaemonToolServers {
    /// Opens the daemon's entries for a new spawn of `session_id`'s conversation and installs
    /// `callback_tools` for it, replacing the earlier spawn's installation; the earlier spawn's
    /// entries stay admitted until its hold is let go. None until the route's owner registered
    /// it. Fails when the callback-tool host is not registered beside the route or a secret
    /// cannot be minted.
    pub(crate) fn open(
        route: &PortRegistration<Arc<dyn ToolServerRoute>>,
        host: &PortRegistration<Arc<CallbackToolHost>>,
        session_id: SessionId,
        callback_tools: Vec<SessionCallbackTool>,
    ) -> Result<Option<Self>, CodexError> {
        let Some(route) = route.port() else {
            return Ok(None);
        };
        let internal =
            |error: Box<dyn Error + Send + Sync>| CodexError::Driver(DriverError::Internal(error));
        let host = host
            .require_port()
            .map_err(|error| internal(Box::new(error)))?;
        let binding = bind_callback_tools_for_spawn(
            host,
            CallbackToolSpawnRequest {
                session_id,
                provider: DESCRIPTOR.provider_id(),
                requested_tools: callback_tools.clone(),
                provider_registration_unavailable: None,
            },
        );
        let opened = route.open(
            ToolServerSpawn {
                session_id,
                // A key of the spawn's own, so a spawn that never establishes leaves the one it
                // would have followed admitted.
                conversation: ToolServerConversation::mint(),
                provider: DESCRIPTOR.provider_id(),
                dispatcher: Arc::clone(binding.dispatcher()),
            },
            CODEX_DAEMON_TOOL_SERVER_NAMES,
        );
        match opened {
            Ok(route) => Ok(Some(Self {
                callback_tools,
                route,
                binding,
            })),
            Err(error) => {
                binding.rollback();
                Err(internal(Box::new(error)))
            }
        }
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
/// on at its address and sending its headers, replacing any entry of the same name.
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
        servers.insert(
            entry.server_name.clone(),
            json!({
                URL_MEMBER: entry.url,
                HTTP_HEADERS_MEMBER: http_headers,
                ENTRY_SWITCH_MEMBER: true,
                // The daemon judges each of its own calls itself, so Codex asks nothing first.
                DEFAULT_TOOLS_APPROVAL_MODE_MEMBER: "approve",
                TOOL_TIMEOUT_SEC_MEMBER: CODEX_DAEMON_TOOL_TIMEOUT_SECONDS,
            }),
        );
    }
}
