//! The file a Claude Code process reads its settings document from, named on its command line by
//! path alone, so the telemetry token in the document is never on a command line: written private
//! to the daemon's user in the driver's settings folder before the process starts, removed once
//! the process is reaped or its start failed, and swept at the daemon's start where a stopped
//! daemon left one.

use std::error::Error;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{create_new_file, create_private_folder, remove_tree_awaited};

use crate::driver::claude::spawn::settings::ClaudeSpawnSettings;
use crate::pricing::receiver::bearers::TelemetryBearer;

/// The data folder's folder of the processes' settings files.
const CLAUDE_SETTINGS_FOLDER: [&str; 2] = ["claude", "settings"];

/// Read and write for the daemon's user alone.
const SETTINGS_FILE_MODE: u32 = 0o600;

/// The folder in `data_folder` that holds every process's settings file, which the session's
/// agent is denied.
pub(crate) fn compose_claude_settings_folder(data_folder: &Path) -> PathBuf {
    CLAUDE_SETTINGS_FOLDER
        .iter()
        .fold(data_folder.to_path_buf(), |folder, name| folder.join(name))
}

/// One process's settings file, removed on a blocking thread when this drops, the telemetry token
/// it carries refused with it: the process holds it until its reap, and a start that fails drops
/// it at once.
pub(crate) struct ClaudeSpawnSettingsFile {
    path: PathBuf,
    bearer: Option<TelemetryBearer>,
}

impl ClaudeSpawnSettingsFile {
    /// Writes `settings` to a new file of its own in `folder`, made private first, readable and
    /// writable by the daemon's user alone, keeping `bearer`, the guard of the token the document
    /// carries, until the file is dropped. Fails with the system's error from the folder, the
    /// file's make or its write; a file made before its write failed is removed, its token refused.
    pub(crate) async fn write(
        folder: &Path,
        settings: &ClaudeSpawnSettings,
        bearer: Option<TelemetryBearer>,
    ) -> io::Result<Self> {
        let document =
            serde_json::to_vec(settings).expect("the settings document always serializes");
        let name = format!("{}.json", mint_uuid_v7());
        let folder = folder.to_path_buf();
        tokio::task::spawn_blocking(move || {
            create_private_folder(&folder)?;
            let path = folder.join(name);
            let mut file = create_new_file(&path, SETTINGS_FILE_MODE)?;
            let written = Self { path, bearer };
            file.write_all(&document)?;
            Ok(written)
        })
        .await
        .map_err(io::Error::other)?
    }

    /// The file's path, the one thing the command line carries.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ClaudeSpawnSettingsFile {
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.path);
        // The token goes with its process, before the file's removal is even begun.
        drop(self.bearer.take());
        let remove = move || log_unremoved(std::fs::remove_file(&path));
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(remove)),
            // Dropped off the runtime, where a blocking removal holds no task up.
            Err(_outside_runtime) => remove(),
        }
    }
}

/// Removes every settings file in `data_folder`'s settings folder, which a stopped daemon's
/// processes left; a missing folder has none. Fails as the removal fails.
pub(crate) async fn remove_left_claude_settings_files(data_folder: &Path) -> io::Result<()> {
    remove_tree_awaited(&compose_claude_settings_folder(data_folder)).await
}

// Logs a removal that failed, leaving the file to the next start's sweep; the path stays out of
// the log, since it names the person's home.
fn log_unremoved(removed: io::Result<()>) {
    match removed {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a Claude Code process's settings file could not be removed"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{compose_claude_settings_folder, remove_left_claude_settings_files};

    // Killed by a sweep that keeps a crash's file, and by one that fails a first start, whose
    // folder is not made yet.
    #[tokio::test]
    async fn a_left_settings_file_is_removed_at_start() {
        let data_folder = tempfile::tempdir().expect("a data folder");
        let folder = compose_claude_settings_folder(data_folder.path());

        remove_left_claude_settings_files(data_folder.path())
            .await
            .expect("a missing folder has nothing to remove");

        std::fs::create_dir_all(&folder).expect("the settings folder is made");
        let left = folder.join("left.json");
        std::fs::write(&left, "{}").expect("a crash's file is written");

        remove_left_claude_settings_files(data_folder.path())
            .await
            .expect("the left file is removed");

        assert!(!left.exists(), "the crash's file is gone");
    }
}
