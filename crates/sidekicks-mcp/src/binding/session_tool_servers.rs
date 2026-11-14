//! The set of tool servers a session opens with: every binding the person has at user scope and
//! at the project scope of the session's root, `local` ones included, each switched as its own
//! switch reads, and none the provider's own per-project switch keeps out of the root, composed
//! from what the attribution table last read of the provider's own config and what the binding
//! store keeps. An opening waits on the table's first fill of the provider, so no set is composed
//! from a table not yet read; where that fill failed, the openings that meet it share one read of
//! the provider.

use std::sync::Arc;

use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::inventory::McpOverrideOrigin;
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_provider::driver::session_control::SessionToolServer;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::port_registration::{PortRegistration, PortRegistrationError};
use sidekicks_workspace::project::records::AttachedProjectRoot;

use crate::binding::resolver::{
    McpAttributionTable, McpBindingRow, McpFirstFill, attached_root_path, resolve_declared_rows,
};
use crate::binding::store::{McpBindingStore, McpBindingStoreError};
use crate::inventory_service::{McpInventoryError, McpInventoryService};

/// Why a session's set of tool servers could not be composed.
#[derive(Debug, thiserror::Error)]
pub enum McpSessionToolServersError {
    /// The daemon's first read of the provider's tool servers failed and the opening's own read
    /// failed too, so which of them the session runs is not known.
    #[error("the provider's tool servers could not be read, so the session's set is not known")]
    ProviderUnread(#[source] McpInventoryError),
    /// The inventory the opening reads the provider through is not registered yet.
    #[error(transparent)]
    Inventory(#[from] PortRegistrationError),
    /// The session's project root is no path the wire carries.
    #[error("the session's project root is no path its tool servers can be read at")]
    RootPath(#[source] TextError),
    /// The binding store's rows could not be read.
    #[error(transparent)]
    Store(#[from] McpBindingStoreError),
}

/// Composes the set of tool servers a session opens with, from the attribution table and the
/// binding store, reading a provider through the inventory where the table's first fill of it
/// failed.
pub struct McpSessionToolServers {
    table: Arc<McpAttributionTable>,
    store: McpBindingStore,
    inventory: PortRegistration<Arc<McpInventoryService>>,
    // Each provider's hold over the one read that refills the table after its failed fill.
    refills: KeyedLock<ProviderId>,
}

impl McpSessionToolServers {
    /// A composer reading `table` and `store`, its inventory registered once it is built.
    pub fn new(table: Arc<McpAttributionTable>, store: McpBindingStore) -> Self {
        Self {
            table,
            store,
            inventory: PortRegistration::new("MCP inventory"),
            refills: KeyedLock::new(),
        }
    }

    /// Registers the inventory over the same table, which an opening reads a provider through
    /// where the first fill of it failed. Fails where one is registered already.
    pub fn register_inventory(
        &self,
        inventory: Arc<McpInventoryService>,
    ) -> Result<(), PortRegistrationError> {
        self.inventory.register(inventory)
    }

    /// The set a session of `provider` at `root`, none for a chat, opens with: each binding of
    /// the provider's own config the table last read at user scope, and at project or `local`
    /// scope of `root`, but for one the provider's own per-project switch turns off in `root`,
    /// each switched on where its own switch is on, once the table's first fill of the provider
    /// ended; where that fill failed, after one read of the provider through the inventory, which
    /// refills the table for every opening waiting on it. Fails where that read fails too, and as
    /// the root's path or the store's one short read fails.
    pub async fn compose(
        &self,
        provider: &ProviderId,
        root: Option<&AttachedProjectRoot>,
    ) -> Result<Vec<SessionToolServer>, McpSessionToolServersError> {
        match self.table.wait_for_first_fill(provider).await {
            McpFirstFill::Filled => {}
            McpFirstFill::Failed => self.refill(provider).await?,
        }
        let root = root
            .map(attached_root_path)
            .transpose()
            .map_err(McpSessionToolServersError::RootPath)?;
        let declarations = self.table.config_declarations(provider);
        let stored = self.store.read_provider_bindings(provider).await?;
        Ok(
            resolve_declared_rows(declarations.iter().collect(), Some(&stored))
                .into_iter()
                .filter(|row| {
                    is_in_session_scope(&row.declaration.binding, root.as_ref())
                        && !is_switched_off_in(row, root.as_ref())
                })
                .map(|row| SessionToolServer {
                    is_enabled: row.own_switch() == Some(true),
                    binding: row.declaration.binding,
                })
                .collect(),
        )
    }

    // Reads `provider` through the inventory under its hold, unless an opening that held it first
    // already refilled the table, so the openings that meet one failed fill share one read.
    async fn refill(&self, provider: &ProviderId) -> Result<(), McpSessionToolServersError> {
        let _hold = self.refills.acquire(provider.clone()).await;
        if self.table.wait_for_first_fill(provider).await == McpFirstFill::Filled {
            return Ok(());
        }
        self.inventory
            .require_port()?
            .read_declarations(provider)
            .await
            .map_err(McpSessionToolServersError::ProviderUnread)?;
        Ok(())
    }
}

// Whether `binding` is the person's at user scope, or at project or `local` scope of `root`.
fn is_in_session_scope(binding: &McpServerBindingRef, root: Option<&PlacedPath>) -> bool {
    match binding {
        McpServerBindingRef::User { .. } => true,
        McpServerBindingRef::Project {
            scope_ref, place, ..
        }
        | McpServerBindingRef::Local {
            scope_ref, place, ..
        } => root.is_some_and(|root| root.path == *scope_ref && root.place == *place),
        McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => false,
    }
}

// Whether the provider's own per-project switch turns `row` off in `root`, which keeps it out of
// every session there: such a server has no row in the session and no switch to press.
fn is_switched_off_in(row: &McpBindingRow, root: Option<&PlacedPath>) -> bool {
    root.is_some_and(|root| {
        row.declaration
            .disabled_in
            .contains(&McpOverrideOrigin::Placed(root.clone()))
    })
}
