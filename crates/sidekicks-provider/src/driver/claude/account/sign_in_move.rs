//! Where each Claude Code account's sign-in moves between the keychain item Claude Code files for
//! that account's store folder and the `.credentials.json` it keeps there where the keychain is not
//! used: the item's names and the file, which a helper mode moves the sign-in by, and the daemon
//! start's sweep of the temporary files a move stopped mid-write left beside that file.

use std::io;
use std::path::PathBuf;

use sidekicks_platforms::{KeychainSignIn, sign_in_move};

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::registry::ProviderAccountRegistry;
use crate::account::resolver::credential_home_folders;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::credentials::{
    CLAUDE_CREDENTIALS_FILE, claude_keychain_account, claude_keychain_service,
};

/// Why the sweep of a stopped move's leftovers did not run.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeLeftoverSweepError {
    /// The registered accounts could not be listed.
    #[error(transparent)]
    Accounts(#[from] ProviderAccountRegistryError),
    /// The sweep's blocking task ended without an answer.
    #[error("the sweep of the sign-in move's leftovers ended without an answer")]
    Stopped(#[source] tokio::task::JoinError),
}

/// Removes the temporary files a sign-in move stopped mid-write left beside each registered
/// Claude Code account's sign-in file, as the daemon's start does before any move can run;
/// nothing on a system with no move. Answers each leftover that could not be removed, for the
/// caller to log. Fails when the accounts cannot be listed, or the sweep's task ended without
/// an answer.
pub(crate) async fn remove_claude_sign_in_move_leftovers(
    registry: &ProviderAccountRegistry,
) -> Result<Vec<io::Error>, ClaudeLeftoverSweepError> {
    let Some(mover) = sign_in_move() else {
        return Ok(Vec::new());
    };
    let files: Vec<PathBuf> = registry
        .list(Some(DESCRIPTOR.provider_id()))
        .await?
        .iter()
        .map(|account| {
            sign_in_file(&credential_home_folders(
                &account.provider,
                &account.credential_home,
            ))
        })
        .collect();
    tokio::task::spawn_blocking(move || mover.remove_leftovers(&files))
        .await
        .map_err(ClaudeLeftoverSweepError::Stopped)
}

/// The keychain item a Claude Code process started in `environment` files the sign-in of the
/// account in `folders` under, and the file that sign-in moves into.
pub(super) fn claude_keychain_sign_in(
    environment: &[(String, String)],
    folders: &ProviderAccountFolders,
) -> KeychainSignIn {
    KeychainSignIn {
        service: claude_keychain_service(environment),
        account: claude_keychain_account(environment),
        file: sign_in_file(folders),
    }
}

// The file the sign-in of the account in `folders` moves into where the keychain is not used:
// `.credentials.json` in its credential store folder.
fn sign_in_file(folders: &ProviderAccountFolders) -> PathBuf {
    folders
        .credential_store_folder
        .join(CLAUDE_CREDENTIALS_FILE)
}

#[cfg(test)]
mod tests;
