//! The `mcp.*` refusals, each sent on the wire by its code: the refusal's message becomes the
//! reply's message and its detail `data.fields`.
//!
//! No path and no config value reaches a message or a detail: a binding is named by its provider,
//! scope and server name alone, never by its project root, and a failure underneath stays on the
//! refusal for the service log and never reaches the wire.

use std::error::Error;

use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::governance::McpServerConfigWriteConflictReason;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_ipc::domain_error::{DomainError, refusal_fields};

use crate::binding_store::McpBindingKey;

/// Why a write to a provider's own config lost to a concurrent edit, with what each reason
/// carries; its reason is the detail's `reason`.
#[expect(dead_code, reason = "the mcp.* handlers refuse through it")]
#[derive(Debug)]
pub(crate) enum McpConfigWriteConflict {
    /// The provider refused the write's expected version as stale; both versions go back so the
    /// caller can read the config again.
    StaleVersion {
        /// The version the write expected.
        expected_version: String,
        /// The version the provider holds.
        current_version: String,
    },
    /// The project file no longer hashes to what the daemon last read, so the edit was not
    /// written and the file was left as it was.
    ProjectFileChanged,
}

/// A refusal of an `mcp.*` call, converted into the reply's error by its code.
#[expect(dead_code, reason = "the mcp.* handlers refuse through it")]
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpRefusal {
    /// The binding store cannot be reached, so every MCP change fails closed, changing nothing.
    #[error("the MCP binding store cannot be reached, so no MCP change can be made until it can")]
    BindingStoreUnavailable {
        /// The store's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The submitted configuration failed validation before anything was written.
    #[error("the MCP server configuration is invalid: {reason}")]
    ServerConfigInvalid {
        /// The field and the rule it broke, in words the daemon writes; never a submitted value.
        reason: String,
    },
    /// A write to the provider's own config lost to a concurrent edit; nothing was written.
    #[error(
        "{}: its configuration changed while it was being written, so nothing was written",
        binding_words(.binding)
    )]
    ServerConfigWriteConflict {
        /// The binding the write was for.
        binding: McpServerBindingRef,
        /// How the write lost.
        conflict: McpConfigWriteConflict,
    },
    /// No server with the binding's provider, scope, reference and name is in the inventory.
    #[error("{} was not found", binding_words(.binding))]
    ServerNotFound {
        /// The binding asked for.
        binding: McpServerBindingRef,
    },
    /// The server is off or not working in the session, so it cannot answer a read.
    #[error("{} is off or not working in this session", binding_words(.binding))]
    ServerNotRunning {
        /// The binding asked for.
        binding: McpServerBindingRef,
    },
    /// The sign-in could not be started for a passing reason; it can be tried again.
    #[error("the sign-in to {} could not be started", binding_words(.binding))]
    ServerSignInFailed {
        /// The binding being signed in to.
        binding: McpServerBindingRef,
        /// Why it could not be started.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The server publishes no sign-in route, or one the daemon cannot read.
    #[error("{} offers no sign-in the daemon can use", binding_words(.binding))]
    ServerSignInUnsupported {
        /// The binding being signed in to.
        binding: McpServerBindingRef,
    },
}

impl From<McpRefusal> for DomainError {
    fn from(refusal: McpRefusal) -> Self {
        let message = refusal.to_string();
        let (code, detail, source): (
            _,
            Option<Map<String, Value>>,
            Option<Box<dyn Error + Send + Sync>>,
        ) = match refusal {
            McpRefusal::BindingStoreUnavailable { source } => {
                (RefusalCode::McpBindingStoreUnavailable, None, Some(source))
            }
            McpRefusal::ServerConfigInvalid { .. } => {
                (RefusalCode::McpServerConfigInvalid, None, None)
            }
            McpRefusal::ServerConfigWriteConflict { binding, conflict } => (
                RefusalCode::McpServerConfigWriteConflict,
                Some(write_conflict_fields(&binding, &conflict)),
                None,
            ),
            McpRefusal::ServerNotFound { binding } => (
                RefusalCode::McpServerNotFound,
                Some(binding_fields(&binding)),
                None,
            ),
            McpRefusal::ServerNotRunning { binding } => (
                RefusalCode::McpServerNotRunning,
                Some(binding_fields(&binding)),
                None,
            ),
            McpRefusal::ServerSignInFailed { binding, source } => (
                RefusalCode::McpServerSignInFailed,
                Some(binding_fields(&binding)),
                Some(source),
            ),
            McpRefusal::ServerSignInUnsupported { binding } => (
                RefusalCode::McpServerSignInUnsupported,
                Some(binding_fields(&binding)),
                None,
            ),
        };
        DomainError {
            message,
            code,
            detail,
            source,
        }
    }
}

// The binding as a message names it: its server, scope and provider, never its reference.
fn binding_words(binding: &McpServerBindingRef) -> String {
    let key = McpBindingKey::of(binding);
    format!(
        "MCP server {} ({} scope, provider {})",
        key.server_name.as_str(),
        <&'static str>::from(key.scope),
        key.provider.as_str()
    )
}

// The binding's path-free audit ref, `{provider, scope, serverName}`.
fn binding_fields(binding: &McpServerBindingRef) -> Map<String, Value> {
    let key = McpBindingKey::of(binding);
    refusal_fields(json!({
        "provider": key.provider.as_str(),
        "scope": <&'static str>::from(key.scope),
        "serverName": key.server_name.as_str(),
    }))
}

// The audit ref with the conflict's reason and, for a stale version, both versions.
fn write_conflict_fields(
    binding: &McpServerBindingRef,
    conflict: &McpConfigWriteConflict,
) -> Map<String, Value> {
    let conflict_fields = match conflict {
        McpConfigWriteConflict::StaleVersion {
            expected_version,
            current_version,
        } => json!({
            "reason": McpServerConfigWriteConflictReason::StaleVersion,
            "expectedVersion": expected_version,
            "currentVersion": current_version,
        }),
        McpConfigWriteConflict::ProjectFileChanged => {
            json!({ "reason": McpServerConfigWriteConflictReason::ProjectFileChanged })
        }
    };
    let mut fields = binding_fields(binding);
    fields.extend(refusal_fields(conflict_fields));
    fields
}
