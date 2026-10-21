//! The provider diagnostics in each account home the app manages: every account's home from the
//! accounts table, joined with the folders its provider's descriptor names. No folder that holds a
//! session's files is among them, so only `Delete old data` removes those.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

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

/// Every provider diagnostic folder in every account home; an account whose provider no driver
/// declares has none. Fails when the accounts cannot be read.
pub(crate) async fn read_account_home_diagnostic_folders(
    reads: &DatabaseReadPool,
) -> Result<Vec<PathBuf>, AccountHomesReadError> {
    let homes = reads
        .read(ReadLength::Short, |connection| {
            read_account_homes(connection)
        })
        .await?;
    Ok(homes
        .iter()
        .flat_map(|(provider, home)| account_home_diagnostic_folders(provider, Path::new(home)))
        .collect())
}

fn read_account_homes(
    connection: &Connection,
) -> Result<Vec<(String, String)>, AccountHomesReadError> {
    let mut statement = connection.prepare_cached(ACCOUNT_HOMES_SQL)?;
    let homes = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
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
