//! The account homes the app manages, from the accounts table, each provider's switching home
//! under the data folder, and the folders each provider's descriptor names in them: the ones it
//! writes for its own diagnosis, which hold no session's files, so only `Delete old data` removes
//! those, and the ones that hold its conversations, which a backup keeps.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

use crate::account::credential_home::CredentialHome;
use crate::account::resolver::credential_home_folders;
use crate::driver::registry::ProviderRegistry;
use crate::driver::{ProviderAccountFolders, ProviderDescriptor};

const ACCOUNT_HOMES_SQL: &str =
    "SELECT account_id, provider, credential_home_path FROM provider_accounts";

/// Why the account homes could not be read.
#[derive(Debug, thiserror::Error)]
pub enum AccountHomesReadError {
    /// No connection could read.
    #[error("the account homes could not be read")]
    Read(#[from] DatabaseReadError),
    /// The query failed.
    #[error("the account homes could not be queried")]
    Query(#[from] rusqlite::Error),
}

/// An account home whose row names no provider id, so the folders in it are not known.
#[derive(Debug, thiserror::Error)]
#[error("the home of provider account {account_id} names no provider id")]
pub struct UnknownAccountHomeProvider {
    /// The row's account id.
    pub account_id: String,
}

/// One account's home and the provider whose account it is.
pub struct AccountHome {
    /// The account's id.
    pub account_id: String,
    /// The provider's id.
    pub provider: String,
    /// The account's home folder.
    pub home: PathBuf,
}

impl AccountHome {
    /// The account's folders, by the path rule every provider's account runs on. Fails naming the
    /// account when the row's provider is no provider id.
    pub fn folders(&self) -> Result<ProviderAccountFolders, UnknownAccountHomeProvider> {
        let provider =
            ProviderId::new(self.provider.clone()).ok_or_else(|| UnknownAccountHomeProvider {
                account_id: self.account_id.clone(),
            })?;
        // The home was read as text, so the round trip back to text loses nothing.
        let home = CredentialHome::from_stored(self.home.to_string_lossy().into_owned());
        Ok(credential_home_folders(&provider, &home))
    }
}

/// One provider's switching home, apart from every account home, where its one switching service
/// keeps the conversations of every session that followed the current account.
pub struct SwitchingHome {
    /// The provider's id.
    pub provider: String,
    /// The home folder.
    pub home: PathBuf,
}

/// The switching home under the daemon's `data_folder` of each provider in `providers` whose
/// descriptor names one, whether or not its service ever ran.
pub fn switching_homes(providers: &ProviderRegistry, data_folder: &Path) -> Vec<SwitchingHome> {
    providers
        .drivers()
        .filter_map(|(provider, _)| {
            let folder = providers.descriptor(provider).ok()?.switching_home_folder?;
            Some(SwitchingHome {
                provider: provider.as_str().to_owned(),
                home: data_folder.join(folder),
            })
        })
        .collect()
}

/// Every account home in the accounts table, the query's time on the pool's thread charged to
/// `meter`. Fails when the accounts cannot be read.
pub async fn read_account_homes(
    reads: &DatabaseReadPool,
    meter: &ProcessorMeter,
) -> Result<Vec<AccountHome>, AccountHomesReadError> {
    let meter = meter.clone();
    reads
        .read(ReadLength::Short, move |connection| {
            meter.measure(|| query_account_homes(connection))
        })
        .await
}

/// Every account home in the accounts table, read on `connection`, for a caller that holds one read
/// connection of its own with no pool, such as a helper mode. Fails when the query fails.
pub fn query_account_homes(
    connection: &Connection,
) -> Result<Vec<AccountHome>, AccountHomesReadError> {
    let mut statement = connection.prepare_cached(ACCOUNT_HOMES_SQL)?;
    let homes = statement
        .query_map([], |row| {
            Ok(AccountHome {
                account_id: row.get(0)?,
                provider: row.get(1)?,
                home: PathBuf::from(row.get::<_, String>(2)?),
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(homes)
}

/// The diagnostic folders `provider`'s descriptor in `providers` names, under `home`.
pub fn account_home_diagnostic_folders(
    providers: &ProviderRegistry,
    provider: &str,
    home: &Path,
) -> Vec<PathBuf> {
    descriptor_folders(providers, provider, home, |descriptor| {
        descriptor.account_home_diagnostic_folders
    })
    .map(|(_, folder)| folder)
    .collect()
}

/// The conversation folders `provider`'s descriptor in `providers` names, each with its
/// components, under `home`.
pub fn account_home_conversation_folders(
    providers: &ProviderRegistry,
    provider: &str,
    home: &Path,
) -> Vec<(&'static [&'static str], PathBuf)> {
    descriptor_folders(providers, provider, home, |descriptor| {
        descriptor.account_home_conversation_folders
    })
    .collect()
}

// The folders `folders_of` reads from `provider`'s descriptor, each with its components, under
// `home`; an account whose provider no driver answers names none.
fn descriptor_folders<'home>(
    providers: &ProviderRegistry,
    provider: &str,
    home: &'home Path,
    folders_of: fn(&ProviderDescriptor) -> &'static [&'static [&'static str]],
) -> impl Iterator<Item = (&'static [&'static str], PathBuf)> + 'home {
    ProviderId::new(provider.to_owned())
        .and_then(|provider| providers.descriptor(&provider).ok())
        .into_iter()
        .flat_map(folders_of)
        .map(move |components| {
            let folder = components
                .iter()
                .fold(home.to_path_buf(), |path, part| path.join(part));
            (*components, folder)
        })
}
