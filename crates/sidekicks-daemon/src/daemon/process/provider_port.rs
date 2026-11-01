//! The session directory's answers to the providers as the daemon's start builds them: the project
//! records its reads share, the port that resolves each provider process's spawn context and
//! records each relaunch, and the queue's composer of a session's opening with each binding's
//! function legs.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_mcp::binding::resolver::McpAttributionTable;
use sidekicks_mcp::status::McpServerStatusTracker;
use sidekicks_provider::driver::SessionSpawnContextResolver;
use sidekicks_provider::driver::ports::{DriverPorts, SessionRelaunchListener};
use sidekicks_queue::provider_session::{
    GitFolderReadError, ProviderSessionGitFolderReader, ProviderSessionOpening,
    ProviderSessionOpeningComposer,
};
use sidekicks_session::directory::provider_port::{
    SessionDirectoryProviderPort, SessionDirectoryProviderPortDeps, SessionGitFolder,
};
use sidekicks_session::directory::run_activity::ProjectSessionActivityReader;
use sidekicks_session::plan_holds::PlanHolds;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_std::port_registration::PortRegistrationError;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::ProjectRecords;

/// What the session directory's port is built from.
pub(crate) struct ProviderPortStart<'start> {
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// Where each damaged session's log stops being readable.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// Each run's binding cursors, which a relaunch opens and records through.
    pub(crate) binding_cursors: Arc<RunBindingCursors>,
    /// The daemon's git.
    pub(crate) git: GitRunner,
    /// The machine's settings file.
    pub(crate) settings: Arc<dyn MachineSettingsReader>,
    /// The plan store's holds, the same the session list and the run engine read.
    pub(crate) plan_holds: &'start dyn PlanHolds,
    /// The ports the drivers read, on which the port registers.
    pub(crate) ports: &'start DriverPorts,
    /// The keeper of every MCP binding's status, on which each process's leg is opened.
    pub(crate) mcp_status: Arc<McpServerStatusTracker>,
    /// Which binding each server name a session reports resolves to at its root.
    pub(crate) mcp_attribution: Arc<McpAttributionTable>,
}

/// The session directory's answers to the providers, and the project records they read.
pub(crate) struct ProviderPort {
    /// The project records, shared by the project service, the projects list and the port.
    pub(crate) project_records: Arc<ProjectRecords>,
    /// Composes a session's opening from its lead, for the queue.
    pub(crate) compose_opening: ProviderSessionOpeningComposer,
    /// Reads a session's git folder, for the queue's level moves and run gates.
    pub(crate) read_git_folder: ProviderSessionGitFolderReader,
}

/// Builds the project records and the session directory's port over `start`, and registers the
/// port as the drivers' spawn-context resolver and relaunch listener. Fails when either port is
/// registered already, which only a second call does.
pub(crate) fn build_provider_port(
    start: ProviderPortStart<'_>,
) -> Result<ProviderPort, PortRegistrationError> {
    let ProviderPortStart {
        reads,
        read_damaged_from_sequence,
        binding_cursors,
        git,
        settings,
        plan_holds,
        ports,
        mcp_status,
        mcp_attribution,
    } = start;
    let project_records = Arc::new(ProjectRecords::new(
        Arc::clone(&reads),
        Arc::new(ProjectSessionActivityReader::new(plan_holds)),
    ));
    let port = Arc::new(SessionDirectoryProviderPort::new(
        SessionDirectoryProviderPortDeps {
            pool: reads,
            read_damaged_from_sequence,
            binding_cursors,
            git,
            settings,
            project_records: Arc::clone(&project_records),
            provider_accounts: Arc::clone(&ports.provider_accounts),
            mcp_status,
            mcp_attribution,
        },
    ));
    ports
        .spawn_contexts
        .register(Arc::clone(&port) as Arc<dyn SessionSpawnContextResolver>)?;
    ports
        .session_relaunched
        .register(Arc::clone(&port) as Arc<dyn SessionRelaunchListener>)?;
    Ok(ProviderPort {
        project_records,
        compose_opening: compose_opening(Arc::clone(&port)),
        read_git_folder: read_git_folder(port),
    })
}

// A session's opening as `port` composes it, each binding's function legs among it.
fn compose_opening(port: Arc<SessionDirectoryProviderPort>) -> ProviderSessionOpeningComposer {
    Arc::new(move |session_id, provider_account_id| {
        let port = Arc::clone(&port);
        async move {
            let opening = port
                .compose_opening(session_id, provider_account_id)
                .await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(ProviderSessionOpening {
                provider: opening.provider,
                git_folder: opening.git_folder,
                create_params: opening.create_params,
                function_legs_for: opening.function_legs_for,
            })
        }
        .boxed()
    })
}

// A session's git folder as `port` reads it, unavailable where the port says the session has none.
fn read_git_folder(port: Arc<SessionDirectoryProviderPort>) -> ProviderSessionGitFolderReader {
    Arc::new(move |session_id| {
        let port = Arc::clone(&port);
        async move {
            match port.read_git_folder(session_id).await {
                Ok(SessionGitFolder::Available(git_folder)) => Ok(git_folder),
                Ok(SessionGitFolder::Unavailable(why)) => {
                    Err(GitFolderReadError::Unavailable(Box::new(why)))
                }
                Err(failure) => Err(GitFolderReadError::Failed(Box::new(failure))),
            }
        }
        .boxed()
    })
}
