//! Where the service keeps its data: one folder under the person's home, and the hold one daemon
//! keeps on it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_std::missing_entry::MissingEntry as _;

pub mod lock;

// The agent memory folder's name in the data folder.
const AGENT_MEMORY_FOLDER_NAME: &str = "agent-memory";

// The folder in the data folder that holds the service log files.
const SERVICE_LOG_FOLDER_NAME: &str = "logs";

// The folder in the data folder that holds each provider's plugin home.
const PLUGINS_FOLDER_NAME: &str = "plugins";
// The folder in the data folder that holds the links the daemon's modes run by.
const PROGRAM_LINK_FOLDER_NAME: &str = "bin";

// The folder in the data folder that holds each session's own storage folder.
const SESSION_STORAGE_FOLDER_NAME: &str = "sessions";

// The folder in the data folder that holds each workflow's runs' own folders.
const WORKFLOWS_FOLDER_NAME: &str = "workflows";

// The folder in a workflow's folder that holds its runs' own folders.
const WORKFLOW_RUNS_FOLDER_NAME: &str = "runs";

// The folder in the data folder that holds the programs the daemon fetches for itself.
const TOOLS_FOLDER_NAME: &str = "tools";

/// The service's data folder under `home`, which holds its store, its logs and its lock.
pub fn data_folder(home: &Path) -> PathBuf {
    home.join(DAEMON_DATA_FOLDER_NAME)
}

/// The agent memory folder in `data_folder`: the daemon's own and only copy of each agent's
/// memory kept across projects.
pub fn agent_memory_folder(data_folder: &Path) -> PathBuf {
    data_folder.join(AGENT_MEMORY_FOLDER_NAME)
}

/// The folder in `data_folder` that holds the service log files.
pub fn service_log_folder(data_folder: &Path) -> PathBuf {
    data_folder.join(SERVICE_LOG_FOLDER_NAME)
}

/// The folder in `data_folder` that holds the programs the daemon fetches for itself, one folder
/// per program and, in it, one per version.
pub fn tools_folder(data_folder: &Path) -> PathBuf {
    data_folder.join(TOOLS_FOLDER_NAME)
}

/// The daemon's plugin home for `provider_id` under `home`: the one folder per provider where the
/// daemon keeps that provider's tool servers, plugins and skills.
pub fn plugin_home(home: &Path, provider_id: &ProviderId) -> PathBuf {
    data_folder(home)
        .join(PLUGINS_FOLDER_NAME)
        .join(provider_id.as_str())
}

/// The folder in `data_folder` that holds the links git, ssh and a provider run the daemon's modes
/// by, which the daemon makes at its start, since the program's own folder may not be writable.
pub fn program_link_folder(data_folder: &Path) -> PathBuf {
    data_folder.join(PROGRAM_LINK_FOLDER_NAME)
}

/// The folder in `data_folder` that holds every session's own storage folder.
pub fn session_storage_root(data_folder: &Path) -> PathBuf {
    data_folder.join(SESSION_STORAGE_FOLDER_NAME)
}

/// Session `session_id`'s own storage folder in `data_folder`, which holds the files the daemon
/// keeps for that session alone and goes with the session's purge.
pub fn session_storage_folder(data_folder: &Path, session_id: &SessionId) -> PathBuf {
    session_storage_root(data_folder).join(session_id.text().as_str())
}

/// Workflow run `workflow_run_id`'s own folder in `data_folder`, under its workflow
/// `definition_id`: where the run works when its session has no working folder.
pub fn workflow_run_folder(
    data_folder: &Path,
    definition_id: &WorkflowDefinitionId,
    workflow_run_id: &WorkflowRunId,
) -> PathBuf {
    data_folder
        .join(WORKFLOWS_FOLDER_NAME)
        .join(definition_id.text().as_str())
        .join(WORKFLOW_RUNS_FOLDER_NAME)
        .join(workflow_run_id.text().as_str())
}

/// One workflow run's own folder in the data folder, with the folder names of its workflow and its
/// run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowRunFolder {
    /// The name of its workflow's folder, the workflow definition's id.
    pub definition: String,
    /// The name of the run's folder, the workflow run's id.
    pub run: String,
    /// The run's folder.
    pub folder: PathBuf,
}

/// Every workflow run's own folder in `data_folder` (`workflows/<definition>/runs/<run>`), none
/// when it holds no `workflows` folder; an entry that is not a folder is passed over. Blocking.
/// Fails as a read of the folders does, and with [`io::ErrorKind::InvalidData`] for a folder name
/// that is not UTF-8.
pub fn read_workflow_run_folders(data_folder: &Path) -> io::Result<Vec<WorkflowRunFolder>> {
    let mut folders = Vec::new();
    let Some(definitions) =
        fs::read_dir(data_folder.join(WORKFLOWS_FOLDER_NAME)).none_if_missing()?
    else {
        return Ok(folders);
    };
    for definition in definitions {
        let definition = definition?;
        if !definition.file_type()?.is_dir() {
            continue;
        }
        let runs_folder = definition.path().join(WORKFLOW_RUNS_FOLDER_NAME);
        let Some(runs) = fs::read_dir(&runs_folder).none_if_missing()? else {
            continue;
        };
        let definition_name = utf8_folder_name(definition.file_name())?;
        for run in runs {
            let run = run?;
            if !run.file_type()?.is_dir() {
                continue;
            }
            folders.push(WorkflowRunFolder {
                definition: definition_name.clone(),
                run: utf8_folder_name(run.file_name())?,
                folder: run.path(),
            });
        }
    }
    Ok(folders)
}

// `name` as UTF-8; fails with `InvalidData` naming it otherwise.
fn utf8_folder_name(name: std::ffi::OsString) -> io::Result<String> {
    name.into_string().map_err(|name| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the folder name {} is not UTF-8", name.to_string_lossy()),
        )
    })
}
