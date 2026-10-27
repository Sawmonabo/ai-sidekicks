//! The account homes the app manages, from the accounts table, and the folders each provider's
//! descriptor names in them: the ones it writes for its own diagnosis, which hold no session's
//! files, so only `Delete old data` removes those, and the ones that hold its conversations, which
//! a backup keeps.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sidekicks_contracts::provider::id::ProviderId;

use crate::driver::ProviderDescriptor;
use crate::driver::registry::ProviderRegistry;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

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

/// One account's home and the provider whose account it is.
pub struct AccountHome {
    /// The account's id.
    pub account_id: String,
    /// The provider's id.
    pub provider: String,
    /// The account's home folder.
    pub home: PathBuf,
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

fn query_account_homes(connection: &Connection) -> Result<Vec<AccountHome>, AccountHomesReadError> {
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
