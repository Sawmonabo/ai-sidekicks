//! A standing rule a provider keeps on its asks, over the kind of action it covers, as the
//! approval store writes it.

use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_contracts::provider::tool_call::ToolCallActionKind;

/// A standing rule the provider keeps: an allow made on an approval or a host's block made on a
/// network decline, for the session or in the project's own rule file. `subject` is the words the
/// card named, of the kind of action the ask was: a command's program and first subcommand, a
/// file's path, a host, or a tool's name.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ProviderAskRule {
    /// The rule's reach.
    pub kind: RememberedScopeKind,
    /// Whether it allows or blocks.
    pub sense: RememberedRuleSense,
    /// The kind of action it covers.
    pub action: ToolCallActionKind,
    /// The words the card named.
    pub subject: String,
}
