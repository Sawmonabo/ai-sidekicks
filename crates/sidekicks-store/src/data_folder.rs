//! Where the service keeps its data: one folder under the person's home, and the hold one daemon
//! keeps on it.

use std::path::{Path, PathBuf};

use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::provider::id::ProviderId;

pub mod lock;

// The agent memory folder's name in the data folder.
const AGENT_MEMORY_FOLDER_NAME: &str = "agent-memory";

// The folder in the data folder that holds the service log files.
const SERVICE_LOG_FOLDER_NAME: &str = "logs";

// The folder in the data folder that holds each provider's plugin home.
const PLUGINS_FOLDER_NAME: &str = "plugins";
// The folder in the data folder that holds the links the daemon's modes run by.
const PROGRAM_LINK_FOLDER_NAME: &str = "bin";

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
