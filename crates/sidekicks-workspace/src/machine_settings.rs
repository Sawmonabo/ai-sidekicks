//! The machine's settings as the workspace reads them: the daemon keeps the settings file and
//! hands this crate a reader, so a project's pattern check, the clone's folder and a session's
//! environment read the file as it stands.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::machine::settings::MachineSettings;

/// Reads the machine's settings file.
pub trait MachineSettingsReader: Send + Sync {
    /// The machine's settings as the file stands. Fails when the file cannot be read.
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>>;
}
