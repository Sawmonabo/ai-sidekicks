//! The mark a new account carries from its mint until a row takes it: a file named for the
//! account in a daemon-owned folder beside the homes, never in the provider's home, holding the
//! account's provider. It lets a start sign out and remove a home a stop left with no row, while
//! the home of an account removed from the list, which carries no mark, stays as it is.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::create_missing_private_folders;

use super::{ACCOUNT_HOMES_FOLDER_NAME, CredentialHome};

// The folder of marks under the data folder, one file per minted account holding its provider.
const MINTED_MARKS_FOLDER_NAME: &str = "minted-accounts";

/// An account minted and marked, whose home a row may not yet name: the account's id, its
/// provider and where its home is, or would be.
#[derive(Debug)]
pub struct MintedHome {
    /// The account's minted id.
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
    let marks = data_folder.join(MINTED_MARKS_FOLDER_NAME);
    create_missing_private_folders(&marks)?;
    fs::write(marks.join(account_id.as_str()), provider.as_str())
}

/// Takes `account_id`'s mark under `data_folder` away, once a row names its home or its home is
/// gone; an account with no mark changes nothing. Fails with the system's error.
pub fn clear_minted_mark(data_folder: &Path, account_id: &ProviderAccountId) -> io::Result<()> {
    match fs::remove_file(mark_path(data_folder, account_id)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        Ok(()) | Err(_) => Ok(()),
    }
}

/// Every account marked under `data_folder`, a mark whose name is no account id or whose contents
/// name no provider id left out, as no mint wrote it. Reads on the calling thread. Fails with the
/// system's error, none where the folder of marks is missing.
pub fn read_minted_homes(data_folder: &Path) -> io::Result<Vec<MintedHome>> {
    let marks = match fs::read_dir(data_folder.join(MINTED_MARKS_FOLDER_NAME)) {
        Ok(marks) => marks,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let homes = data_folder.join(ACCOUNT_HOMES_FOLDER_NAME);
    let mut minted = Vec::new();
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
        let Some(provider) = ProviderId::new(fs::read_to_string(entry.path())?) else {
            continue;
        };
        minted.push(MintedHome {
            home: CredentialHome(homes.join(account_id.as_str())),
            account_id,
            provider,
        });
    }
    Ok(minted)
}

// Where `account_id`'s mark is kept under `data_folder`.
fn mark_path(data_folder: &Path, account_id: &ProviderAccountId) -> PathBuf {
    data_folder
        .join(MINTED_MARKS_FOLDER_NAME)
        .join(account_id.as_str())
}
