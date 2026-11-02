//! Where Codex keeps the person's own memory, and where the memory import copies it: each of
//! Codex's memory stores the person has, its first `memories/` or its second `memories_v2/`, into
//! the same store of the account home and of the switching home, which holds the memories of every
//! session that follows the current account whichever account pays for it. A store copied only
//! into the one the person uses keeps a home on the store Codex picks for the person, since Codex
//! picks its second store only for a home that has no first.

use std::io;

use crate::account::credential_home::CredentialHome;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::service::registry::switching_home;
use crate::driver::contract::account::MemoryImportStore;

// The folders of a Codex home that hold its memories, one per store: the first, and the second,
// which Codex keeps beside it.
const MEMORY_STORE_FOLDERS: [&str; 2] = ["memories", "memories_v2"];

/// The person's own Codex memory stores, in the folder their environment names, each with the same
/// store of the two homes it lands in for the account whose home is `home`; a store the person
/// does not have is skipped by the import. Looks at no folder.
#[expect(
    clippy::unnecessary_wraps,
    reason = "every provider's stores answer as a listing that can fail"
)]
pub(super) fn codex_memory_import_stores(
    legs: &CodexAccountLegs,
    home: &CredentialHome,
) -> io::Result<Vec<MemoryImportStore>> {
    let personal_home = legs.registry.personal_home();
    let switching_home = switching_home(&legs.dependencies.data_folder);
    Ok(MEMORY_STORE_FOLDERS
        .iter()
        .map(|folder| MemoryImportStore {
            source: personal_home.join(folder),
            destinations: vec![home.path().join(folder), switching_home.join(folder)],
        })
        .collect())
}

#[cfg(test)]
mod tests;
