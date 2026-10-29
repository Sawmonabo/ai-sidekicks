//! Claude Code's tools: the catalog the driver reports with each tool's idempotency class (whether
//! a call may safely be repeated, shown on Settings › MCP servers), the built-in tools a person
//! picks for an agent, and the MCP server readings `system/init` and the MCP status read report.
//!
//! Only pure reads of local state are `idempotent`; a wrongly permissive class tells the person a
//! repeat is safe when it is not. No entry is `compensable` (no built-in tool accepts a dedupe key)
//! or carries a description (that column holds the provider's own).

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerStatus;
use sidekicks_contracts::provider::driver::tools::{IdempotencyClass, ProviderToolMetadata};
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};

use crate::driver::mcp_server::status::{
    McpServerReading, McpServerStatusIngestRejection, McpServerStatusIngestResult,
    bound_mcp_server_status_emission,
};

/// The tools Claude Code carries itself, in its own names, each with the shared word for the tool
/// that the allowlist picker draws. Apart from the catalog, which names what a transcript reports.
pub(super) const CLAUDE_BUILT_IN_TOOLS: [(&str, &str); 9] = [
    ("Read", "Read"),
    ("Edit", "Edit"),
    ("Write", "Write"),
    ("Bash", "Command"),
    ("Glob", "ListFiles"),
    ("Grep", "Search"),
    ("WebFetch", "WebFetch"),
    ("WebSearch", "WebSearch"),
    ("Agent", "Agent"),
];

// Each tool a transcript reports and its class. A tool the daemon cannot establish a repeat is
// safe for takes the default class, `manualReconcileOnly`.
const CLAUDE_TOOL_DECLARATIONS: [(&str, IdempotencyClass); 12] = [
    // Pure local reads: nothing observable changes, so a repeated call is safe.
    ("Read", IdempotencyClass::Idempotent),
    ("Glob", IdempotencyClass::Idempotent),
    ("Grep", IdempotencyClass::Idempotent),
    ("Bash", IdempotencyClass::ManualReconcileOnly),
    ("Write", IdempotencyClass::ManualReconcileOnly),
    ("Edit", IdempotencyClass::ManualReconcileOnly),
    ("MultiEdit", IdempotencyClass::ManualReconcileOnly),
    ("NotebookEdit", IdempotencyClass::ManualReconcileOnly),
    ("WebFetch", IdempotencyClass::ManualReconcileOnly),
    ("WebSearch", IdempotencyClass::ManualReconcileOnly),
    ("TodoWrite", IdempotencyClass::ManualReconcileOnly),
    ("Agent", IdempotencyClass::ManualReconcileOnly),
];

/// The tool catalog the driver's capabilities report, each tool with its idempotency class.
pub(crate) fn claude_tool_metadata() -> Vec<ProviderToolMetadata> {
    CLAUDE_TOOL_DECLARATIONS
        .iter()
        .map(|&(name, idempotency_class)| ProviderToolMetadata {
            name: FreeFormText::new(name.to_owned())
                .expect("a catalog tool name is short, non-blank text"),
            idempotency_class,
            description: None,
        })
        .collect()
}

// Claude Code's status words, read trimmed and lower-cased: the init census and the MCP status
// read send these five. `disabled` is the server switched off for the project, not a status; any
// other word, or a value that is not text, reads as `unknown`.
fn map_claude_status_token(raw_token: &Value) -> McpServerReading {
    let Some(raw_token) = raw_token.as_str() else {
        return McpServerReading::Observed(McpServerStatus::Unknown);
    };
    match raw_token
        .trim_matches(is_ecmascript_whitespace)
        .to_lowercase()
        .as_str()
    {
        "connected" => McpServerReading::Observed(McpServerStatus::Connected),
        "failed" => McpServerReading::Observed(McpServerStatus::Failed),
        "needs-auth" => McpServerReading::Observed(McpServerStatus::NeedsAuth),
        "pending" => McpServerReading::Observed(McpServerStatus::Starting),
        "disabled" => McpServerReading::SwitchedOff,
        _ => McpServerReading::Observed(McpServerStatus::Unknown),
    }
}

/// Reads Claude Code's MCP server rows, the `system/init` frame's `mcp_servers` list or the MCP
/// status read's rows, as one reading per server, each with the row's `error` text where it has
/// one. A list that is not an array is one rejection with no emissions, and a row that is not an
/// object, or whose name fails the wire bound, is one rejection; the rest are emitted.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the MCP server settings' live status reads each Claude Code session's servers \
                  from its init frame and its MCP status read through it"
    )
)]
pub(crate) fn normalize_claude_mcp_server_init_census(
    raw_servers: &Value,
) -> McpServerStatusIngestResult {
    let Some(raw_servers) = raw_servers.as_array() else {
        return McpServerStatusIngestResult {
            emissions: Vec::new(),
            rejections: vec![McpServerStatusIngestRejection {
                reason: "Claude Code's MCP server list is not an array; census skipped for this \
                         session."
                    .to_owned(),
            }],
        };
    };
    let mut result = McpServerStatusIngestResult::default();
    for raw_server in raw_servers {
        let Some(row) = raw_server.as_object() else {
            result.rejections.push(McpServerStatusIngestRejection {
                reason: "Claude Code's MCP server row is not an object; row skipped.".to_owned(),
            });
            continue;
        };
        let reading = map_claude_status_token(row.get("status").unwrap_or(&Value::Null));
        match bound_mcp_server_status_emission(
            row.get("name").unwrap_or(&Value::Null),
            reading,
            row.get("error").unwrap_or(&Value::Null),
        ) {
            Ok(emission) => result.emissions.push(emission),
            Err(rejection) => result.rejections.push(rejection),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpServerStatus::{
        Connected, Failed, NeedsAuth, Starting, Unknown,
    };

    use super::normalize_claude_mcp_server_init_census;
    use crate::driver::mcp_server::status::McpServerReading;
    use crate::driver::mcp_server::status::McpServerReading::{Observed, SwitchedOff};

    // Every status word Claude Code sends maps to its reading, `disabled` to the server switched
    // off rather than a status, and a row's `error` text reaches the emission. Killed by mapping
    // `disabled` to `Observed(Unknown)`, or by dropping the row's error text.
    #[rstest]
    #[case::connected(json!("connected"), Value::Null, Observed(Connected), None)]
    #[case::failed_with_error(
        json!("failed"),
        json!("spawn ENOENT"),
        Observed(Failed),
        Some("spawn ENOENT")
    )]
    #[case::needs_auth(json!("needs-auth"), Value::Null, Observed(NeedsAuth), None)]
    #[case::pending(json!("pending"), Value::Null, Observed(Starting), None)]
    #[case::disabled(json!("disabled"), Value::Null, SwitchedOff, None)]
    #[case::trimmed_upper_case(json!(" Connected "), Value::Null, Observed(Connected), None)]
    #[case::unlisted_word(json!("sleeping"), Value::Null, Observed(Unknown), None)]
    #[case::not_text(json!(7), Value::Null, Observed(Unknown), None)]
    #[case::blank_error(json!("failed"), json!("  "), Observed(Failed), None)]
    fn each_status_word_reads_as_its_reading(
        #[case] status: Value,
        #[case] error: Value,
        #[case] expected_reading: McpServerReading,
        #[case] expected_failure_text: Option<&str>,
    ) {
        let result = normalize_claude_mcp_server_init_census(&json!([
            { "name": "github", "status": status, "error": error },
        ]));

        assert!(result.rejections.is_empty(), "{:?}", result.rejections);
        let [emission] = result.emissions.as_slice() else {
            panic!("one emission, got {:?}", result.emissions);
        };
        assert_eq!(emission.server_name.as_str(), "github");
        assert_eq!(emission.reading, expected_reading);
        assert_eq!(emission.failure_text.as_deref(), expected_failure_text);
    }
}
