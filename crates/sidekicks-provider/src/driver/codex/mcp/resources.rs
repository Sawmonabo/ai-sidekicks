//! What one of a session's servers offers to attach, as Codex lists it on the session's own
//! conversation: `mcpServerStatus/list` at its full detail, whose rows carry each server's
//! resources beside its resource templates, which are no resources and are not listed.

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::app_server_protocol::McpServerStatusDetail;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::mcp::status_list::list_codex_mcp_server_status_pages;
use crate::driver::codex::session::lifecycle_call::{CodexLifecycleCall, call_codex_lifecycle};
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::resources::{
    McpResourceSource, not_a_session_server, read_listed_mcp_resource,
};

// One server's row of the full list: its name and its resources; the rest is not read.
#[derive(Deserialize)]
struct ResourceRow {
    name: String,
    #[serde(default)]
    resources: Vec<Value>,
}

impl CodexDriver {
    /// The resources Codex lists for `server_name` on `session_id`'s live conversation, every
    /// page read, `complete` false where the page cap stopped the read or a page did not read; a
    /// resource that does not read is left out. Refused `mcp.server.notRunning` when Codex lists
    /// no such server for the conversation, and as the session holds no live conversation or a
    /// request fails.
    pub(crate) async fn list_mcp_resources(
        &self,
        session_id: SessionId,
        server_name: McpServerName,
    ) -> Result<McpResourceSource, DriverError> {
        let inbound = self.slots.require_live(session_id)?;
        let conversation = call_codex_lifecycle(&inbound, |reply| {
            CodexLifecycleCall::ReadConversation { reply }
        })
        .await?;
        let connection = conversation.connection?;
        let mut resources = Vec::new();
        let mut is_listed = false;
        let mut is_page_unread = false;
        let is_every_page_read = list_codex_mcp_server_status_pages(
            &connection,
            &conversation.thread_id,
            Some(server_name.as_str()),
            McpServerStatusDetail::Full,
            |rows| match Vec::<ResourceRow>::deserialize(rows) {
                Ok(rows) => {
                    for row in rows
                        .into_iter()
                        .filter(|row| row.name == server_name.as_str())
                    {
                        is_listed = true;
                        resources.extend(
                            row.resources
                                .into_iter()
                                .filter_map(read_listed_mcp_resource),
                        );
                    }
                }
                Err(error) => {
                    is_page_unread = true;
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a page of codex's mcp server list did not read; its resources are left out"
                    );
                }
            },
        )
        .await?;
        if !is_listed {
            return Err(DriverError::from(not_a_session_server(&server_name)));
        }
        Ok(McpResourceSource::Listed {
            resources,
            complete: is_every_page_read && !is_page_unread,
        })
    }
}
