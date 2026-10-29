//! An account's credential home: the folder the daemon makes for each account under its own data
//! folder, readable by its owner alone, where the provider's own tooling keeps that account's
//! sign-in; whether a registered account's home is there to run in; and its reset, the provider's
//! own sign-out followed by the home emptied in place.
//!
//! Where the provider keeps its agents' memory in its home, that folder is a link to the daemon's
//! own agent-memory folder, made with the home and again after each reset, so every account's
//! agents share one memory.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{
    create_missing_private_folders, create_new_private_folder, make_folder_link, remove_tree,
};
use sidekicks_store::data_folder::agent_memory_folder;

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::registry::ProviderAccountRegistry;
use crate::driver::contract::account::ProviderAccountLegs;
use crate::driver::contract::error::DriverError;
use crate::driver::{ProviderAccountFolders, descriptor_of};

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
/// exists, with the folder of homes above it where that is missing, and `provider`'s memory link
/// in it. Fails with the system's error, `AlreadyExists` when a folder already stands there, which
/// is never taken over; a home whose link could not be made is removed again.
pub(super) fn create_credential_home(
    data_folder: &Path,
    provider: &ProviderId,
    account_id: &ProviderAccountId,
) -> io::Result<CredentialHome> {
    let homes = data_folder.join(ACCOUNT_HOMES_FOLDER_NAME);
    create_missing_private_folders(&homes)?;
    let home = CredentialHome(homes.join(account_id.as_str()));
    create_new_private_folder(home.path())?;
    if let Err(error) = link_agent_memory(data_folder, provider, &home) {
        remove_credential_home(&home)?;
        return Err(error);
    }
    Ok(home)
}

// Links the folder `provider` keeps its agents' memory in under `home` to the daemon's own
// agent-memory folder in `data_folder`, made where it is missing; a provider that keeps none in
// its home gets no link.
fn link_agent_memory(
    data_folder: &Path,
    provider: &ProviderId,
    home: &CredentialHome,
) -> io::Result<()> {
    let Some(components) = descriptor_of(provider.as_str())
        .and_then(|descriptor| descriptor.account_home_memory_folder)
    else {
        return Ok(());
    };
    let shared = agent_memory_folder(data_folder);
    create_missing_private_folders(&shared)?;
    let link = components
        .iter()
        .fold(home.path().to_path_buf(), |path, part| path.join(part));
    make_folder_link(&shared, &link)
}

/// Removes a home minted for an account no sign-in admitted, with whatever its sign-in attempt
/// left in it. Fails with the system's error.
pub(super) fn remove_credential_home(home: &CredentialHome) -> io::Result<()> {
    fs::remove_dir_all(home.path())
}

/// Why a credential home could not be reset.
#[derive(Debug, thiserror::Error)]
pub enum CredentialHomeResetError {
    /// The provider's own sign-out could not run or was refused, so the home was left as it was.
    #[error("the provider's own sign-out did not complete")]
    SignOut(#[source] DriverError),
    /// The account could not be read, its home could not be emptied, or its reset not stored.
    #[error(transparent)]
    Registry(#[from] ProviderAccountRegistryError),
}

/// Resets `account_id`'s home: the provider's own sign-out through `legs`, run in `folders`, then
/// every entry of the home removed and its memory link made again, the folder itself kept, then
/// the reset stored as the account's next generation with the sign-in gone. A missing home is made
/// first, so the reset also brings back a home that went missing; a link or file standing in its
/// place is refused, never emptied through. Answers the generation after it. Fails as
/// [`CredentialHomeResetError`] says; a failed sign-out empties nothing.
pub async fn reset_credential_home(
    registry: &ProviderAccountRegistry,
    legs: &dyn ProviderAccountLegs,
    account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<CredentialGeneration, CredentialHomeResetError> {
    let account = registry.read(account_id.clone()).await?;
    let data_folder = registry.data_folder().to_path_buf();
    let home = account.credential_home;
    let made = home.clone();
    run_on_blocking_thread(move || {
        create_missing_private_folders(made.path())?;
        if fs::symlink_metadata(made.path())?.is_dir() {
            Ok(())
        } else {
            Err(io::ErrorKind::NotADirectory.into())
        }
    })
    .await?;
    legs.sign_out_home(account_id.clone(), folders)
        .await
        .map_err(CredentialHomeResetError::SignOut)?;
    let provider = account.provider;
    run_on_blocking_thread(move || {
        for entry in fs::read_dir(home.path())? {
            remove_tree(&entry?.path())?;
        }
        link_agent_memory(&data_folder, &provider, &home)
    })
    .await?;
    Ok(registry
        .record_home_reset(&account_id, &WireInstant::now())
        .await?)
}

// Runs a file-system step off the runtime's threads, its failure a home that could not be made or
// emptied.
async fn run_on_blocking_thread(
    step: impl FnOnce() -> io::Result<()> + Send + 'static,
) -> Result<(), ProviderAccountRegistryError> {
    tokio::task::spawn_blocking(step)
        .await
        .map_err(io::Error::other)
        .flatten()
        .map_err(ProviderAccountRegistryError::CredentialHome)
}

#[cfg(test)]
mod tests;
