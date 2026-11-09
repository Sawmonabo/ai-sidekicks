//! The entries a Codex conversation's `mcp_servers` table carries for the daemon's own tool
//! servers, each on the daemon's route.

use serde_json::{Map, Value, json};
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::mcp::config::server_entry::{
    DEFAULT_TOOLS_APPROVAL_MODE_MEMBER, TOOL_TIMEOUT_SEC_MEMBER, URL_MEMBER,
};
use crate::driver::mcp_server::write::ENTRY_SWITCH_MEMBER;
use crate::port::tool_server_route::ToolServerRoute;
use crate::tool_server_name::DAEMON_TOOL_SERVER_NAME;

/// The names of the daemon's own entries in a Codex conversation's table, each one Codex runs
/// whatever the person switched on.
pub(crate) const CODEX_DAEMON_TOOL_SERVER_NAMES: &[&str] = &[DAEMON_TOOL_SERVER_NAME];

/// Seconds Codex waits on one call to the daemon's tool server: Codex's own default, above the
/// route's own bound, so the route answers first.
const CODEX_DAEMON_TOOL_TIMEOUT_SECONDS: u64 = 300;

/// Inserts into `servers` the daemon's own entries for `session_id`, each switched on at its
/// address on `route`, replacing any entry of the same name.
pub(crate) fn insert_codex_daemon_tool_servers(
    servers: &mut Map<String, Value>,
    route: &dyn ToolServerRoute,
    session_id: &SessionId,
) {
    servers.insert(
        DAEMON_TOOL_SERVER_NAME.to_owned(),
        json!({
            URL_MEMBER: route.url_for(session_id, DAEMON_TOOL_SERVER_NAME),
            ENTRY_SWITCH_MEMBER: true,
            // The daemon judges each of its own calls itself, so Codex asks nothing first.
            DEFAULT_TOOLS_APPROVAL_MODE_MEMBER: "approve",
            TOOL_TIMEOUT_SEC_MEMBER: CODEX_DAEMON_TOOL_TIMEOUT_SECONDS,
        }),
    );
}
