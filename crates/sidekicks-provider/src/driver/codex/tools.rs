//! Per-tool metadata for the Codex driver, its only source of a tool's idempotency class (whether
//! a call may safely be repeated, shown per tool on Settings › MCP servers), and its readers of
//! MCP server status.
//!
//! Tool names are `ThreadItem.type` arms: `codex app-server` publishes no list of model-facing
//! tool names, and that type is all the daemon observes. The mutating tools close to the
//! conservative floor on purpose, and no built-in is `compensable`, which needs a remote honoring
//! a client idempotency key. Left out: `mcpToolCall` and `dynamicToolCall` (their classes come
//! from the MCP floor and the session registry), `subAgentActivity`, and the message and lifecycle
//! arms.

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerStatus;
use sidekicks_contracts::provider::driver::tools::{IdempotencyClass, ProviderToolMetadata};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::mcp_server::status::{
    McpServerReading, McpServerStatusIngestRejection, McpServerStatusIngestResult,
    bound_mcp_server_status_emission,
};

/// Codex's own model-facing tools, in the names a person picks for an agent's allowlist, each with
/// the shared word for the tool that the picker draws: the command tool the model calls as
/// `exec_command`, the patch tool, which reads as an edit whatever kinds of change it mixes, and
/// the hosted web search.
pub(super) const CODEX_BUILT_IN_TOOLS: [(&str, &str); 3] = [
    ("exec_command", "Command"),
    ("apply_patch", "Edit"),
    ("web_search", "WebSearch"),
];

/// One tool the driver declares a class for. The description is required: the person reconciling
/// a halted receipt reads it.
struct CodexToolDeclaration {
    name: &'static str,
    idempotency_class: IdempotencyClass,
    description: &'static str,
}

/// The declared tools, in the order the catalog lists them.
const CODEX_TOOL_DECLARATIONS: [CodexToolDeclaration; 7] = [
    // The floor: an arbitrary shell command with an undeclared effect, and no dedupe handle for
    // a repeated call.
    CodexToolDeclaration {
        name: "commandExecution",
        idempotency_class: IdempotencyClass::ManualReconcileOnly,
        description: "Executes a shell command in the thread's working directory.",
    },
    // The floor: applying an applied patch again corrupts the working tree.
    CodexToolDeclaration {
        name: "fileChange",
        idempotency_class: IdempotencyClass::ManualReconcileOnly,
        description: "Applies file creations, edits, and deletions to the working tree.",
    },
    // The floor: a repeat duplicates another agent's run and its downstream effect.
    CodexToolDeclaration {
        name: "collabAgentToolCall",
        idempotency_class: IdempotencyClass::ManualReconcileOnly,
        description: "Spawns, messages, resumes, waits on, or closes a peer agent thread.",
    },
    // The floor: a billable remote generation whose repeat yields a different artifact.
    CodexToolDeclaration {
        name: "imageGeneration",
        idempotency_class: IdempotencyClass::ManualReconcileOnly,
        description: "Generates an image through the provider's remote model.",
    },
    // A read-only query against an external index; a repeat changes nothing.
    CodexToolDeclaration {
        name: "webSearch",
        idempotency_class: IdempotencyClass::Idempotent,
        description: "Runs a read-only web search and returns results to the model.",
    },
    // A pure read of a file into the model's context.
    CodexToolDeclaration {
        name: "imageView",
        idempotency_class: IdempotencyClass::Idempotent,
        description: "Reads an image file at a path into the model's context.",
    },
    // A wall-clock delay with no effect; a repeat costs time and nothing else.
    CodexToolDeclaration {
        name: "sleep",
        idempotency_class: IdempotencyClass::Idempotent,
        description: "Pauses the turn for a fixed duration.",
    },
];

/// The fully classified tool list, a fresh copy per call since the capabilities answer owns it.
pub(crate) fn codex_tool_metadata() -> Vec<ProviderToolMetadata> {
    CODEX_TOOL_DECLARATIONS
        .iter()
        .map(|declaration| ProviderToolMetadata {
            name: FreeFormText::new(declaration.name.to_owned())
                .expect("a declared tool name is a short word"),
            idempotency_class: declaration.idempotency_class,
            description: Some(
                FreeFormText::new(declaration.description.to_owned())
                    .expect("a declared tool description is one short sentence"),
            ),
        })
        .collect()
}

/// `McpServerConnectionStatus` as a reading; an unlisted word is `Unknown`. `cancelled` is
/// `Failed` (startup ended without a connection); `disabled` is the server switched off for this
/// conversation, not a status.
fn read_codex_connection_status(status: &str) -> McpServerReading {
    match status {
        "notStarted" | "starting" => McpServerReading::Observed(McpServerStatus::Starting),
        "connected" => McpServerReading::Observed(McpServerStatus::Connected),
        "authenticationRequired" => McpServerReading::Observed(McpServerStatus::NeedsAuth),
        "failed" | "cancelled" => McpServerReading::Observed(McpServerStatus::Failed),
        "disabled" => McpServerReading::SwitchedOff,
        _ => McpServerReading::Observed(McpServerStatus::Unknown),
    }
}

/// `McpServerStartupState` (the startup notification's `status`) as the unified status; the
/// startup states hold no switched-off one.
fn read_codex_startup_state(state: &str) -> McpServerStatus {
    match state {
        "starting" => McpServerStatus::Starting,
        "ready" => McpServerStatus::Connected,
        "failed" | "cancelled" => McpServerStatus::Failed,
        _ => McpServerStatus::Unknown,
    }
}

fn ingest_mcp_server_status(
    result: &mut McpServerStatusIngestResult,
    server_name: &Value,
    reading: McpServerReading,
    raw_failure_text: &Value,
) {
    match bound_mcp_server_status_emission(server_name, reading, raw_failure_text) {
        Ok(emission) => result.emissions.push(emission),
        Err(rejection) => result.rejections.push(rejection),
    }
}

/// Reads `mcpServerStatus/list` rows into bounded readings; a value that is not an array yields
/// one rejection, and each row that is not an object another. A `null` `runtimeStatus` reads
/// `NeedsAuth` only for `authStatus` `notLoggedIn`, else `Unknown`. A row carries no error text
/// for its status (its `toolsError` is about its tools).
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex driver's MCP server status reads call it, the one map of Codex's rows"
    )
)]
pub(crate) fn normalize_codex_mcp_server_status_list(
    raw_rows: &Value,
) -> McpServerStatusIngestResult {
    let mut result = McpServerStatusIngestResult::default();
    let Some(rows) = raw_rows.as_array() else {
        result.rejections.push(McpServerStatusIngestRejection {
            reason: "mcpServerStatus/list data is not an array; census skipped for this read."
                .to_owned(),
        });
        return result;
    };
    for row in rows {
        let Some(row) = row.as_object() else {
            result.rejections.push(McpServerStatusIngestRejection {
                reason: "mcpServerStatus/list row is not an object; row skipped.".to_owned(),
            });
            continue;
        };
        let reading = match row.get("runtimeStatus").and_then(Value::as_str) {
            Some(runtime_status) => read_codex_connection_status(runtime_status),
            None if row.get("authStatus").and_then(Value::as_str) == Some("notLoggedIn") => {
                McpServerReading::Observed(McpServerStatus::NeedsAuth)
            }
            None => McpServerReading::Observed(McpServerStatus::Unknown),
        };
        ingest_mcp_server_status(
            &mut result,
            row.get("name").unwrap_or(&Value::Null),
            reading,
            &Value::Null,
        );
    }
    result
}

/// Reads one `mcpServer/startupStatus/updated` notification into a bounded reading with its
/// `error` text; a `failed` startup for `reauthenticationRequired` reads `NeedsAuth`, the one
/// state a person can fix.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex driver's MCP server status reads call it, the one map of Codex's \
                  startup updates"
    )
)]
pub(crate) fn normalize_codex_mcp_server_status_notification(
    raw_notification: &Value,
) -> McpServerStatusIngestResult {
    let mut result = McpServerStatusIngestResult::default();
    let Some(notification) = raw_notification.as_object() else {
        result.rejections.push(McpServerStatusIngestRejection {
            reason: "mcpServer/startupStatus/updated payload is not an object; update skipped."
                .to_owned(),
        });
        return result;
    };
    let status = match notification.get("status").and_then(Value::as_str) {
        Some(state) => read_codex_startup_state(state),
        None => McpServerStatus::Unknown,
    };
    let needs_sign_in = notification.get("failureReason").and_then(Value::as_str)
        == Some("reauthenticationRequired");
    let status = if status == McpServerStatus::Failed && needs_sign_in {
        McpServerStatus::NeedsAuth
    } else {
        status
    };
    ingest_mcp_server_status(
        &mut result,
        notification.get("name").unwrap_or(&Value::Null),
        McpServerReading::Observed(status),
        notification.get("error").unwrap_or(&Value::Null),
    );
    result
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpServerStatus::{
        Connected, Failed, NeedsAuth, Starting, Unknown,
    };

    use super::{
        normalize_codex_mcp_server_status_list, normalize_codex_mcp_server_status_notification,
    };
    use crate::driver::mcp_server::status::McpServerReading::{Observed, SwitchedOff};
    use crate::driver::mcp_server::status::{McpServerReading, McpServerStatusIngestResult};

    // One `mcpServerStatus/list` row for the server, read through the list's reader.
    fn list(runtime_status: Value, auth_status: &str) -> McpServerStatusIngestResult {
        normalize_codex_mcp_server_status_list(&json!([{
            "name": "github",
            "runtimeStatus": runtime_status,
            "authStatus": auth_status,
            "toolsError": "tools/list timed out",
        }]))
    }

    // One `mcpServer/startupStatus/updated` notification, read through the startup reader.
    fn startup(status: &str, error: Value, failure_reason: Value) -> McpServerStatusIngestResult {
        normalize_codex_mcp_server_status_notification(&json!({
            "threadId": "thread-1",
            "name": "github",
            "status": status,
            "error": error,
            "failureReason": failure_reason,
        }))
    }

    // Every word Codex sends for a server maps to its reading, `disabled` to the server switched
    // off rather than a status, a sign-in failure to `NeedsAuth`, and a startup's `error` text
    // reaches the emission while a row's `toolsError` does not. Killed by mapping `disabled` to
    // `Observed(Unknown)`, by dropping the reauthentication rule, or by dropping the startup's
    // error text.
    #[rstest]
    #[case::not_started(list(json!("notStarted"), "oAuth"), Observed(Starting), None)]
    #[case::starting(list(json!("starting"), "oAuth"), Observed(Starting), None)]
    #[case::connected(list(json!("connected"), "oAuth"), Observed(Connected), None)]
    #[case::sign_in(list(json!("authenticationRequired"), "oAuth"), Observed(NeedsAuth), None)]
    #[case::failed(list(json!("failed"), "oAuth"), Observed(Failed), None)]
    #[case::cancelled(list(json!("cancelled"), "oAuth"), Observed(Failed), None)]
    #[case::disabled(list(json!("disabled"), "oAuth"), SwitchedOff, None)]
    #[case::unlisted_word(list(json!("paused"), "oAuth"), Observed(Unknown), None)]
    #[case::no_thread_logged_out(list(Value::Null, "notLoggedIn"), Observed(NeedsAuth), None)]
    #[case::no_thread_signed_in(list(Value::Null, "oAuth"), Observed(Unknown), None)]
    #[case::startup_starting(
        startup("starting", Value::Null, Value::Null),
        Observed(Starting),
        None
    )]
    #[case::startup_ready(startup("ready", Value::Null, Value::Null), Observed(Connected), None)]
    #[case::startup_cancelled(
        startup("cancelled", Value::Null, Value::Null),
        Observed(Failed),
        None
    )]
    #[case::startup_failed(
        startup("failed", json!("handshake timed out"), Value::Null),
        Observed(Failed),
        Some("handshake timed out")
    )]
    #[case::startup_reauthentication(
        startup("failed", json!("token expired"), json!("reauthenticationRequired")),
        Observed(NeedsAuth),
        Some("token expired")
    )]
    fn each_status_word_reads_as_its_reading(
        #[case] result: McpServerStatusIngestResult,
        #[case] expected_reading: McpServerReading,
        #[case] expected_failure_text: Option<&str>,
    ) {
        assert!(result.rejections.is_empty(), "{:?}", result.rejections);
        let [emission] = result.emissions.as_slice() else {
            panic!("one emission, got {:?}", result.emissions);
        };
        assert_eq!(emission.server_name.as_str(), "github");
        assert_eq!(emission.reading, expected_reading);
        assert_eq!(emission.failure_text.as_deref(), expected_failure_text);
    }
}
