//! Codex's `mcpServerStatus/list` on one conversation, read page by page into bounded readings
//! that carry each server's tools: the one read the machine probe and a live session's leg share,
//! and the paged read beneath it, at whichever detail a caller asks for.

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
/// logged and skipped. Fails as [`list_codex_mcp_server_status_pages`] does.
pub(crate) async fn list_codex_mcp_server_statuses(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    server_name: Option<&str>,
) -> Result<Vec<McpServerStatusEmission>, CodexError> {
    let mut emissions = Vec::new();
    list_codex_mcp_server_status_pages(
        connection,
        thread_id,
        server_name,
        McpServerStatusDetail::ToolsAndAuthOnly,
        |rows| {
            let listed = normalize_codex_mcp_server_status_list(rows);
            for rejection in &listed.rejections {
                tracing::warn!(reason = %rejection.reason, "a codex mcp server status was refused");
            }
            emissions.extend(listed.emissions);
        },
    )
    .await?;
    Ok(emissions)
}

/// Reads each page Codex lists for the conversation `thread_id` on `connection` at `detail`, or
/// `server_name` alone where given, handing `read_rows` each page's rows in order; answers
/// whether every page was read, `false` where the page cap stopped the read. Fails as a request
/// fails, and with `CodexError::Transport` for a page that cannot be read.
pub(crate) async fn list_codex_mcp_server_status_pages(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    server_name: Option<&str>,
    detail: McpServerStatusDetail,
    mut read_rows: impl FnMut(&Value),
) -> Result<bool, CodexError> {
    let mut cursor = None;
    for _page in 0..MAX_LIST_PAGES {
        let reply = connection
            .request(
                MCP_SERVER_STATUS_LIST_METHOD,
                &ListMcpServerStatusParams {
                    cursor: cursor.take(),
                    thread_id: Some(thread_id.to_owned()),
                    server_name: server_name.map(str::to_owned),
                    detail: Some(detail),
                    ..ListMcpServerStatusParams::default()
                },
            )
            .await?;
        let page = read_codex_object::<StatusListPage>(reply.get()).ok_or_else(|| {
            CodexError::Transport {
                detail: format!(
                    "Codex's \"{MCP_SERVER_STATUS_LIST_METHOD}\" reply could not be read."
                ),
                cause: None,
            }
        })?;
        read_rows(&page.data);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return Ok(true),
        }
    }
    tracing::warn!(
        pages = MAX_LIST_PAGES,
        "codex's mcp server status list did not end; the servers read so far are kept"
    );
    Ok(false)
}

// One page of the list's reply: its rows and the cursor of the next page, where there is one.
#[derive(Deserialize)]
struct StatusListPage {
    #[serde(default)]
    data: Value,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}
