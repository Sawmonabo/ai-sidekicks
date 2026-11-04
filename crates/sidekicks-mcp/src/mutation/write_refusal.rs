//! The `mcp.*` refusal answering a provider's refusal of a write to its own config.

use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_provider::driver::mcp_server::write::{McpServerObserved, McpServerWriteRefusal};

use crate::errors::{McpConfigFileInvalid, McpConfigWriteConflict, McpRefusal};

/// The daemon's words for a config file another writer held past the write's wait.
const CONFIG_FILE_BUSY_WORDS: &str = "another writer held the provider's config file";

/// The refusal answering the provider's `refusal` of a write to `binding`; a config that does not
/// load names the layer paths `before`, the read before the write, reported.
pub(crate) fn mcp_refusal_of_write(
    binding: &McpServerBindingRef,
    refusal: McpServerWriteRefusal,
    before: &McpServerObserved,
) -> McpRefusal {
    let write_conflict = |conflict| McpRefusal::ServerConfigWriteConflict {
        binding: Box::new(binding.clone()),
        conflict,
    };
    match refusal {
        McpServerWriteRefusal::Provider { words } => McpRefusal::ProviderRefusedWrite {
            binding: Box::new(binding.clone()),
            words,
        },
        McpServerWriteRefusal::ConfigFileBusy => McpRefusal::ProviderRefusedWrite {
            binding: Box::new(binding.clone()),
            words: CONFIG_FILE_BUSY_WORDS.to_owned(),
        },
        McpServerWriteRefusal::EntryInvalid { words } => {
            McpRefusal::ServerConfigInvalid { reason: words }
        }
        McpServerWriteRefusal::ConfigFileInvalid { words } => McpRefusal::ServerConfigFileInvalid {
            details: Box::new(McpConfigFileInvalid {
                binding: binding.clone(),
                words,
                config_files: before.config_files.clone(),
            }),
        },
        McpServerWriteRefusal::StaleVersion {
            expected_version,
            current_version,
        } => write_conflict(McpConfigWriteConflict::StaleVersion {
            expected_version,
            current_version,
        }),
        McpServerWriteRefusal::ConfigFileChanged => {
            write_conflict(McpConfigWriteConflict::ConfigFileChanged)
        }
        McpServerWriteRefusal::EntryChanged => write_conflict(McpConfigWriteConflict::EntryChanged),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_provider::driver::mcp_server::write::{
        McpServerObserved, McpServerObservedEntry, McpServerWriteRefusal,
    };

    use super::mcp_refusal_of_write;

    /// The layer paths the read before the write reported.
    const BEFORE_FILES: [&str; 2] = [
        "/Users/x/.codex/config.toml",
        "/Users/x/work/.codex/config.toml",
    ];

    /// The audit ref every binding-naming refusal sends.
    const BINDING_KEYS: [&str; 3] = ["provider", "scope", "serverName"];

    fn words(text: &str) -> String {
        text.to_owned()
    }

    // Every driver refusal answers its own code and fields, and a config that does not load sends
    // the before-read's layer paths, never one its words name.
    #[rstest]
    #[case::provider(
        McpServerWriteRefusal::Provider { words: words("the provider is busy") },
        RefusalCode::ProviderUnavailable,
        &BINDING_KEYS[..],
        None
    )]
    #[case::config_file_busy(
        McpServerWriteRefusal::ConfigFileBusy,
        RefusalCode::ProviderUnavailable,
        &BINDING_KEYS[..],
        None
    )]
    #[case::entry_invalid(
        McpServerWriteRefusal::EntryInvalid { words: words("url is not an address") },
        RefusalCode::McpServerConfigInvalid,
        &[][..],
        None
    )]
    #[case::config_file_invalid(
        McpServerWriteRefusal::ConfigFileInvalid {
            words: words("/Users/x/.codex/config.toml: expected a table at line 3"),
        },
        RefusalCode::McpServerConfigFileInvalid,
        &["provider", "scope", "serverName", "configFiles"][..],
        None
    )]
    #[case::stale_version(
        McpServerWriteRefusal::StaleVersion {
            expected_version: words("v1"),
            current_version: words("v2"),
        },
        RefusalCode::McpServerConfigWriteConflict,
        &["provider", "scope", "serverName", "reason", "expectedVersion", "currentVersion"][..],
        Some("staleVersion")
    )]
    #[case::config_file_changed(
        McpServerWriteRefusal::ConfigFileChanged,
        RefusalCode::McpServerConfigWriteConflict,
        &["provider", "scope", "serverName", "reason"][..],
        Some("configFileChanged")
    )]
    #[case::entry_changed(
        McpServerWriteRefusal::EntryChanged,
        RefusalCode::McpServerConfigWriteConflict,
        &["provider", "scope", "serverName", "reason"][..],
        Some("entryChanged")
    )]
    fn each_driver_refusal_answers_its_code(
        #[case] refusal: McpServerWriteRefusal,
        #[case] code: RefusalCode,
        #[case] field_keys: &[&str],
        #[case] reason: Option<&str>,
    ) {
        let binding = McpServerBindingRef::User {
            provider: ProviderId::new("provider-a".to_owned()).expect("a provider id"),
            server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
        };
        let before = McpServerObserved {
            entry: McpServerObservedEntry::Absent,
            config_version: None,
            config_files: BEFORE_FILES.map(str::to_owned).to_vec(),
        };
        let answered = DomainError::from(mcp_refusal_of_write(&binding, refusal, &before));
        assert_eq!(answered.code, code);
        let fields = answered.detail.map(|detail| *detail).unwrap_or_default();
        let sent_keys: BTreeSet<&str> = fields.keys().map(String::as_str).collect();
        assert_eq!(sent_keys, field_keys.iter().copied().collect());
        assert_eq!(fields.get("reason").and_then(Value::as_str), reason);
        let config_files =
            (code == RefusalCode::McpServerConfigFileInvalid).then(|| json!(BEFORE_FILES));
        assert_eq!(fields.get("configFiles"), config_files.as_ref());
    }
}
