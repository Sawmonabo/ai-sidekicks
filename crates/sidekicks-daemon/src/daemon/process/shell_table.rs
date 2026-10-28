//! The terminal service's table as the daemon's start builds it: its shells' startup folders in
//! the run folder, the start's orphan registry, and the three reads and writes the table
//! calls out to, each a change of a shell's holder appended to its session's log, a session's
//! working folder, and what a shell takes from the machine's settings file and its project.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::control::TerminalControlChangedPayload;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_shell::control_lease::LeaseBroadcast;
use sidekicks_shell::integration::injection::{ShellStartupError, prepare_shell_startup_folders};
use sidekicks_shell::mode::SHELL_MODE;
use sidekicks_shell::orphan::guard::OrphanGuard;
use sidekicks_shell::table::{
    ReadSessionWorkingFolder, ReadShellSettings, ShellSettings, ShellTable, ShellTableDeps,
};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_terminal::{CommandLine, Terminals};
use sidekicks_workspace::working_folder::{
    ProjectEnvironmentReadError, WorkingFolderReadError, read_project_environment_rows,
    read_working_folder,
};
use tokio::runtime::Handle;

use crate::daemon::machine_settings::file::MachineSettingsFile;
use crate::daemon::release_version::this_build_release_version;

/// The folder of the run folder every shell's start writes its scripts and nonce files in.
const SHELL_STARTUP_FOLDER_NAME: &str = "shell-startup";

/// What the shell table is built from.
pub(crate) struct ShellTableStart {
    /// The daemon's terminals.
    pub(crate) terminals: Arc<Terminals>,
    /// This machine's own device id, which a run's hold names.
    pub(crate) machine_device_id: DeviceId,
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// Appends each change of a shell's holder.
    pub(crate) appender: Arc<SessionEventAppender>,
    /// The machine's settings file.
    pub(crate) settings: Arc<MachineSettingsFile>,
    /// The login shell's environment captured at the daemon's start.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The names a person's row may not set.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// The variables each provider reads as the screen-reader switch.
    pub(crate) screen_reader_environment_names: Vec<&'static str>,
    /// The daemon's run folder, where the shells' startup folders go.
    pub(crate) run_folder: PathBuf,
    /// The record of every terminal child, which the start opened over the data folder.
    pub(crate) orphan_guard: Arc<OrphanGuard>,
    /// The daemon's own program, whose `shell` mode starts every shell.
    pub(crate) daemon_program: PathBuf,
}

/// Why the shell table could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ShellTableStartError {
    /// The daemon's program path is not UTF-8, so no shell's start can name it.
    #[error("the daemon's program path {} is not UTF-8", path.display())]
    ShellModeProgram {
        /// The program's path.
        path: PathBuf,
    },
    /// The shells' startup folders could not be prepared.
    #[error("the shells' startup folders could not be prepared")]
    StartupFolders(#[source] ShellStartupError),
    /// The blocking task preparing the startup folders ended before it finished.
    #[error("the shells' startup folders' preparation ended before it finished")]
    StartupFoldersInterrupted(#[source] tokio::task::JoinError),
}

/// Builds the shell table from `start`, holding no shell. Fails when the daemon's program cannot
/// be named or the startup folders cannot be prepared. Runs inside the daemon's runtime.
pub(crate) async fn build_shell_table(
    start: ShellTableStart,
) -> Result<ShellTable, ShellTableStartError> {
    let ShellTableStart {
        terminals,
        machine_device_id,
        reads,
        appender,
        settings,
        base_environment,
        reserved_names,
        screen_reader_environment_names,
        run_folder,
        orphan_guard,
        daemon_program,
    } = start;
    let shell_mode = shell_mode(daemon_program)?;
    let startup_folder = run_folder.join(SHELL_STARTUP_FOLDER_NAME);
    let startup_folders =
        tokio::task::spawn_blocking(move || prepare_shell_startup_folders(&startup_folder))
            .await
            .map_err(ShellTableStartError::StartupFoldersInterrupted)?
            .map_err(ShellTableStartError::StartupFolders)?;
    Ok(ShellTable::new(ShellTableDeps {
        terminals,
        machine_device_id,
        release_version: this_build_release_version().as_str().to_owned(),
        append_control_change: append_control_change(appender),
        read_working_folder: read_session_working_folder(Arc::clone(&reads)),
        read_shell_settings: read_shell_settings(reads, settings),
        base_environment: base_environment.to_vec(),
        reserved_names,
        screen_reader_environment_names,
        startup_folders,
        shell_mode,
        orphan_guard,
        runtime: Handle::current(),
    }))
}

// The daemon's `shell` mode of `daemon_program`, naming the daemon's own process.
fn shell_mode(daemon_program: PathBuf) -> Result<CommandLine, ShellTableStartError> {
    let program = daemon_program
        .into_os_string()
        .into_string()
        .map_err(|path| ShellTableStartError::ShellModeProgram { path: path.into() })?;
    Ok(CommandLine {
        program,
        arguments: vec![SHELL_MODE.to_owned(), std::process::id().to_string()],
    })
}

// Appends each change of a shell's holder to its session's log; a failed append fails the change,
// which the lease then undoes.
fn append_control_change(appender: Arc<SessionEventAppender>) -> LeaseBroadcast {
    Arc::new(move |change: TerminalControlChangedPayload| {
        let appender = Arc::clone(&appender);
        async move {
            let session_id = session_of(&change);
            let draft = SessionEventDraft::of_session(
                session_id,
                &SessionEvent::TerminalControlChanged(change),
            )
            .map_err(|error| append_failure("drafted", error))?;
            appender
                .append(draft, SessionEventLinkage::default())
                .await
                .map_err(|error| append_failure("appended", error))?;
            Ok::<(), DomainError>(())
        }
        .boxed()
    })
}

fn append_failure(
    step: &'static str,
    error: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> DomainError {
    DomainError::new(
        format!("the shell's change of holder could not be {step}"),
        RefusalCode::SystemInternalError,
    )
    .with_source(error)
}

fn session_of(change: &TerminalControlChangedPayload) -> SessionId {
    match change {
        TerminalControlChangedPayload::Taken { session_id, .. }
        | TerminalControlChangedPayload::TakenByForce { session_id, .. }
        | TerminalControlChangedPayload::AutoReleasedDisconnect { session_id, .. }
        | TerminalControlChangedPayload::AutoReleasedPaneClosed { session_id, .. }
        | TerminalControlChangedPayload::AutoReleasedCommandEnded { session_id, .. }
        | TerminalControlChangedPayload::AutoReleasedRunIdle { session_id, .. } => *session_id,
    }
}

// Why a shell's read of its session failed: the session's own refusal, or a fault.
#[derive(Debug, thiserror::Error)]
enum ShellSessionReadError {
    #[error(transparent)]
    Folder(#[from] WorkingFolderReadError),
    #[error("the read pool did not run the read")]
    Pool(#[from] DatabaseReadError),
    #[error(transparent)]
    ProjectRows(#[from] ProjectEnvironmentReadError),
}

impl From<ShellSessionReadError> for HandlerError {
    fn from(error: ShellSessionReadError) -> Self {
        match error {
            ShellSessionReadError::Folder(WorkingFolderReadError::Refused(refusal)) => {
                Self::Refused(refusal)
            }
            error @ (ShellSessionReadError::Folder(WorkingFolderReadError::Database(_))
            | ShellSessionReadError::Pool(_)
            | ShellSessionReadError::ProjectRows(_)) => Self::Internal(Box::new(error)),
        }
    }
}

fn read_session_working_folder(reads: Arc<DatabaseReadPool>) -> ReadSessionWorkingFolder {
    Arc::new(move |session_id: SessionId| {
        let reads = Arc::clone(&reads);
        async move {
            reads
                .read(ReadLength::Short, move |connection| {
                    read_working_folder(connection, &session_id)
                        .map_err(ShellSessionReadError::from)
                })
                .await
                .map_err(HandlerError::from)
        }
        .boxed()
    })
}

// Reads what a shell takes at its start: the machine's screen-reader switch and `Every project`
// rows, and the rows of the project the session's repository belongs to, none outside a project.
fn read_shell_settings(
    reads: Arc<DatabaseReadPool>,
    settings: Arc<MachineSettingsFile>,
) -> ReadShellSettings {
    Arc::new(move |session_id: SessionId| {
        let reads = Arc::clone(&reads);
        let settings = Arc::clone(&settings);
        async move {
            let project_rows = reads
                .read(ReadLength::Short, move |connection| {
                    let folder = read_working_folder(connection, &session_id)?;
                    Ok::<_, ShellSessionReadError>(read_project_environment_rows(
                        connection, &folder,
                    )?)
                })
                .await
                .map_err(HandlerError::from)?;
            let reading = settings.read().await?;
            Ok::<_, HandlerError>(ShellSettings {
                is_screen_reader_mode_on: reading.settings.screen_reader_mode,
                every_project_rows: reading.settings.environment_rows,
                project_rows,
            })
        }
        .boxed()
    })
}
