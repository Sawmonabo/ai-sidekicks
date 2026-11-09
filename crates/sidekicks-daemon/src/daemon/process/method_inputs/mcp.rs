//! The MCP services the start builds: first, over the store, the binding store with the drain
//! that records each binding first observed, the notice board, the attribution table, the status
//! tracker and the composer of a session's tool servers; then, over the project records, the
//! inventory and the binding edits' service.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_mcp::binding::resolver::McpAttributionTable;
use sidekicks_mcp::binding::session_tool_servers::McpSessionToolServers;
use sidekicks_mcp::binding::store::{McpBindingStore, open_first_observation_drain};
use sidekicks_mcp::inventory_service::{McpInventoryService, McpInventorySources};
use sidekicks_mcp::mutation::service::{McpMutationService, McpMutationSources};
use sidekicks_mcp::status::McpServerStatusTracker;
use sidekicks_mcp::status::machine_probe::McpMachineProbeGate;
use sidekicks_mcp::status::notices::McpNoticeBoard;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_workspace::project::records::ProjectRecords;

/// The MCP services the session directory's port, the session services and the methods share.
pub(super) struct McpStatusServices {
    /// Each binding's governance row.
    store: McpBindingStore,
    /// The run that records each binding the status tracker first observes.
    pub(super) first_observations: BoxFuture<'static, ()>,
    /// The board every MCP notice goes out on.
    pub(super) board: Arc<McpNoticeBoard>,
    /// One table, so the inventory's reads refresh what the status producers resolve names by.
    pub(super) attribution: Arc<McpAttributionTable>,
    /// The keeper of every binding's status.
    pub(super) status: Arc<McpServerStatusTracker>,
    /// The set of tool servers each session's opening sends.
    pub(super) session_tool_servers: Arc<McpSessionToolServers>,
}

/// Opens the MCP services over `writer` and `reads`: the status tracker sends each binding it
/// first observes to the drain, which records it.
pub(super) async fn open_mcp_status(
    writer: &Arc<DatabaseWriter>,
    reads: &Arc<DatabaseReadPool>,
) -> McpStatusServices {
    let store = McpBindingStore::new(Arc::clone(writer), Arc::clone(reads));
    let (outlet, first_observations) = open_first_observation_drain(store.clone()).await;
    let board = Arc::new(McpNoticeBoard::default());
    let attribution = Arc::new(McpAttributionTable::default());
    McpStatusServices {
        session_tool_servers: Arc::new(McpSessionToolServers::new(
            Arc::clone(&attribution),
            store.clone(),
        )),
        status: Arc::new(McpServerStatusTracker::new(Arc::clone(&board), outlet)),
        store,
        first_observations: first_observations.boxed(),
        board,
        attribution,
    }
}

/// What the inventory and the binding edits' service are built over, beside the MCP services.
pub(super) struct McpGovernanceStart<'start> {
    /// The registered drivers.
    pub(super) providers: &'start Arc<ProviderRegistry>,
    /// The project records the inventory reads the attached roots from.
    pub(super) projects: &'start Arc<ProjectRecords>,
    /// Where the receipt key is kept.
    pub(super) secret_items: &'start Arc<SecretItems>,
    /// The daemon's one writer.
    pub(super) writer: &'start Arc<DatabaseWriter>,
    /// The daemon's one read pool.
    pub(super) reads: &'start Arc<DatabaseReadPool>,
}

impl McpStatusServices {
    /// Builds the inventory and the binding edits' service over these services and `start`.
    pub(super) fn build_governance(
        &self,
        start: &McpGovernanceStart<'_>,
    ) -> (Arc<McpInventoryService>, Arc<McpMutationService>) {
        let inventory = Arc::new(McpInventoryService::new(McpInventorySources {
            providers: Arc::clone(start.providers),
            reads: Arc::clone(start.reads),
            projects: Arc::clone(start.projects),
            store: self.store.clone(),
            tracker: Arc::clone(&self.status),
            attribution: Arc::clone(&self.attribution),
            probe_gate: Arc::new(McpMachineProbeGate::default()),
        }));
        let mutations = Arc::new(McpMutationService::new(McpMutationSources {
            providers: Arc::clone(start.providers),
            inventory: Arc::clone(&inventory),
            keychain: Arc::new(start.secret_items.keychain(KeychainService::McpReceiptKey)),
            writer: Arc::clone(start.writer),
            reads: Arc::clone(start.reads),
            removal_rows: None,
            board: Arc::clone(&self.board),
        }));
        (inventory, mutations)
    }
}
