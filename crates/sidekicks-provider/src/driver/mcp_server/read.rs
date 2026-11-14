//! The read of a provider's MCP servers: what the daemon asks a driver, and what the driver
//! answers. Nothing here holds a secret value: a declaration crosses redacted, and a probed
//! server's declaration is re-read inside the driver, never sent in the request.

use std::collections::BTreeMap;
use std::fmt;

use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::inventory::McpOverrideOrigin;
use sidekicks_contracts::mcp::server::{
    McpApprovalMode, McpServerBindingRef, McpServerName, McpToolName,
};
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
    /// The provider's accounts whose own config files the driver reads for what they switch off,
    /// whether or not their connectors are asked for or answer; reading them starts no process.
    pub config_file_account_ids: Vec<ProviderAccountId>,
    /// Whether the person asked for a refresh, so the driver reads again what it keeps between
    /// reads.
    pub is_refresh: bool,
    /// The bindings the driver starts in a process of its own and reads once.
    pub probe: McpProbeScope,
    /// The `local` bindings the daemon's store keeps that the provider's config cannot declare,
    /// each served from the person's entry of the same name that is off by default, which a
    /// driver probes at the binding's root in place of that entry.
    pub emulated_local_bindings: Vec<McpServerBindingRef>,
}

/// Which of its bindings a driver's read probes; the driver builds each probe's start from its own
/// declarations.
#[derive(Clone, Debug, PartialEq)]
pub enum McpProbeScope {
    /// No probe runs.
    None,
    /// Every binding the driver declares that its probe can start.
    EveryBinding,
    /// The named bindings among those.
    Bindings(Vec<McpServerBindingRef>),
}

impl McpProbeScope {
    /// Whether the scope takes `binding`.
    pub(crate) fn contains(&self, binding: &McpServerBindingRef) -> bool {
        match self {
            Self::None => false,
            Self::EveryBinding => true,
            Self::Bindings(bindings) => bindings.contains(binding),
        }
    }
}

/// One binding the probe starts, and what the provider must be sent to start it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct McpProbeTarget {
    /// The binding.
    pub(crate) binding: McpServerBindingRef,
    /// What the provider must be sent to start it.
    pub(crate) start: McpProbeStart,
}

/// What a probe sends the provider to start one binding. The declaration never travels with it:
/// where one is sent, the driver re-reads it from where it lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpProbeStart {
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
    /// Where another declaration takes this one's place: a project root, or the settings file or
    /// the administrator's layer in no file whose entry overrides it field by field.
    pub superseded_in: Vec<McpOverrideOrigin>,
    /// Where it is switched off: the project roots where the provider's own per-project list
    /// switches it off, or the settings file or administrator's layer whose entry does.
    pub disabled_in: Vec<McpOverrideOrigin>,
    /// Whether the person cannot write it, since the provider or an administrator owns it.
    pub is_read_only: bool,
    /// The sign-in settings the declaration names, where it names any.
    pub sign_in_settings: Option<McpServerSignInSettings>,
    /// Whether the daemon keeps the binding's switch in its own store, since the provider's own
    /// config has none for it; the provider's `enabled` member is its switch otherwise.
    pub is_switch_kept_by_daemon: bool,
    /// The values the declaration gives its server's tools, which clearing an override returns
    /// to.
    pub tool_defaults: McpServerToolDefaults,
    /// Whether the account's organization manages a connector's sign-in, as the provider's own
    /// connector list reads it; `None` for every other server and where the list was not read.
    pub organization_managed: Option<bool>,
}

/// The values a declaration gives its server's tools: whether each is on, and its approval mode.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerToolDefaults {
    /// The approval mode of a tool the declaration names none for.
    pub approval_mode: McpApprovalMode,
    /// Each tool's own approval mode, where the declaration names one.
    pub tool_approval_modes: BTreeMap<McpToolName, McpApprovalMode>,
    /// The tools the declaration allows; `None` where it allows every tool.
    pub enabled_tools: Option<Vec<McpToolName>>,
    /// The tools the declaration denies, applied after the allow list.
    pub disabled_tools: Vec<McpToolName>,
}

impl McpServerToolDefaults {
    /// Defaults that give every tool `approval_mode` and switch none off.
    pub fn with_approval_mode(approval_mode: McpApprovalMode) -> Self {
        Self {
            approval_mode,
            tool_approval_modes: BTreeMap::new(),
            enabled_tools: None,
            disabled_tools: Vec::new(),
        }
    }

    /// Whether the declaration leaves `tool` on: allowed, where an allow list is set, and not
    /// denied.
    pub fn is_tool_enabled(&self, tool: &McpToolName) -> bool {
        self.enabled_tools
            .as_ref()
            .is_none_or(|allowed| allowed.contains(tool))
            && !self.disabled_tools.contains(tool)
    }

    /// The approval mode the declaration gives `tool`.
    pub fn tool_approval_mode(&self, tool: &McpToolName) -> McpApprovalMode {
        self.tool_approval_modes
            .get(tool)
            .copied()
            .unwrap_or(self.approval_mode)
    }
}

/// The sign-in settings a declaration names: the owner's client, its callback, and where the
/// authorization server's metadata is read; never the client's secret.
#[derive(Clone, PartialEq, Eq)]
pub struct McpServerSignInSettings {
    /// The client's id, presented at sign-in.
    pub client_id: Option<String>,
    /// The callback address registered for the client, whole; a driver whose provider derives
    /// its callback from more than the entry answers it at the sign-in in place of this.
    pub callback_url: Option<String>,
    /// The address of the authorization server's metadata, read in place of discovery, as the
    /// entry writes it; `Debug` says only whether one is set, since it may carry a secret.
    pub authorization_server_metadata_url: Option<String>,
    /// Whether the sign-in also asks for `offline_access` where the authorization server's
    /// metadata lists it.
    pub asks_offline_access_where_listed: bool,
}

impl fmt::Debug for McpServerSignInSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpServerSignInSettings")
            .field("client_id", &self.client_id)
            .field("callback_url", &self.callback_url)
            .field(
                "has_authorization_server_metadata_url",
                &self.authorization_server_metadata_url.is_some(),
            )
            .field(
                "asks_offline_access_where_listed",
                &self.asks_offline_access_where_listed,
            )
            .finish()
    }
}

/// What a driver read at one attached root.
#[derive(Clone, Debug, PartialEq)]
pub struct McpRootReading {
    /// The root, with the distribution it is in.
    pub root: PlacedPath,
    /// The names of every server declared for this root, in any layer, that its sessions never
    /// load; none of them is in `provider_loaded`.
    pub kept_out_server_names: Vec<McpServerName>,
    /// The bindings the provider loads at this root by its own config, as the inventory read of
    /// the person's own folder finds them, in the provider's precedence order, highest layer
    /// first: a reader takes the first binding of a name as the one loaded. A session's own tool
    /// servers resolve through its set first.
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
    /// A remote server whose address matches this pattern, kept as written with its credentials
    /// scrubbed.
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
    /// The provider's error text for the server, sanitized and cut to a bound.
    pub failure_text: Option<String>,
    /// The names of the server's tools.
    pub tool_names: Vec<McpToolName>,
}
