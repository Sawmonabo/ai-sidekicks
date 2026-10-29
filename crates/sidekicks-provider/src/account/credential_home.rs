//! An account's credential home: the folder the daemon makes for each account under its own data
//! folder, readable by its owner alone, where the provider's own tooling keeps that account's
//! sign-in; and whether a registered account's home is there to run in.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_platforms::{create_missing_private_folders, create_new_private_folder};

// The data folder's folder of account homes, one folder per account named by its id.
const ACCOUNT_HOMES_FOLDER_NAME: &str = "accounts";

/// One account's credential home, always the folder minted for it under the daemon's data folder,
/// an absolute path. Its `Debug` names no path, so a log line that prints it carries none.
#[derive(Clone, PartialEq, Eq)]
pub struct CredentialHome(PathBuf);

impl CredentialHome {
    /// The home's folder.
    pub fn path(&self) -> &Path {
        &self.0
    }

    /// The home a registered account's row names.
    pub(super) fn from_stored(path: String) -> Self {
        Self(PathBuf::from(path))
    }
}

impl fmt::Debug for CredentialHome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialHome(..)")
    }
}

/// Whether a registered account's home is there to run in: missing, present but holding no
/// sign-in its last observation found, or present and signed in when last observed. Read from the
/// folder and the stored health alone; no credential file is opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialHomeCondition {
    /// No folder stands at the home's path.
    Absent,
    /// The folder is there, but its last observation found no usable sign-in, or none was made.
    Husked,
    /// The folder is there and its last observation found it signed in.
    SignedIn,
}

/// The condition of `home`, given the account's stored health state, `None` where it was never
/// observed. Fails with the system's error when the folder cannot be looked at for any reason but
/// its absence.
pub fn classify_credential_home(
    home: &CredentialHome,
    stored_health: Option<ProviderAccountHealthState>,
) -> io::Result<CredentialHomeCondition> {
    match fs::symlink_metadata(home.path()) {
        Ok(metadata) if metadata.is_dir() => Ok(
            if stored_health == Some(ProviderAccountHealthState::Authenticated) {
                CredentialHomeCondition::SignedIn
            } else {
                CredentialHomeCondition::Husked
            },
        ),
        // A file or a link where the folder belongs is no home to run in.
        Ok(_) => Ok(CredentialHomeCondition::Absent),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(CredentialHomeCondition::Absent)
        }
        Err(error) => Err(error),
    }
}

/// Makes `account_id`'s home under `data_folder`, readable by its owner alone from the moment it
/// exists, with the folder of homes above it where that is missing. Fails with the system's error,
/// `AlreadyExists` when a folder already stands there, which is never taken over.
pub(super) fn create_credential_home(
    data_folder: &Path,
    account_id: &ProviderAccountId,
) -> io::Result<CredentialHome> {
    let homes = data_folder.join(ACCOUNT_HOMES_FOLDER_NAME);
    create_missing_private_folders(&homes)?;
    let home = homes.join(account_id.as_str());
    create_new_private_folder(&home)?;
    Ok(CredentialHome(home))
}

/// Removes a home minted for an account no sign-in admitted, with whatever its sign-in attempt
/// left in it. Fails with the system's error.
pub(super) fn remove_credential_home(home: &CredentialHome) -> io::Result<()> {
    fs::remove_dir_all(home.path())
}
