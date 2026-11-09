//! The account homes the app manages, from the accounts table, each provider's switching home
//! under the data folder, and the folders each provider's descriptor names in them: the ones it
//! writes for its own diagnosis, which hold no session's files, so only `Delete old data` removes
//! those, and the ones that hold its conversations, which a backup keeps; and every home an erase
//! signs out before it deletes it, the marked ones beside the listed.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sidekicks_contracts::daemon::data::DataEraseAccountListing;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

use crate::account::credential_home::marks::{MarkedHome, read_minted_homes, read_removed_homes};
use crate::account::credential_home::{CredentialHome, HomeSignOut};
use crate::account::resolver::credential_home_folders;
use crate::driver::registry::ProviderRegistry;
use crate::driver::{ProviderAccountFolders, ProviderDescriptor};

const ACCOUNT_HOMES_SQL: &str =
    "SELECT account_id, provider, credential_home_path, removal_intent FROM provider_accounts";

/// Why the account homes could not be read.
#[derive(Debug, thiserror::Error)]
pub enum AccountHomesReadError {
    /// No connection could read.
    #[error("the account homes could not be read")]
    Read(#[from] DatabaseReadError),
    /// The query failed.
    #[error("the account homes could not be queried")]
    Query(#[from] rusqlite::Error),
    /// The marks kept beside the homes could not be read.
    #[error("the marks beside the account homes could not be read")]
    Marks(#[source] io::Error),
    /// A row's account id or provider is no valid id, so the folders in its home are not known and
    /// it cannot be signed out.
    #[error("the home of provider account {account_id} names no valid account or provider id")]
    UnnamedHome {
        /// The row's account id.
        account_id: String,
    },
}

/// One account's home and the provider whose account it is.
pub struct AccountHome {
    /// The account's id.
    pub account_id: String,
    /// The provider's id.
    pub provider: String,
    /// The account's home folder.
    pub home: PathBuf,
    /// Whether the account's removal has begun.
    pub has_removal_begun: bool,
}

impl AccountHome {
    /// The account's folders, by the path rule every provider's account runs on. Fails with
    /// [`AccountHomesReadError::UnnamedHome`] when the row's provider is no provider id.
    pub fn folders(&self) -> Result<ProviderAccountFolders, AccountHomesReadError> {
        let provider = ProviderId::new(self.provider.clone()).ok_or_else(|| self.unnamed())?;
        Ok(self.folders_of(&provider))
    }

    // The account's folders as `provider`'s account.
    fn folders_of(&self, provider: &ProviderId) -> ProviderAccountFolders {
        // The home was read as text, so the round trip back to text loses nothing.
        let home = CredentialHome::from_stored(self.home.to_string_lossy().into_owned());
        credential_home_folders(provider, &home)
    }

    fn unnamed(&self) -> AccountHomesReadError {
        AccountHomesReadError::UnnamedHome {
            account_id: self.account_id.clone(),
        }
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

/// Every account home in the accounts table. Fails when the accounts cannot be read.
pub async fn read_account_homes(
    reads: &DatabaseReadPool,
) -> Result<Vec<AccountHome>, AccountHomesReadError> {
    reads.read(ReadLength::Short, query_account_homes).await
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
                has_removal_begun: row.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(homes)
}

/// One home an erase signs out before it deletes it, and how its account stood on the list.
pub struct HomeToErase {
    /// The account's home.
    pub home: AccountHome,
    /// How the account stood on the list.
    pub listing: DataEraseAccountListing,
}

impl HomeToErase {
    /// The home's sign-out, its account and provider read as ids. Fails with
    /// [`AccountHomesReadError::UnnamedHome`] when the row's account id or provider is no valid id.
    pub fn sign_out(self) -> Result<HomeSignOut, AccountHomesReadError> {
        let home = &self.home;
        let (Some(account_id), Some(provider)) = (
            ProviderAccountId::new(home.account_id.clone()),
            ProviderId::new(home.provider.clone()),
        ) else {
            return Err(home.unnamed());
        };
        Ok(HomeSignOut {
            folders: home.folders_of(&provider),
            account_id,
            provider,
            listing: self.listing,
        })
    }
}

/// Every home an erase deletes, from the accounts table's `rows` and the marks under the daemon's
/// `data_folder`: each row, listed or, once its removal has begun, removed; then each removed
/// account's home no row names; then each home minted for a sign-in that did not finish that no
/// row names. One entry per account, a row winning; a marked home whose folder is gone is left
/// out. Reads on the calling thread. Fails with the system's error.
pub fn homes_to_erase(rows: Vec<AccountHome>, data_folder: &Path) -> io::Result<Vec<HomeToErase>> {
    let removed = read_removed_homes(data_folder)?;
    let minted = read_minted_homes(data_folder)?;
    let mut named: HashSet<String> = rows.iter().map(|row| row.account_id.clone()).collect();
    let mut homes: Vec<HomeToErase> = rows
        .into_iter()
        .map(|home| HomeToErase {
            listing: if home.has_removal_begun {
                DataEraseAccountListing::Removed
            } else {
                DataEraseAccountListing::Listed
            },
            home,
        })
        .collect();
    let marked = (removed
        .into_iter()
        .map(|home| (home, DataEraseAccountListing::Removed)))
    .chain(
        minted
            .into_iter()
            .map(|home| (home, DataEraseAccountListing::SignInUnfinished)),
    );
    for (
        MarkedHome {
            account_id,
            provider,
            home,
        },
        listing,
    ) in marked
    {
        if !named.insert(account_id.as_str().to_owned()) || !home.path().try_exists()? {
            continue;
        }
        homes.push(HomeToErase {
            home: AccountHome {
                account_id: account_id.as_str().to_owned(),
                provider: provider.as_str().to_owned(),
                home: home.path().to_path_buf(),
                has_removal_begun: listing == DataEraseAccountListing::Removed,
            },
            listing,
        });
    }
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
