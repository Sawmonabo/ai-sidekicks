//! The set of tool servers a session opens with: every binding the person has at user scope and
//! at the project scope of the session's root, `local` ones included, each switched as its own
//! switch and its project's switch read, composed from what the attribution table last read of the
//! provider's own config and what the binding store keeps, with no driver read. An opening waits
//! on the table's first fill of the provider, so no set is composed from a table not yet read.

use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::inventory::McpOverrideOrigin;
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_provider::driver::session_control::SessionToolServer;
use sidekicks_workspace::project::records::AttachedProjectRoot;

use crate::binding::resolver::{
    McpAttributionTable, McpBindingRow, McpFirstFill, attached_root_path, resolve_declared_rows,
};
use crate::binding::store::{McpBindingStore, McpBindingStoreError};

/// The longest an opening waits on the table's first fill of its provider: the bound the fill's
/// read itself runs under, a provider's service start included.
const FIRST_FILL_BOUND: Duration = Duration::from_secs(30);

/// Why a session's set of tool servers could not be composed.
#[derive(Debug, thiserror::Error)]
pub enum McpSessionToolServersError {
    /// The daemon's first read of the provider's tool servers failed, so which of them the session
    /// runs is not known.
    #[error("the provider's tool servers could not be read, so the session's set is not known")]
    ProviderUnread,
    /// The daemon's first read of the provider's tool servers did not end within its bound.
    #[error("the provider's tool servers were not read in time, so the session's set is not known")]
    ProviderReadPending,
    /// The session's project root is no path the wire carries.
    #[error("the session's project root is no path its tool servers can be read at")]
    RootPath(#[source] TextError),
    /// The binding store's rows could not be read.
    #[error(transparent)]
    Store(#[from] McpBindingStoreError),
}

/// Composes the set of tool servers a session opens with, from the attribution table and the
/// binding store.
pub struct McpSessionToolServers {
    table: Arc<McpAttributionTable>,
    store: McpBindingStore,
}

impl McpSessionToolServers {
    /// A composer reading `table` and `store`.
    pub fn new(table: Arc<McpAttributionTable>, store: McpBindingStore) -> Self {
        Self { table, store }
    }

    /// The set a session of `provider` at `root`, none for a chat, opens with: each binding of
    /// the provider's own config the table last read at user scope, and at project or `local`
    /// scope of `root`, switched on where its own switch is on and neither the provider nor the
    /// daemon switches it off in `root`, once the table's first fill of the provider ended. Fails
    /// where that fill's read failed or did not end within its bound, and as the root's path or
    /// the store's one short read fails.
    pub async fn compose(
        &self,
        provider: &ProviderId,
        root: Option<&AttachedProjectRoot>,
    ) -> Result<Vec<SessionToolServer>, McpSessionToolServersError> {
        match tokio::time::timeout(FIRST_FILL_BOUND, self.table.wait_for_first_fill(provider)).await
        {
            Ok(McpFirstFill::Filled) => {}
            Ok(McpFirstFill::Failed) => return Err(McpSessionToolServersError::ProviderUnread),
            Err(_elapsed) => return Err(McpSessionToolServersError::ProviderReadPending),
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
                .filter(|row| is_in_session_scope(&row.declaration.binding, root.as_ref()))
                .map(|row| SessionToolServer {
                    is_enabled: is_switched_on(&row, root.as_ref()),
                    binding: row.declaration.binding,
                })
                .collect(),
        )
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

// Whether `row`'s own switch is on and neither the provider's per-project list nor the daemon's
// per-project switch takes it off in `root`.
fn is_switched_on(row: &McpBindingRow, root: Option<&PlacedPath>) -> bool {
    let is_switched_off_in_root = root.is_some_and(|root| {
        row.declaration
            .disabled_in
            .contains(&McpOverrideOrigin::Placed(root.clone()))
            || row
                .stored
                .as_ref()
                .is_some_and(|stored| stored.switched_off_in.contains(root))
    });
    row.own_switch() == Some(true) && !is_switched_off_in_root
}
