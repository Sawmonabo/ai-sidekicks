//! A standing rule a provider keeps on its asks, and the kind of action it covers, as the approval
//! store writes both.

use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use strum::IntoStaticStr;

/// The kind of action a held call would take, without its subject, as a standing rule names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum ProviderAskActionKind {
    /// Run a command.
    Command,
    /// Send input to the running command the ask's tool call names.
    CommandInput,
    /// Change files.
    FileChange,
    /// Read one file or folder.
    FileRead,
    /// Reach a host.
    Network,
    /// Call a tool none of the others covers.
    Tool,
}

/// A standing rule the provider keeps: an allow made on an approval or a host's block made on a
/// network decline, for the session or in the project's own rule file. `subject` is the words the
/// card named, of the kind of action the ask was: a command's program and first subcommand, a
/// file's path, a host, or a tool's name.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ProviderAskRule {
    /// The rule's reach.
    pub(crate) kind: RememberedScopeKind,
    /// Whether it allows or blocks.
    pub(crate) sense: RememberedRuleSense,
    /// The kind of action it covers.
    pub(crate) action: ProviderAskActionKind,
    /// The words the card named.
    pub(crate) subject: String,
}
