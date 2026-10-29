//! The `mcp_status` answer: each MCP server's name, status, error text, scope, source,
//! configuration and tool names as a Claude Code process reports them, the configuration read
//! down to its transport, its stripped address and its program, and the error text's credentials
//! scrubbed.

use std::fmt;

use serde::de::IntoDeserializer;
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use sidekicks_contracts::mcp::server::McpToolName;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_ipc::redaction::scrub_credentials;

use crate::driver::mcp_server::address::{ServerAddressReading, read_server_address};
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

/// An `mcp_status` answer: one row per MCP server the process holds, under `mcpServers`. Each
/// member is read leniently, and a row's `config`, which can carry headers, addresses with their
/// credentials and sign-in settings, keeps no header and no address whole.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ClaudeMcpStatusReply {
    /// The servers' rows; absent from an answer that carries no list.
    #[serde(rename = "mcpServers", default, deserialize_with = "read_lenient")]
    pub(crate) servers: Option<LenientList<ClaudeMcpServerStatusRow>>,
}

impl ClaudeMcpStatusReply {
    /// Reads an `mcp_status` answer; an absent one, or one that is no object, carries no list.
    pub(crate) fn read(reply: Option<&RawValue>) -> Self {
        reply
            .and_then(|reply| {
                let mut deserializer = serde_json::Deserializer::from_str(reply.get());
                <Self as Lenient>::read(&mut deserializer).ok().flatten()
            })
            .unwrap_or_default()
    }
}

/// One MCP server's row in an `mcp_status` answer: its name, status, error text, scope, source,
/// stripped configuration and tool names; every other member is left unread.
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeMcpServerStatusRow {
    /// The server's name as configured.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) name: Option<String>,
    /// The server's status; absent when it is none of the five words Claude Code sends.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) status: Option<ClaudeMcpServerStatus>,
    /// The server's error text, its credentials scrubbed as it is read.
    #[serde(default, deserialize_with = "read_scrubbed_text")]
    pub(crate) error: Option<String>,
    /// Where the server is configured (`user`, `project`, `local`, `claudeai`, `managed`, …), as
    /// sent.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) scope: Option<String>,
    /// Where the server's definition came from, as sent: `sdk`, `plugin`, or its scope. Claude
    /// Code keys trust on it rather than on the name; absent from a build that predates it.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) source: Option<String>,
    /// The server's configuration, its address stripped and folded as it is read.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) config: Option<ClaudeMcpServerStatusConfig>,
    /// The server's tools, each by name; sent while it is connected.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) tools: Option<LenientList<ClaudeMcpServerTool>>,
}

impl ClaudeMcpServerStatusRow {
    /// The names of the row's tools that pass the wire bound; empty where it sends none.
    pub(crate) fn tool_names(&self) -> Vec<McpToolName> {
        self.tools
            .iter()
            .flat_map(|tools| &tools.0)
            .filter_map(|tool| McpToolName::new(tool.name.clone()?).ok())
            .collect()
    }
}

/// One tool of an `mcp_status` row, by name; its description, annotations and metadata are left
/// unread.
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeMcpServerTool {
    /// The tool's name.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) name: Option<String>,
}

/// A row's `config` as read: its transport word, a remote server's address stripped and folded, and
/// a program's command and arguments. A connector's id and every header are left unread, the
/// whole address is dropped once folded, and its `Debug` prints the transport alone.
pub(crate) struct ClaudeMcpServerStatusConfig {
    /// The `type` as sent (`stdio`, `http`, `sse`, `claudeai-proxy`, …); absent for a program.
    pub(crate) transport: Option<String>,
    /// A remote server's address, stripped, with its folded whole form held only in memory.
    pub(crate) address: Option<ServerAddressReading>,
    /// A program's command.
    pub(crate) command: Option<String>,
    /// A program's arguments.
    pub(crate) args: Option<Vec<String>>,
}

impl fmt::Debug for ClaudeMcpServerStatusConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeMcpServerStatusConfig")
            .field("transport", &self.transport)
            .finish_non_exhaustive()
    }
}

impl Lenient for ClaudeMcpServerStatusConfig {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        Ok(
            ClaudeMcpServerStatusConfigMembers::read(deserializer)?.map(|members| Self {
                transport: members.transport,
                address: members.url.as_deref().map(read_server_address),
                command: members.command,
                args: members.args.map(|args| args.0),
            }),
        )
    }
}

// The members of a row's `config` the read takes, the address whole only until it is folded.
#[derive(Deserialize)]
struct ClaudeMcpServerStatusConfigMembers {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    transport: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    url: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    command: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    args: Option<LenientList<String>>,
}

/// An MCP server's status as an `mcp_status` row sends it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ClaudeMcpServerStatus {
    /// Connected.
    Connected,
    /// Could not start or broke.
    Failed,
    /// Waits for a sign-in.
    NeedsAuth,
    /// Starting.
    Pending,
    /// Switched off for the project.
    Disabled,
}

impl ClaudeMcpServerStatus {
    /// Reads one status word, trimmed and lower-cased, as both the `system/init` list and the
    /// `mcp_status` answer send it; `None` for any other word.
    pub(crate) fn from_word(word: &str) -> Option<Self> {
        let word = word.trim_matches(is_ecmascript_whitespace).to_lowercase();
        Self::deserialize(
            IntoDeserializer::<serde::de::value::Error>::into_deserializer(word.as_str()),
        )
        .ok()
    }
}

impl Lenient for ClaudeMcpServerStatus {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        Ok(String::read(deserializer)?.and_then(|word| Self::from_word(&word)))
    }
}

// A text member read leniently with its credentials scrubbed, so the raw text is never kept.
fn read_scrubbed_text<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Ok(String::read(deserializer)?.map(|text| scrub_credentials(&text)))
}

lenient_object!(
    ClaudeMcpStatusReply,
    ClaudeMcpServerStatusRow,
    ClaudeMcpServerStatusConfigMembers,
    ClaudeMcpServerTool,
);

#[cfg(test)]
mod tests {
    use serde_json::value::RawValue;

    use super::{ClaudeMcpServerStatus, ClaudeMcpStatusReply};

    // Rows as a cloud worker sends them, `config` holding a header token and an address with
    // userinfo and a query: no credential, connector id or address is kept where `Debug` reaches,
    // and the error is scrubbed.
    #[test]
    fn an_mcp_status_row_keeps_no_credential_and_scrubs_its_error() {
        let reply = RawValue::from_string(
            serde_json::json!({
                "mcpServers": [
                    {
                        "name": "tracker",
                        "status": "failed",
                        "error": "connect https://deploy:hunter2-userinfo@mcp.example.com/sse \
                                  failed: Authorization: Bearer error-bearer-secret-0123",
                        "scope": "user",
                        "config": {
                            "type": "http",
                            "url": "https://config-user:config-password@mcp.example.com/mcp\
                                    ?api_key=config-query-secret",
                            "headers": { "Authorization": "Bearer config-header-secret-0123" }
                        }
                    },
                    {
                        "name": "notes",
                        "status": "connected",
                        "scope": "claudeai",
                        "config": { "type": "claudeai-proxy", "url": "https://proxy.example.com",
                                    "id": "config-connector-id" },
                        "tools": [{ "name": "search", "description": "Searches notes." }]
                    }
                ]
            })
            .to_string(),
        )
        .expect("the reply is JSON");

        let reading = ClaudeMcpStatusReply::read(Some(&reply));

        let rows = &reading
            .servers
            .as_ref()
            .expect("the reply carries a list")
            .0;
        let [tracker, notes] = rows.as_slice() else {
            panic!("two rows: {rows:?}");
        };
        assert_eq!(tracker.name.as_deref(), Some("tracker"));
        assert_eq!(tracker.status, Some(ClaudeMcpServerStatus::Failed));
        assert_eq!(tracker.scope.as_deref(), Some("user"));
        let error = tracker.error.as_deref().expect("the error is kept");
        assert!(error.contains("https://***@mcp.example.com/sse"), "{error}");
        assert!(error.contains("Authorization: ***"), "{error}");
        assert!(tracker.tools.is_none());
        assert_eq!(notes.name.as_deref(), Some("notes"));
        assert_eq!(notes.status, Some(ClaudeMcpServerStatus::Connected));
        assert_eq!(notes.scope.as_deref(), Some("claudeai"));
        assert!(notes.error.is_none());
        let tool_names: Vec<_> = notes
            .tools
            .as_ref()
            .expect("the tools are kept")
            .0
            .iter()
            .map(|tool| tool.name.as_deref())
            .collect();
        assert_eq!(tool_names, [Some("search")]);
        let debug = format!("{reading:?}");
        for secret in [
            "hunter2-userinfo",
            "error-bearer-secret",
            "config-user",
            "config-password",
            "config-query-secret",
            "config-header-secret",
            "config-connector-id",
            "proxy.example.com",
            "Searches notes.",
        ] {
            assert!(!debug.contains(secret), "{secret} is kept: {debug}");
        }
    }
}
