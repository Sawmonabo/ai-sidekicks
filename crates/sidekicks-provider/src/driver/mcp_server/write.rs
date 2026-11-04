//! The write of one tool-server declaration to a provider's own config, and what the provider holds
//! for the binding before and after it.

use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpWritableBindingRef};
use sidekicks_ipc::redaction::{redact_paths, scrub_credentials};

// A double-quoted span, its escaped characters included, or a backtick span, each running to the
// text's end where it is left open.
static QUOTED_SPAN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""(?:[^"\\]|\\.)*(?:"|\\?$)|`[^`]*(?:`|$)"#).expect("the pattern is a valid regex")
});

/// The word a quoted span of a provider's words is replaced with.
const ELIDED_SPAN: &str = "…";

/// A declaration's members as the provider holds them, values included. It lives only in memory,
/// and its `Debug` prints the members' names alone, since a value may carry a credential.
#[derive(Clone, PartialEq)]
pub struct McpServerEntry {
    members: Map<String, Value>,
}

impl McpServerEntry {
    /// The entry holding `members`, as the provider's config writes them.
    pub fn from_members(members: Map<String, Value>) -> Self {
        Self { members }
    }

    /// The entry's members, values included.
    pub fn members(&self) -> &Map<String, Value> {
        &self.members
    }
}

impl fmt::Debug for McpServerEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("McpServerEntry ")?;
        formatter.debug_set().entries(self.members.keys()).finish()
    }
}

/// What the provider's config holds for one binding.
#[derive(Clone, Debug, PartialEq)]
pub enum McpServerObservedEntry {
    /// The config declares no such binding.
    Absent,
    /// The binding's switch, for a binding the daemon only switches.
    Switch(bool),
    /// The binding's declaration.
    Present(McpServerEntry),
}

/// One observation of a binding in the provider's config, with the version and files a write
/// after it is checked against.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerObserved {
    /// What the config holds for the binding.
    pub entry: McpServerObservedEntry,
    /// The version of the user layer of the config, which a write expects; `None` where the
    /// provider versions no layer.
    pub config_version: Option<String>,
    /// The paths of the config's layers as the provider reports them; empty where it reports none.
    pub config_files: Vec<String>,
}

/// One write to the provider's own config.
#[derive(Clone, Debug, PartialEq)]
pub enum McpServerWrite {
    /// Adds the binding or changes its declaration.
    Upsert {
        /// The binding written.
        binding: McpWritableBindingRef,
        /// The entry the provider holds once the write lands, composed by the driver before it.
        entry: McpServerEntry,
    },
    /// Removes the binding's declaration.
    Remove {
        /// The binding removed.
        binding: McpWritableBindingRef,
    },
    /// Switches the binding on or off where the provider's config switches it.
    SetEnabled {
        /// The binding switched.
        binding: McpServerBindingRef,
        /// Whether it is switched on.
        is_enabled: bool,
    },
}

/// How a write to the provider's config ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpServerWriteOutcome {
    /// The provider holds the write.
    Applied {
        /// Why the provider's running service did not reload its servers after the write, in
        /// words with no config value; `None` where it reloaded. The write stands either way, and
        /// a service that did not reload reads it at its next start.
        reload_failure: Option<String>,
    },
    /// The provider surely does not hold the write.
    Refused(McpServerWriteRefusal),
    /// The write may or may not have landed, so the binding is observed again to tell.
    Unknown,
}

/// Why the provider surely does not hold a write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpServerWriteRefusal {
    /// The provider's own command or reply refused the write.
    Provider {
        /// The provider's words, with no config value.
        words: String,
    },
    /// The config's version moved past the one the write expected.
    StaleVersion {
        /// The version the write expected.
        expected_version: String,
        /// The version the provider holds.
        current_version: String,
    },
    /// The provider's config file no longer holds what the daemon last read, so it was left as
    /// it was.
    ConfigFileChanged,
    /// The binding's entry changed after it was observed, so it was left as it was.
    EntryChanged,
    /// Another writer held the config file past the wait for it, or the edit's hold on it ran past
    /// its bound, so nothing was written.
    ConfigFileBusy,
    /// The provider refused the entry the write composed.
    EntryInvalid {
        /// The provider's words, with no config value.
        words: String,
    },
    /// The config file does not parse, so nothing was written to it.
    ConfigFileInvalid {
        /// The provider's words, with no config value.
        words: String,
    },
}

/// `words`, a provider's own words about a write, with every `"…"` and backtick span replaced by
/// `…`, then its credentials and paths redacted, since a provider quotes the values and key paths
/// it refuses. Every [`McpServerWriteRefusal`] word goes through it.
pub fn provider_words_without_values(words: &str) -> String {
    let elided = QUOTED_SPAN.replace_all(words, ELIDED_SPAN);
    redact_paths(&scrub_credentials(&elided))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::McpServerEntry;

    /// An entry's `Debug` names its members and prints none of their values.
    #[test]
    fn an_entry_debug_prints_no_value() {
        let members = json!({ "command": "npx", "env": { "GITHUB_TOKEN": "ghp-secret" } });
        let entry = McpServerEntry::from_members(
            serde_json::from_value(members).expect("the test's entry is an object"),
        );
        let printed = format!("{entry:?}");
        assert!(printed.contains("env"));
        assert!(!printed.contains("ghp-secret"));
    }
}
