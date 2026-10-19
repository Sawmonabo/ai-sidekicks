//! Where the environment every provider's process starts from comes from on this system: on macOS
//! and Linux the login shell's, captured once per start, with the account's default environment
//! where the capture fails; on Windows, which has no login shell, the service's own.

use std::io;
use std::path::PathBuf;

/// Where the provider base environment comes from.
pub enum BaseEnvironmentSource {
    /// The login shell's environment, captured; `shell` is `None` where the account names none,
    /// and the capture then takes the account's default environment.
    LoginShell {
        /// The account's name, the default environment's `USER` and `LOGNAME`.
        account_name: String,
        /// The account's login shell.
        shell: Option<PathBuf>,
        /// The account's own temporary folder, the default environment's `TMPDIR`; `None` where a
        /// login gets none.
        temporary_folder: Option<String>,
    },
    /// The service's own environment.
    ServiceEnvironment,
}

/// Where this system's provider base environment comes from, read at each call. Fails with the
/// system's error from the account's read, and with `NotFound` when the account has no entry.
pub fn base_environment_source() -> io::Result<BaseEnvironmentSource> {
    #[cfg(unix)]
    {
        let (account_name, shell) = crate::posix::login_shell::read_account()?;
        let temporary_folder = crate::posix::login_shell::user_temporary_folder()
            .inspect_err(|error| {
                tracing::warn!(
                    error = error as &(dyn std::error::Error + 'static),
                    "the account's temporary folder could not be read, so providers start with \
                     no TMPDIR when the login shell's capture fails"
                );
            })
            .ok()
            .flatten();
        Ok(BaseEnvironmentSource::LoginShell {
            account_name,
            shell,
            temporary_folder,
        })
    }
    #[cfg(target_os = "windows")]
    Ok(BaseEnvironmentSource::ServiceEnvironment)
}
