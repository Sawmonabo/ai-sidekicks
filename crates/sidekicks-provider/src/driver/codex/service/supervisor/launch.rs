//! What a service's launch carries and leaves behind: its `-c` switches, the native command it
//! runs and the log its lasting process writes.

use std::path::PathBuf;

use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::native_program::CodexNativeCommand;
use crate::driver::codex::service::supervisor::CodexService;

impl CodexService {
    /// The `-c` switches a launch of the service carries past the ones every service shares: the
    /// driver's, then the service's own, so its own win where both set a key.
    pub(crate) fn launch_config_overrides(&self) -> Vec<String> {
        self.dependencies
            .additional_config_overrides
            .iter()
            .chain(&self.config_overrides)
            .cloned()
            .collect()
    }

    /// Codex's native command the service runs; `None` before any start and where it was not
    /// found.
    pub(crate) fn native_command(&self) -> Option<CodexNativeCommand> {
        lock(&self.native_command).clone()
    }

    /// Records `command` as the native command the service runs, `None` where none is known.
    pub(crate) fn set_native_command(&self, command: Option<CodexNativeCommand>) {
        *lock(&self.native_command) = command;
    }

    /// The log of the lasting process a start named; `None` before any such start.
    pub(crate) fn lasting_log_file(&self) -> Option<PathBuf> {
        self.lock_lasting_log_file().clone()
    }

    /// Records `log_file` as the log the lasting process a start launches writes.
    pub(crate) fn set_lasting_log_file(&self, log_file: PathBuf) {
        *self.lock_lasting_log_file() = Some(log_file);
    }
}
