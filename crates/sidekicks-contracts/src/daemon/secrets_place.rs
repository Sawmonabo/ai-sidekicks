//! The modes of the daemon's own program that move its secrets between the login keychain and the
//! items file of a Mac's service running while the person is logged out, and check the keychain,
//! which the command line runs in the person's login session.

/// The arguments that move the daemon's secrets, followed by the destination's word.
pub const SECRETS_MOVE_MODE: [&str; 2] = ["secrets", "move"];

/// The arguments that check, without holding the data folder, that the login keychain takes a
/// value now.
pub const SECRETS_KEYCHAIN_CHECK_MODE: [&str; 3] = ["secrets", "check", "keychain"];

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
