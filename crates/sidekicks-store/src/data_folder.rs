//! Where the service keeps its data: one folder under the person's home.

use std::path::{Path, PathBuf};

use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;

pub mod lock;

// The agent memory folder's name in the data folder.
const AGENT_MEMORY_FOLDER_NAME: &str = "agent-memory";

// The folder in the data folder that holds the service log files.
const SERVICE_LOG_FOLDER_NAME: &str = "logs";

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
