//! The refusal a start meets when another daemon is already running for this account: it holds the
//! data folder, or it answers on the socket this start would bind.

use std::error::Error;
use std::fmt::{self, Display};
use std::path::PathBuf;

/// What the other daemon holds that this start needs.
#[derive(Debug)]
pub(crate) enum HeldPlace {
    /// The data folder, held by the other daemon's lock on its lock file.
    DataFolder {
        /// The data folder.
        path: PathBuf,
        /// The holder's process id as it recorded it, when the record could be read.
        process_id: Option<u32>,
    },
    /// The socket the other daemon answers on.
    Socket(PathBuf),
}

impl Display for HeldPlace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DataFolder {
                process_id: Some(process_id),
                ..
            } => write!(
                formatter,
                "The background service is already running (process {process_id})."
            ),
            Self::DataFolder {
                process_id: None, ..
            } => write!(formatter, "The background service is already running."),
            Self::Socket(path) => write!(
                formatter,
                "The background service is already running on the socket {}.",
                path.display()
            ),
        }
    }
}

/// A start's refusal because another daemon already holds `held_place`, in the words a person
/// reads; `source` is the failure that showed it, when one did.
#[derive(Debug, thiserror::Error)]
#[error("{held_place}")]
pub(crate) struct DaemonAlreadyRunningError {
    /// What the other daemon holds.
    pub(crate) held_place: HeldPlace,
    /// The failure that showed the place is held, such as a refused bind or a lock held elsewhere.
    #[source]
    pub(crate) source: Option<Box<dyn Error + Send + Sync>>,
}
