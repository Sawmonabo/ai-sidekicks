//! The `mcp_status` answer: each MCP server's name, status, error text, scope and tool names as
//! a Claude Code process reports them, read with the server's configuration left unread and the
//! error text's credentials scrubbed.

use serde::de::IntoDeserializer;
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_ipc::redaction::scrub_credentials;

use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

/// An `mcp_status` answer: one row per MCP server the process holds, under `mcpServers`. Each
/// member is read leniently, and a row's `config`, which can carry headers, addresses with their
/// credentials and sign-in settings, is never read.
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

/// One MCP server's row in an `mcp_status` answer: its name, status, error text, scope and tool
/// names; every other member, `config` among them, is left unread.
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the account read of connector and organization servers reads it"
        )
    )]
    pub(crate) scope: Option<String>,
    /// The server's tools, each by name; sent while it is connected.
    #[serde(default, deserialize_with = "read_lenient")]
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the MCP server settings list a live server's tools from it"
        )
    )]
    pub(crate) tools: Option<LenientList<ClaudeMcpServerTool>>,
}

/// One tool of an `mcp_status` row, by name; its description, annotations and metadata are left
/// unread.
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeMcpServerTool {
    /// The tool's name.
    #[serde(default, deserialize_with = "read_lenient")]
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the MCP server settings list a live server's tools from it"
        )
    )]
    pub(crate) name: Option<String>,
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
    ClaudeMcpServerTool,
);

#[cfg(test)]
mod tests {
    use serde_json::value::RawValue;

    use super::{ClaudeMcpServerStatus, ClaudeMcpStatusReply};

    // Rows as a cloud worker sends them, `config` holding a header token and an address with
    // userinfo and a query: only the five members are read, and the error is scrubbed.
    #[test]
    fn an_mcp_status_row_keeps_no_config_and_scrubs_its_error() {
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
