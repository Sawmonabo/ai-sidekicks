//! Bootstrap: the start's secure defaults, the local socket's path checked once, before any
//! listener binds, against what a socket address holds. The gateway binds only on a loaded
//! `SecureDefaults`, so no listener can bind before the check.

use std::path::{Path, PathBuf};

use sidekicks_platforms::{SocketPathRefused, check_socket_path};

/// The settings the start loads: the path of the local socket the daemon listens on.
pub(crate) struct SecureDefaultsConfig {
    /// The local socket's path.
    pub(crate) local_ipc_path: PathBuf,
}

/// Why the start's settings are refused; the start ends with it.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SecureDefaultsError {
    /// The socket path is empty.
    #[error("the local socket path is empty")]
    EmptyLocalIpcPath,
    /// The socket path cannot name a local socket on this system.
    #[error("the local socket path {} cannot name a socket on this system", path.display())]
    LocalIpcPathRefused {
        /// The refused path.
        path: PathBuf,
        /// Why the system refuses it.
        #[source]
        refusal: SocketPathRefused,
    },
}

/// The start's settings once checked; the only way the gateway learns where to listen.
pub(crate) struct SecureDefaults {
    local_ipc_path: PathBuf,
}

impl SecureDefaults {
    /// Checks `config` once: refuses an empty socket path, then one the system's socket address
    /// cannot hold, keeping the platform's refusal as the source.
    pub(crate) fn load(config: SecureDefaultsConfig) -> Result<Self, SecureDefaultsError> {
        let SecureDefaultsConfig { local_ipc_path } = config;
        if local_ipc_path.as_os_str().is_empty() {
            return Err(SecureDefaultsError::EmptyLocalIpcPath);
        }
        check_socket_path(&local_ipc_path).map_err(|refusal| {
            SecureDefaultsError::LocalIpcPathRefused {
                path: local_ipc_path.clone(),
                refusal,
            }
        })?;
        Ok(Self { local_ipc_path })
    }

    /// The local socket's checked path.
    pub(crate) fn local_ipc_path(&self) -> &Path {
        &self.local_ipc_path
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{SecureDefaults, SecureDefaultsConfig, SecureDefaultsError};

    #[test]
    fn an_empty_socket_path_ends_the_start() {
        let loaded = SecureDefaults::load(SecureDefaultsConfig {
            local_ipc_path: PathBuf::new(),
        });
        assert!(matches!(
            loaded,
            Err(SecureDefaultsError::EmptyLocalIpcPath)
        ));
    }
}
