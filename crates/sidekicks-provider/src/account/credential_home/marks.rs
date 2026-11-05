//! The marks the daemon keeps beside the homes, never inside one: a file named for the account in
//! a daemon-owned folder under the data folder, holding the account's provider. A new account
//! carries its minted mark from its mint until a row takes it, which lets a start sign out and
//! remove a home a stop left with no row; the start's sweep reads only that kind. An account
//! removed from the list carries a removed mark this sweep never reads, so its home stays as it
//! is, and the mark tells the erase which kept homes are the app's to sign out.

use std::fs;
use std::io;
use std::path::Path;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::create_missing_private_folders;

use super::{ACCOUNT_HOMES_FOLDER_NAME, CredentialHome};

// The folder of minted marks under the data folder, one file per minted account.
const MINTED_MARKS_FOLDER_NAME: &str = "minted-accounts";

// The folder of removed marks under the data folder, one file per removed account.
const REMOVED_MARKS_FOLDER_NAME: &str = "removed-accounts";

/// A marked account and its home: the account's id, its provider and where its home is, or would
/// be.
#[derive(Debug)]
pub struct MarkedHome {
    /// The account's id.
    pub account_id: ProviderAccountId,
    /// The provider the mark names.
    pub provider: ProviderId,
    /// The account's home, which a stop may have left made, half made or never made.
    pub home: CredentialHome,
}

/// Marks `account_id` under `data_folder` as minted for `provider` and taken by no row, before its
/// home is made. Fails with the system's error.
pub fn mark_minted(
    data_folder: &Path,
    account_id: &ProviderAccountId,
    provider: &ProviderId,
) -> io::Result<()> {
    write_mark(MINTED_MARKS_FOLDER_NAME, data_folder, account_id, provider)
}

/// Marks `account_id` under `data_folder` as `provider`'s account removed from the list, before its
/// row goes, so its kept home stays known as the app's. Fails with the system's error.
pub fn mark_removed(
    data_folder: &Path,
    account_id: &ProviderAccountId,
    provider: &ProviderId,
) -> io::Result<()> {
    write_mark(REMOVED_MARKS_FOLDER_NAME, data_folder, account_id, provider)
}

/// Takes `account_id`'s minted mark under `data_folder` away, once a row names its home or its
/// home is gone; an account with no mark changes nothing. Fails with the system's error.
pub fn clear_minted_mark(data_folder: &Path, account_id: &ProviderAccountId) -> io::Result<()> {
    let mark = data_folder
        .join(MINTED_MARKS_FOLDER_NAME)
        .join(account_id.as_str());
    match fs::remove_file(mark) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        Ok(()) | Err(_) => Ok(()),
    }
}

/// Every account marked minted under `data_folder`, a mark whose name is no account id or whose
/// contents are not UTF-8 or name no provider id left out, as no mint wrote it. Reads on the
/// calling thread. Fails with the system's error, none where the folder of marks is missing.
pub fn read_minted_homes(data_folder: &Path) -> io::Result<Vec<MarkedHome>> {
    read_marks(MINTED_MARKS_FOLDER_NAME, data_folder)
}

/// Every account marked removed under `data_folder`, read as [`read_minted_homes`] reads the
/// minted ones.
pub fn read_removed_homes(data_folder: &Path) -> io::Result<Vec<MarkedHome>> {
    read_marks(REMOVED_MARKS_FOLDER_NAME, data_folder)
}

// Writes `account_id`'s mark naming `provider` into the folder `marks_folder_name` names under
// `data_folder`, made when missing.
fn write_mark(
    marks_folder_name: &str,
    data_folder: &Path,
    account_id: &ProviderAccountId,
    provider: &ProviderId,
) -> io::Result<()> {
    let marks = data_folder.join(marks_folder_name);
    create_missing_private_folders(&marks)?;
    fs::write(marks.join(account_id.as_str()), provider.as_str())
}

// Every account marked in the folder `marks_folder_name` names under `data_folder`, a mark that
// names no account id, or whose contents are not UTF-8 or name no provider id, left out.
fn read_marks(marks_folder_name: &str, data_folder: &Path) -> io::Result<Vec<MarkedHome>> {
    let marks = match fs::read_dir(data_folder.join(marks_folder_name)) {
        Ok(marks) => marks,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let homes = data_folder.join(ACCOUNT_HOMES_FOLDER_NAME);
    let mut marked = Vec::new();
    for entry in marks {
        let entry = entry?;
        let Some(account_id) = entry
            .file_name()
            .into_string()
            .ok()
            .and_then(ProviderAccountId::new)
        else {
            continue;
        };
        let Some(provider) = String::from_utf8(fs::read(entry.path())?)
            .ok()
            .and_then(ProviderId::new)
        else {
            continue;
        };
        marked.push(MarkedHome {
            home: CredentialHome(homes.join(account_id.as_str())),
            account_id,
            provider,
        });
    }
    Ok(marked)
}
