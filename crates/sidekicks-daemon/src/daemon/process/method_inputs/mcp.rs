//! The MCP services the start builds: first, over the store, the binding store with the drain
//! that records each binding first observed, the notice board, the attribution table, the status
//! tracker and the composer of a session's tool servers; then, over the project records, the
//! inventory; last, over the session events' appender, the sign-in service, the sign-outs a
//! binding's removal owes, the binding edits' service that owes them and the sign-in commands.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_mcp::binding::resolver::McpAttributionTable;
use sidekicks_mcp::binding::session_tool_servers::McpSessionToolServers;
use sidekicks_mcp::binding::store::{McpBindingStore, open_first_observation_drain};
use sidekicks_mcp::inventory_service::{McpInventoryService, McpInventorySources};
use sidekicks_mcp::mutation::service::{McpMutationService, McpMutationSources};
use sidekicks_mcp::sign_in::admitted_client::AdmittedClientStore;
use sidekicks_mcp::sign_in::commands::McpSignInCommands;
use sidekicks_mcp::sign_in::credential_store::SignInCustody;
use sidekicks_mcp::sign_in::oauth_http_client::OAuthHttpPools;
use sidekicks_mcp::sign_in::registration::RELAY_ADDRESS;
use sidekicks_mcp::sign_in::server::SignInTargetReads;
use sidekicks_mcp::sign_in::service::SignInService;
use sidekicks_mcp::sign_in::sign_out::owed::OwedSignOuts;
use sidekicks_mcp::status::McpServerStatusTracker;
use sidekicks_mcp::status::machine_probe::McpMachineProbeGate;
use sidekicks_mcp::status::notices::McpNoticeBoard;
use sidekicks_provider::driver::ProviderAccountReader;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
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

/// What the inventory is built over, beside the MCP services.
pub(super) struct McpGovernanceStart<'start> {
    /// The registered drivers.
    pub(super) providers: &'start Arc<ProviderRegistry>,
    /// The project records the inventory reads the attached roots from.
    pub(super) projects: &'start Arc<ProjectRecords>,
    /// The daemon's one read pool.
    pub(super) reads: &'start Arc<DatabaseReadPool>,
}

impl McpStatusServices {
    /// Builds the inventory over these services and `start`.
    pub(super) fn build_governance(
        &self,
        start: &McpGovernanceStart<'_>,
    ) -> Arc<McpInventoryService> {
        Arc::new(McpInventoryService::new(McpInventorySources {
            providers: Arc::clone(start.providers),
            reads: Arc::clone(start.reads),
            projects: Arc::clone(start.projects),
            store: self.store.clone(),
            tracker: Arc::clone(&self.status),
            attribution: Arc::clone(&self.attribution),
            probe_gate: Arc::new(McpMachineProbeGate::default()),
        }))
    }
}

/// What the sign-ins to MCP servers and the binding edits' service are built over, beside the
/// inventory.
pub(crate) struct McpSignInStart<'start> {
    /// The registered drivers, whose own clients sign in where the daemon's cannot.
    pub(crate) providers: &'start Arc<ProviderRegistry>,
    /// The inventory a sign-in's target and each edit's row are read from.
    pub(crate) inventory: &'start Arc<McpInventoryService>,
    /// The board each committed edit's notice is sent on.
    pub(crate) board: &'start Arc<McpNoticeBoard>,
    /// The port the provider accounts' reader is registered on.
    pub(crate) provider_accounts: &'start Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    /// The machine's settings, whose environment rows fill a server address's variables.
    pub(crate) settings: &'start Arc<dyn MachineSettingsReader>,
    /// The project records, whose roots and rows a target reads.
    pub(crate) projects: &'start Arc<ProjectRecords>,
    /// Where the sign-ins and the receipt key are kept.
    pub(crate) secret_items: &'start Arc<SecretItems>,
    /// The daemon's one writer.
    pub(crate) writer: &'start Arc<DatabaseWriter>,
    /// The daemon's one read pool.
    pub(crate) reads: &'start Arc<DatabaseReadPool>,
    /// Where each settled sign-in appends its completion event.
    pub(crate) appender: &'start Arc<SessionEventAppender>,
}

/// The sign-ins to MCP servers: the service the stop closes, the sign-outs a removal owes, which
/// the start settles, the binding edits' service and the commands the methods forward to.
pub(crate) struct McpSignIns {
    /// The service, which holds each open attempt.
    pub(crate) service: Arc<SignInService>,
    /// The sign-outs the bindings' removals owe.
    pub(crate) owed_sign_outs: Arc<OwedSignOuts>,
    /// The binding edits' service, each removal owing its server's sign-out.
    pub(crate) mutations: Arc<McpMutationService>,
    /// The receipted sign-in and sign-out commands.
    pub(crate) commands: Arc<McpSignInCommands>,
}

/// Builds the sign-in service, the sign-outs a removal owes, the binding edits' service over them
/// and the sign-in commands over `start`, and starts the service's seed of the signed-in servers
/// from the keychain. Fails when the sign-ins' HTTP pools cannot be built.
pub(crate) fn build_sign_ins(start: &McpSignInStart<'_>) -> Result<McpSignIns, reqwest::Error> {
    let custody = SignInCustody::new(Arc::new(
        start.secret_items.keychain(KeychainService::McpSignIns),
    ));
    let admitted_clients = Arc::new(AdmittedClientStore::new(
        Arc::clone(start.reads),
        Arc::clone(start.writer),
    ));
    let service = SignInService::new(
        custody,
        admitted_clients,
        Arc::clone(start.providers),
        OAuthHttpPools::new()?,
        &RELAY_ADDRESS,
        Arc::clone(start.appender),
    );
    service.start_signed_in_seed();
    let target_reads = || {
        SignInTargetReads::new(
            Arc::clone(start.inventory),
            Arc::clone(start.providers),
            Arc::clone(start.provider_accounts),
            Arc::clone(start.settings),
            Arc::clone(start.projects),
        )
    };
    let owed_sign_outs = OwedSignOuts::new(
        Arc::clone(&service),
        target_reads(),
        Arc::clone(start.reads),
        Arc::clone(start.writer),
    );
    let mutations = Arc::new(
        McpMutationService::new(McpMutationSources {
            providers: Arc::clone(start.providers),
            inventory: Arc::clone(start.inventory),
            keychain: Arc::new(start.secret_items.keychain(KeychainService::McpReceiptKey)),
            writer: Arc::clone(start.writer),
            reads: Arc::clone(start.reads),
            removal_rows: None,
            board: Arc::clone(start.board),
        })
        .with_removal_sign_out(Arc::clone(&owed_sign_outs) as _),
    );
    Ok(McpSignIns {
        commands: Arc::new(McpSignInCommands::new(
            Arc::clone(&mutations),
            Arc::clone(&service),
            target_reads(),
            Arc::clone(&owed_sign_outs),
        )),
        service,
        owed_sign_outs,
        mutations,
    })
}
