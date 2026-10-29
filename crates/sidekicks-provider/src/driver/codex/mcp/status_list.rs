//! Codex's `mcpServerStatus/list` on one conversation, read page by page into bounded readings
//! that carry each server's tools: the one read the machine probe and a live session's leg share.

use serde::Deserialize;
use serde_json::Value;

use crate::driver::codex::app_server_protocol::{ListMcpServerStatusParams, McpServerStatusDetail};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::tools::normalize_codex_mcp_server_status_list;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::mcp_server::status::McpServerStatusEmission;

// The request that lists the servers of a conversation with their tools.
const MCP_SERVER_STATUS_LIST_METHOD: &str = "mcpServerStatus/list";
// The most pages one list reads, far above any server count a config holds, so a cursor that
// never ends cannot keep the read going.
const MAX_LIST_PAGES: usize = 64;

/// Each server Codex lists for the conversation `thread_id` on `connection`, or `server_name`
/// alone where given, with its status and tools, every page read; a row the reader refuses is
/// logged and skipped. Fails as a request fails.
pub(crate) async fn list_codex_mcp_server_statuses(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    server_name: Option<&str>,
) -> Result<Vec<McpServerStatusEmission>, CodexError> {
    let mut emissions = Vec::new();
    let mut cursor = None;
    for _page in 0..MAX_LIST_PAGES {
        let reply = connection
            .request(
                MCP_SERVER_STATUS_LIST_METHOD,
                &ListMcpServerStatusParams {
                    cursor: cursor.take(),
                    thread_id: Some(thread_id.to_owned()),
                    server_name: server_name.map(str::to_owned),
                    detail: Some(McpServerStatusDetail::ToolsAndAuthOnly),
                    ..ListMcpServerStatusParams::default()
                },
            )
            .await?;
        let page = read_codex_object::<StatusListPage>(reply.get()).unwrap_or_default();
        let listed = normalize_codex_mcp_server_status_list(&page.data);
        for rejection in &listed.rejections {
            tracing::warn!(reason = %rejection.reason, "a codex mcp server status was refused");
        }
        emissions.extend(listed.emissions);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return Ok(emissions),
        }
    }
    tracing::warn!(
        pages = MAX_LIST_PAGES,
        "codex's mcp server status list did not end; the servers read so far are kept"
    );
    Ok(emissions)
}

// One page of the list's reply: its rows and the cursor of the next page, where there is one.
#[derive(Default, Deserialize)]
struct StatusListPage {
    #[serde(default)]
    data: Value,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}
