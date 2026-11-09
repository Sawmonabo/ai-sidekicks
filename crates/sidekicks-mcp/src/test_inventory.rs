//! An inventory over a test's providers with the real binding store, status tracker, probe gate
//! and attribution table under it, no project holding a session, for the crate's tests.

use std::sync::Arc;

use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::project::test_doubles::NoSessions;

use crate::binding::resolver::McpAttributionTable;
use crate::binding::store::{McpBindingStore, open_first_observation_drain};
use crate::inventory_service::{McpInventoryService, McpInventorySources};
use crate::status::McpServerStatusTracker;
use crate::status::machine_probe::McpMachineProbeGate;
use crate::status::notices::McpNoticeBoard;

/// A test's inventory and the parts under it a test drives or reads.
pub(crate) struct McpTestInventory {
    /// The inventory service.
    pub(crate) service: Arc<McpInventoryService>,
    /// The status tracker, sending on the board the inventory was opened with.
    pub(crate) tracker: Arc<McpServerStatusTracker>,
    /// The attribution table the inventory replaces at each read.
    pub(crate) attribution: Arc<McpAttributionTable>,
    /// The gate the machine probes run through.
    pub(crate) probe_gate: Arc<McpMachineProbeGate>,
}

/// The inventory over `providers`, its binding store writing through `writer` and reading on
/// `reads`, its tracker sending on `board`; the store's first-observation drain runs until the
/// tracker drops.
pub(crate) async fn open_test_inventory(
    providers: Arc<ProviderRegistry>,
    writer: Arc<DatabaseWriter>,
    reads: Arc<DatabaseReadPool>,
    board: Arc<McpNoticeBoard>,
) -> McpTestInventory {
    let store = McpBindingStore::new(writer, Arc::clone(&reads));
    let (outlet, drain) = open_first_observation_drain(store.clone()).await;
    tokio::spawn(drain);
    let tracker = Arc::new(McpServerStatusTracker::new(board, outlet));
    let attribution = Arc::new(McpAttributionTable::default());
    let probe_gate = Arc::new(McpMachineProbeGate::default());
    let service = Arc::new(McpInventoryService::new(McpInventorySources {
        providers,
        reads: Arc::clone(&reads),
        projects: Arc::new(ProjectRecords::new(reads, Arc::new(NoSessions))),
        store,
        tracker: Arc::clone(&tracker),
        attribution: Arc::clone(&attribution),
        probe_gate: Arc::clone(&probe_gate),
    }));
    McpTestInventory {
        service,
        tracker,
        attribution,
        probe_gate,
    }
}
