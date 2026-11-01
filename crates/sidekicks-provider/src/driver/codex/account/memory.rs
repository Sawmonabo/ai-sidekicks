//! Where Codex keeps the person's own memory, and where the memory import copies it: their own
//! `memories/` into the account home's, and into the switching home's, which holds the memories
//! of every session that follows the current account whichever account pays for it.

use std::io;

use crate::account::credential_home::CredentialHome;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::service::registry::switching_home;
use crate::driver::contract::account::MemoryImportStore;

// The folder of a Codex home that holds its memories.
const MEMORIES_FOLDER: &str = "memories";

/// The person's own Codex memories, in the folder their environment names, and the two homes they
/// land in for the account whose home is `home`. Looks at no folder.
#[expect(
    clippy::unnecessary_wraps,
    reason = "every provider's stores answer as a listing that can fail"
)]
pub(super) fn codex_memory_import_stores(
    legs: &CodexAccountLegs,
    home: &CredentialHome,
) -> io::Result<Vec<MemoryImportStore>> {
    Ok(vec![MemoryImportStore {
        source: legs.registry.personal_home().join(MEMORIES_FOLDER),
        destinations: vec![
            home.path().join(MEMORIES_FOLDER),
            switching_home(&legs.dependencies.data_folder).join(MEMORIES_FOLDER),
        ],
    }])
}

#[cfg(test)]
mod tests;
