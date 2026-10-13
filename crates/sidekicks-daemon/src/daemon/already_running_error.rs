//! The refusal a start meets when another daemon is already running for this account: it holds the
//! data folder, or it answers on the socket this start would bind.

use std::fmt::{self, Display};
use std::io;
use std::path::PathBuf;

/// What the other daemon holds that this start needs.
#[derive(Debug)]
pub(crate) enum HeldPlace {
    /// The data folder, held by the other daemon's exclusive database lock.
    DataFolder(PathBuf),
    /// The socket the other daemon answers on.
    Socket(PathBuf),
}

impl Display for HeldPlace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DataFolder(path) => write!(formatter, "the data folder {}", path.display()),
            Self::Socket(path) => write!(formatter, "the socket {}", path.display()),
        }
    }
}

/// A start's refusal because another daemon already holds `held_place`; `source` is the failure
/// that showed it, when one did.
#[derive(Debug, thiserror::Error)]
#[error("Another daemon already holds {held_place}")]
pub(crate) struct DaemonAlreadyRunningError {
    /// What the other daemon holds.
    pub(crate) held_place: HeldPlace,
    /// The failure that showed the place is held, such as a refused bind.
    #[source]
    pub(crate) source: Option<io::Error>,
}
