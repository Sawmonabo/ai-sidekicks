//! Where the service keeps its data: one folder under the person's home.

use std::path::{Path, PathBuf};

use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;

/// The service's data folder under `home`, which holds its store, its logs and its lock.
pub(crate) fn data_folder(home: &Path) -> PathBuf {
    home.join(DAEMON_DATA_FOLDER_NAME)
}
