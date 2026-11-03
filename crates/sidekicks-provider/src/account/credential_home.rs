//! An account's credential home: the folder the daemon makes for each account under its own data
//! folder, readable by its owner alone, where the provider's own tooling keeps that account's
//! sign-in; whether a registered account's home is there to run in; its reset, the provider's
//! own sign-out followed by the home emptied in place; the sign-out of every home before
//! `Erase all data` deletes them; and the mark a new account's home carries until a row takes it.
//!
//! Where the provider keeps its agents' memory in its home, that folder is a link to the daemon's
//! own agent-memory folder, made with the home and again after each reset, so every account's
//! agents share one memory; the folder the provider keeps the sign-in in is made with them,
//! readable by its owner alone.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::hash::BuildHasher;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::{
    create_missing_private_folders, create_new_private_folder, make_folder_link, remove_tree,
};
use sidekicks_store::data_folder::agent_memory_folder;

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::ProviderAccountRegistry;
use crate::account::resolver::credential_home_folders;
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

    /// A home at `path`, for a driver's test that runs its legs on a folder of its own.
    #[cfg(test)]
    pub(crate) fn at(path: PathBuf) -> Self {
        Self(path)
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
/// and credential store folder in it. Fails with the system's error, `AlreadyExists` when a folder
/// already stands there, which is never taken over; a home whose contents could not be made is
/// removed again.
pub(super) fn create_credential_home(
    data_folder: &Path,
    provider: &ProviderId,
    account_id: &ProviderAccountId,
) -> io::Result<CredentialHome> {
    let homes = data_folder.join(ACCOUNT_HOMES_FOLDER_NAME);
    create_missing_private_folders(&homes)?;
    let home = CredentialHome(homes.join(account_id.as_str()));
    create_new_private_folder(home.path())?;
    if let Err(error) = furnish_credential_home(data_folder, provider, &home) {
        remove_credential_home(&home)?;
        return Err(error);
    }
    Ok(home)
}

// Makes what an empty `home` holds before any sign-in: `provider`'s memory link and the folder it
// keeps the account's sign-in in, readable by its owner alone.
fn furnish_credential_home(
    data_folder: &Path,
    provider: &ProviderId,
    home: &CredentialHome,
) -> io::Result<()> {
    link_agent_memory(data_folder, provider, home)?;
    create_missing_private_folders(&credential_home_folders(provider, home).credential_store_folder)
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

/// Resets `account_id`'s home under its hold on `home_lock`, so no other act runs there meanwhile:
/// the provider's own sign-out through `legs`, run in `folders`, then every entry of the home
/// removed and its memory link made again, the folder itself kept, then the reset stored as the
/// account's next generation with the sign-in gone. A missing home is made first, so the reset
/// also brings back a home that went missing; a link or file standing in its place is refused,
/// never emptied through. Answers the generation after it. Fails as [`CredentialHomeResetError`]
/// says; a failed sign-out empties nothing.
pub async fn reset_credential_home(
    registry: &ProviderAccountRegistry,
    home_lock: &AccountHomeLock,
    legs: &dyn ProviderAccountLegs,
    account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<CredentialGeneration, CredentialHomeResetError> {
    let _hold = home_lock.hold(account_id.clone()).await;
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
        furnish_credential_home(&data_folder, &provider, &home)
    })
    .await?;
    Ok(registry
        .record_home_reset(&account_id, &WireInstant::now())
        .await?)
}

impl From<CredentialHomeResetError> for HandlerError {
    /// A refused or failed sign-out answers as the driver's error, and a registry failure as the
    /// registry answers it.
    fn from(error: CredentialHomeResetError) -> Self {
        match error {
            CredentialHomeResetError::SignOut(failure) => failure.into(),
            CredentialHomeResetError::Registry(failure) => failure.into(),
        }
    }
}

/// Why `sign_out_every_home` could not sign an account out.
#[derive(Debug, thiserror::Error)]
pub enum HomeSignOutError {
    /// No registered provider runs the account's sign-out.
    #[error("no registered provider signs the account out")]
    NoProvider,
    /// The provider's own sign-out could not run or was refused.
    #[error("the provider's own sign-out did not complete")]
    SignOut(#[source] DriverError),
    /// The sign-out did not end within its bound.
    #[error("the provider's own sign-out outlived its bound")]
    Overran,
}

/// Signs every registered account out through its provider's own sign-out in its home, all at
/// once and within `bound`, as `Erase all data` does before the homes go. Answers each account
/// it could not sign out, with why. Fails when the accounts cannot be read.
pub async fn sign_out_every_home<S: BuildHasher>(
    registry: &ProviderAccountRegistry,
    legs: &HashMap<ProviderId, Arc<dyn ProviderAccountLegs>, S>,
    bound: Duration,
) -> Result<Vec<(ProviderAccountId, HomeSignOutError)>, ProviderAccountRegistryError> {
    let accounts = registry.list(None).await?;
    let sign_outs = accounts.into_iter().map(|account| async move {
        let Some(legs) = legs.get(&account.provider) else {
            return Some((account.account_id, HomeSignOutError::NoProvider));
        };
        let folders = credential_home_folders(&account.provider, &account.credential_home);
        let signed_out = tokio::time::timeout(
            bound,
            legs.sign_out_home(account.account_id.clone(), folders),
        )
        .await;
        match signed_out {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some((account.account_id, HomeSignOutError::SignOut(error))),
            Err(_elapsed) => Some((account.account_id, HomeSignOutError::Overran)),
        }
    });
    Ok(futures::future::join_all(sign_outs)
        .await
        .into_iter()
        .flatten()
        .collect())
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

pub mod minted;
#[cfg(any(test, feature = "test-support"))]
pub mod test_legs;
#[cfg(test)]
pub(crate) mod tests;
