//! The account homes the app manages, from the accounts table, and the provider diagnostic folders
//! in each, which its provider's descriptor names. No folder that holds a session's files is among
//! them, so only `Delete old data` removes those.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::daemon::scheduler::budget::ProcessorMeter;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::provider::driver::PROVIDERS;

const ACCOUNT_HOMES_SQL: &str = "SELECT provider, credential_home_path FROM provider_accounts";

/// Why the account homes could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AccountHomesReadError {
    /// No connection could read.
    #[error("the account homes could not be read")]
    Read(#[from] DatabaseReadError),
    /// The query failed.
    #[error("the account homes could not be queried")]
    Query(#[from] rusqlite::Error),
}

/// One account's home and the provider whose account it is.
pub(crate) struct AccountHome {
    /// The provider's id.
    pub(crate) provider: String,
    /// The account's home folder.
    pub(crate) home: PathBuf,
}

/// Every account home in the accounts table, the query's time on the pool's thread charged to
/// `meter`. Fails when the accounts cannot be read.
pub(crate) async fn read_account_homes(
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
                provider: row.get(0)?,
                home: PathBuf::from(row.get::<_, String>(1)?),
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(homes)
}

/// The diagnostic folders `provider`'s descriptor names, under `home`.
pub(crate) fn account_home_diagnostic_folders(provider: &str, home: &Path) -> Vec<PathBuf> {
    PROVIDERS
        .iter()
        .filter(|descriptor| descriptor.id == provider)
        .flat_map(|descriptor| descriptor.account_home_diagnostic_folders)
        .map(|components| {
            components
                .iter()
                .fold(home.to_path_buf(), |path, part| path.join(part))
        })
        .collect()
}
