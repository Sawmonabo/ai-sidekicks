//! The names each provider sees for the daemon's own tool servers, where every daemon tool and
//! hook reaches the model, and each provider's rule for which tool-server names a person may write.

use sidekicks_contracts::mcp::server::McpServerName;

/// The daemon's own tool server's name, as every provider session lists it.
pub const DAEMON_TOOL_SERVER_NAME: &str = "sidekicks";

/// The name of the daemon's tool server that carries its hooks, as every provider session lists
/// it.
pub const DAEMON_HOOKS_TOOL_SERVER_NAME: &str = "sidekicks_hooks";

/// A provider's rule for the tool-server names a person may write: the characters it takes, the
/// names it keeps whole, and the part of a name it matches against the names it keeps for itself.
pub struct McpServerNameRule {
    is_allowed_character: fn(char) -> bool,
    allowed_characters: &'static str,
    matched_part: fn(&str) -> Option<&str>,
    reserved_parts: &'static [&'static str],
    reserved_whole: &'static [&'static str],
}

/// Why a provider refuses a tool-server name; its words quote no name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum McpServerNameRefusal {
    /// The name holds a character the provider does not take.
    #[error("the server name may hold only {allowed}")]
    Characters {
        /// The characters the provider takes, in words.
        allowed: &'static str,
    },
    /// The provider keeps the name for a server of its own.
    #[error("the provider keeps this server name for a server of its own")]
    KeptByProvider,
    /// The app keeps the name for its own tool servers.
    #[error("the app keeps this server name for its own tool servers")]
    KeptByDaemon,
}

impl McpServerNameRule {
    /// A rule taking the characters `is_allowed_character` accepts, which `allowed_characters`
    /// names in words, refusing each of `reserved_whole` matched whole and each name whose
    /// `matched_part` is one of `reserved_parts` or a daemon tool server's name.
    pub(crate) const fn new(
        is_allowed_character: fn(char) -> bool,
        allowed_characters: &'static str,
        matched_part: fn(&str) -> Option<&str>,
        reserved_parts: &'static [&'static str],
        reserved_whole: &'static [&'static str],
    ) -> Self {
        Self {
            is_allowed_character,
            allowed_characters,
            matched_part,
            reserved_parts,
            reserved_whole,
        }
    }

    /// Whether the provider takes `name` for a server a person writes; refuses a character it does
    /// not take, then a name it keeps whole, then a matched part it or the daemon keeps.
    pub fn check(&self, name: &McpServerName) -> Result<(), McpServerNameRefusal> {
        let name = name.as_str();
        if !name.chars().all(self.is_allowed_character) {
            return Err(McpServerNameRefusal::Characters {
                allowed: self.allowed_characters,
            });
        }
        if self.reserved_whole.contains(&name) {
            return Err(McpServerNameRefusal::KeptByProvider);
        }
        let Some(part) = (self.matched_part)(name) else {
            return Ok(());
        };
        if self.reserved_parts.contains(&part) {
            return Err(McpServerNameRefusal::KeptByProvider);
        }
        if part == DAEMON_TOOL_SERVER_NAME || part == DAEMON_HOOKS_TOOL_SERVER_NAME {
            return Err(McpServerNameRefusal::KeptByDaemon);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::mcp::server::McpServerName;

    use super::McpServerNameRefusal;
    use crate::driver::descriptor_of;

    const KEPT_BY_PROVIDER: Result<(), McpServerNameRefusal> =
        Err(McpServerNameRefusal::KeptByProvider);
    const KEPT_BY_DAEMON: Result<(), McpServerNameRefusal> =
        Err(McpServerNameRefusal::KeptByDaemon);

    /// Each provider's rule, read through its descriptor, answers each name as the provider's own
    /// validator does, and keeps the daemon's two names through the part it matches.
    #[rstest]
    #[case::claude_workspace("claude", "workspace", KEPT_BY_PROVIDER)]
    #[case::claude_workspace_trailing_underscore("claude", "workspace_", KEPT_BY_PROVIDER)]
    #[case::claude_workspace_before_double_underscore("claude", "workspace__x", KEPT_BY_PROVIDER)]
    #[case::claude_proto("claude", "__proto__", KEPT_BY_PROVIDER)]
    #[case::claude_workspace_with_suffix("claude", "workspace_x", Ok(()))]
    #[case::claude_workspace_capitalized("claude", "Workspace", Ok(()))]
    #[case::claude_empty_part("claude", "__x", Ok(()))]
    #[case::claude_ai_with_suffix("claude", "claude_ai_x", Ok(()))]
    #[case::claude_daemon("claude", "sidekicks", KEPT_BY_DAEMON)]
    #[case::claude_daemon_trailing_underscore("claude", "sidekicks_", KEPT_BY_DAEMON)]
    #[case::claude_daemon_hooks("claude", "sidekicks_hooks", KEPT_BY_DAEMON)]
    #[case::claude_dot("claude", "a.b", Err(McpServerNameRefusal::Characters {
        allowed: "letters, digits, hyphens and underscores",
    }))]
    #[case::codex_dot("codex", "a.b", Ok(()))]
    #[case::codex_scoped_package("codex", "@scope/pkg:1", Ok(()))]
    #[case::codex_apps_with_suffix("codex", "codex_apps_x", Ok(()))]
    #[case::codex_daemon_trailing_underscore("codex", "sidekicks_", Ok(()))]
    #[case::codex_apps("codex", "codex_apps", KEPT_BY_PROVIDER)]
    #[case::codex_daemon("codex", "sidekicks", KEPT_BY_DAEMON)]
    #[case::codex_space("codex", "a b", Err(McpServerNameRefusal::Characters {
        allowed: "letters, digits, hyphens, underscores, colons, at signs, slashes and dots",
    }))]
    fn a_provider_checks_a_server_name_by_its_own_rule(
        #[case] provider: &str,
        #[case] name: &str,
        #[case] expected: Result<(), McpServerNameRefusal>,
    ) {
        let rule = &descriptor_of(provider)
            .expect("the provider is in the table")
            .mcp_server_names;
        let name = McpServerName::new(name.to_owned()).expect("a server name");
        assert_eq!(rule.check(&name), expected);
    }
}
