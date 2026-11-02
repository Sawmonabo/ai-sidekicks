//! Where the daemon keeps its secrets, as the record in its data folder names it, which the store
//! writes and the command line reads; and the modes of the daemon's own program that move them
//! between the login keychain and the items file of a Mac's service running while the person is
//! logged out, and check the keychain, which the command line runs in the person's login session.

use serde::{Deserialize, Serialize};

use crate::daemon::status::DaemonSecretsPlainReason;

/// The record's file name in the data folder.
pub const SECRETS_PLACE_RECORD_FILE_NAME: &str = "secrets-place.json";

/// The arguments that move the daemon's secrets, followed by the destination's word.
pub const SECRETS_MOVE_MODE: [&str; 2] = ["secrets", "move"];

/// The arguments that check, without holding the data folder, that the login keychain takes a
/// value now.
pub const SECRETS_KEYCHAIN_CHECK_MODE: [&str; 3] = ["secrets", "check", "keychain"];

/// Where the daemon's secrets are kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SecretsPlace {
    /// The operating system's credential store.
    OperatingSystem,
    /// The items file on Linux, each item sealed by systemd's credential service.
    SealedFile,
    /// The items file on Linux, each item plain, and why.
    PlainFile {
        /// Why the file is plain.
        reason: DaemonSecretsPlainReason,
    },
    /// The plain items file of a Mac's service running while the person is logged out, where the
    /// login keychain cannot be reached; the items move back only when that service is
    /// uninstalled.
    LoggedOutServiceFile,
}

/// The record in the data folder: the place, and during a move its destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaceRecord {
    /// Where the secrets are, or during a move where they come from.
    place: SecretsPlace,
    /// Where a move under way takes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    moving_to: Option<SecretsPlace>,
}

impl PlaceRecord {
    /// The record of secrets kept in `place`, with no move under way.
    pub fn settled(place: SecretsPlace) -> Self {
        Self {
            place,
            moving_to: None,
        }
    }

    /// The record of a move under way from `place` to `destination`.
    pub fn moving(place: SecretsPlace, destination: SecretsPlace) -> Self {
        Self {
            place,
            moving_to: Some(destination),
        }
    }

    /// Where the secrets are, or during a move where they come from.
    pub fn place(self) -> SecretsPlace {
        self.place
    }

    /// Where a move under way takes the secrets; `None` with no move under way.
    pub fn moving_to(self) -> Option<SecretsPlace> {
        self.moving_to
    }

    /// Where the secrets end up: a move's destination while one is under way, else the place.
    pub fn destination(self) -> SecretsPlace {
        self.moving_to.unwrap_or(self.place)
    }

    /// Whether the record names the operating system's store, as the place or a move's end.
    pub fn names_operating_system(self) -> bool {
        self.place == SecretsPlace::OperatingSystem
            || self.moving_to == Some(SecretsPlace::OperatingSystem)
    }
}

/// Where a move takes the daemon's secrets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretsMoveDestination {
    /// The plain items file of a Mac's service running while the person is logged out.
    LoggedOutServiceFile,
    /// The operating system's store, the login keychain on a Mac.
    OperatingSystem,
}

impl SecretsMoveDestination {
    /// The destination's word on the mode's command line.
    pub const fn word(self) -> &'static str {
        match self {
            Self::LoggedOutServiceFile => "files",
            Self::OperatingSystem => "keychain",
        }
    }

    /// The destination `word` names, or `None` for a word no destination has.
    pub fn from_word(word: &str) -> Option<Self> {
        [Self::LoggedOutServiceFile, Self::OperatingSystem]
            .into_iter()
            .find(|destination| destination.word() == word)
    }
}
