//! The read of a provider's MCP servers: what the daemon asks a driver, and what the driver
//! answers. Nothing here holds a secret value: a declaration crosses redacted, and a probed
//! server's declaration is re-read inside the driver, never sent in the request.

use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpToolName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::mcp_server::status::McpServerReading;

/// What the daemon asks a driver to read about its provider's MCP servers.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServersReadRequest {
    /// The attached project roots, each with the distribution it is in.
    pub attached_roots: Vec<PlacedPath>,
    /// The provider's accounts, whose connectors and organization servers the driver reads.
    pub provider_account_ids: Vec<ProviderAccountId>,
    /// Whether the person asked for a refresh, so the driver reads again what it keeps between
    /// reads.
    pub is_refresh: bool,
    /// The bindings the driver starts in a process of its own and reads once; empty when no
    /// probe is asked for.
    pub probe_targets: Vec<McpProbeTarget>,
}

/// One binding the probe starts, and what the provider must be sent to start it.
#[derive(Clone, Debug, PartialEq)]
pub struct McpProbeTarget {
    /// The binding.
    pub binding: McpServerBindingRef,
    /// What the provider must be sent to start it.
    pub start: McpProbeStart,
}

/// What a probe sends the provider to start one binding. The declaration never travels with it:
/// where one is sent, the driver re-reads it from where it lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpProbeStart {
    /// The provider loads it by its own config at the binding's root; nothing is sent.
    LoadedByProvider,
    /// Its entry in the person's config is off by default and is switched on by its name.
    SwitchedOnByName,
    /// The driver sends its declaration in the process's set of servers.
    DeclarationSent,
}

/// What a driver read about its provider's MCP servers.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderMcpServersReading {
    /// Each server the provider's config, its project roots' files and its plugins declare.
    pub declarations: Vec<McpServerDeclaration>,
    /// What the driver read at each attached root.
    pub roots: Vec<McpRootReading>,
    /// Whether an administrator's file on this computer takes over which servers the provider
    /// loads.
    pub is_machine_managed: bool,
    /// The allow and deny lists that bound which servers the provider may load.
    pub server_policy: McpServerPolicy,
    /// The servers each account brings: its connectors and its organization's servers.
    pub account_servers: Vec<McpAccountServers>,
    /// What the probe read for each binding it started; empty when no probe was asked for.
    pub probe_readings: Vec<McpProbeReading>,
}

/// One server declaration, redacted.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerDeclaration {
    /// The binding it declares.
    pub binding: McpServerBindingRef,
    /// The declaration with every credential-bearing value reduced to its name.
    pub config: McpServerConfigView,
    /// Where another declaration takes this one's place: a project root, or the settings file
    /// whose entry overrides it field by field.
    pub superseded_in: Vec<PlacedPath>,
    /// The project roots where the provider's own per-project list switches it off.
    pub disabled_in: Vec<PlacedPath>,
    /// Whether the person cannot write it, since the provider or an administrator owns it.
    pub is_read_only: bool,
    /// The sign-in client the declaration names, where it names one.
    pub sign_in_client: Option<McpServerSignInClient>,
}

/// The sign-in client a declaration names: never its secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerSignInClient {
    /// The client's id, presented at sign-in.
    pub client_id: Option<String>,
    /// The callback address registered for the client.
    pub callback_url: Option<String>,
}

/// What a driver read at one attached root.
#[derive(Clone, Debug, PartialEq)]
pub struct McpRootReading {
    /// The root, with the distribution it is in.
    pub root: PlacedPath,
    /// The names of the project's servers kept out of its sessions.
    pub kept_out_server_names: Vec<McpServerName>,
    /// The bindings a session the provider starts at this root loads by its own config, with no
    /// set sent by the daemon.
    pub provider_loaded: Vec<McpServerBindingRef>,
}

/// The allow and deny lists bounding which servers the provider may load.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct McpServerPolicy {
    /// The servers the provider may load; absent where no allow list is set, and empty where
    /// none may load.
    pub allowed: Option<Vec<McpServerPolicyEntry>>,
    /// The servers the provider never loads.
    pub denied: Vec<McpServerPolicyEntry>,
}

/// One entry of an allow or deny list: the servers it matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpServerPolicyEntry {
    /// A server by name.
    ServerName(McpServerName),
    /// A server started by this command and these arguments.
    Command(Vec<String>),
    /// A remote server whose address matches this pattern, its user name, password and query
    /// stripped as an address's are.
    AddressPattern(String),
}

/// The servers one account brings.
#[derive(Clone, Debug, PartialEq)]
pub struct McpAccountServers {
    /// The account.
    pub provider_account_id: ProviderAccountId,
    /// Its connectors and its organization's servers, each read-only.
    pub declarations: Vec<McpServerDeclaration>,
}

/// What the probe read for one binding it started.
#[derive(Clone, Debug, PartialEq)]
pub struct McpProbeReading {
    /// The binding.
    pub binding: McpServerBindingRef,
    /// What the provider reported.
    pub reading: McpServerReading,
    /// The provider's error text for the server, its credentials scrubbed and cut to a bound.
    pub failure_text: Option<String>,
    /// The names of the server's tools.
    pub tool_names: Vec<McpToolName>,
}

/// The name the provider's config declares `binding`'s server under.
pub(crate) fn binding_server_name(binding: &McpServerBindingRef) -> &McpServerName {
    match binding {
        McpServerBindingRef::User { server_name, .. }
        | McpServerBindingRef::Project { server_name, .. }
        | McpServerBindingRef::Local { server_name, .. }
        | McpServerBindingRef::Plugin { server_name, .. }
        | McpServerBindingRef::Connector { server_name, .. }
        | McpServerBindingRef::Managed { server_name, .. } => server_name,
    }
}
