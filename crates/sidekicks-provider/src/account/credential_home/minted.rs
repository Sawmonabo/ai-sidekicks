//! The mark a new account's home carries from its mint until a row takes it: a file in the home
//! naming the account's provider, so a start can sign out and remove a home a stop left with no
//! row, while the home of an account removed from the list, which carries no mark, stays as it is.

use std::fs;
use std::io;
use std::path::Path;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;

use super::{ACCOUNT_HOMES_FOLDER_NAME, CredentialHome};

// The mark's file in the home, holding the provider's id.
const MINTED_MARK_FILE_NAME: &str = ".sidekicks-minted";

/// A home minted for a new account, still carrying its mark: the account's id, its provider and
/// its home.
#[derive(Debug)]
pub struct MintedHome {
    /// The account's minted id, the home's folder name.
    pub account_id: ProviderAccountId,
    /// The provider the mark names.
    pub provider: ProviderId,
    /// The home.
    pub home: CredentialHome,
}

/// Marks `home` as minted for an account of `provider` that no row has taken. Fails with the
/// system's error.
pub fn mark_minted(home: &CredentialHome, provider: &ProviderId) -> io::Result<()> {
    fs::write(home.path().join(MINTED_MARK_FILE_NAME), provider.as_str())
}

/// Takes `home`'s mark away once a row names it; a home with no mark changes nothing. Fails with
/// the system's error.
pub fn clear_minted_mark(home: &CredentialHome) -> io::Result<()> {
    match fs::remove_file(home.path().join(MINTED_MARK_FILE_NAME)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        Ok(()) | Err(_) => Ok(()),
    }
}

/// Every home under `data_folder` that still carries its mark, a home whose folder name is no
/// account id or whose mark names no provider id among them left out, as no mint made it. Reads
/// on the calling thread. Fails with the system's error, none where the folder of homes is
/// missing.
pub fn read_minted_homes(data_folder: &Path) -> io::Result<Vec<MintedHome>> {
    let homes = match fs::read_dir(data_folder.join(ACCOUNT_HOMES_FOLDER_NAME)) {
        Ok(homes) => homes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut minted = Vec::new();
    for entry in homes {
        let entry = entry?;
        let home = CredentialHome(entry.path());
        let mark = match fs::read_to_string(home.path().join(MINTED_MARK_FILE_NAME)) {
            Ok(mark) => mark,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let account_id = entry
            .file_name()
            .into_string()
            .ok()
            .and_then(ProviderAccountId::new);
        if let (Some(account_id), Some(provider)) = (account_id, ProviderId::new(mark)) {
            minted.push(MintedHome {
                account_id,
                provider,
                home,
            });
        }
    }
    Ok(minted)
}
