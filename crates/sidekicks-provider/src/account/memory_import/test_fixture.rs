//! A person's own home and a daemon's data folder, both temporary, with a registry over a test
//! database, for the memory import's tests through each provider's legs.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountMemoryImportOutcome,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;

use super::{MemoryImportError, import_memory};
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::{
    AccountAdmission, ProviderAccountRegistry, RegisteredAccount, open_test_registry,
};
use crate::driver::contract::account::ProviderMemoryImportLegs;
use crate::driver::schema::schema_parts;

/// Every file under `folder` with its bytes, by its path under `folder`; a link reads as its
/// target, so a changed link changes the snapshot too.
pub(crate) fn snapshot(folder: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in fs::read_dir(&next).expect("a folder lists") {
            let path = entry.expect("an entry reads").path();
            let relative = path
                .strip_prefix(folder)
                .expect("under the folder")
                .to_owned();
            let metadata = fs::symlink_metadata(&path).expect("an entry is looked at");
            if metadata.is_dir() {
                files.insert(relative, Vec::new());
                pending.push(path);
            } else if metadata.is_symlink() {
                let target = fs::read_link(&path).expect("a link reads");
                files.insert(relative, target.into_os_string().into_encoded_bytes());
            } else {
                files.insert(relative, fs::read(&path).expect("a file reads"));
            }
        }
    }
    files
}

/// Writes `bytes` at `path`, its folders made.
pub(crate) fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().expect("a file has a folder")).expect("its folder is made");
    fs::write(path, bytes).expect("the file is written");
}

/// One person's own home and one daemon's data folder, both temporary, with a registry over a test
/// database whose homes are minted in that data folder.
pub(crate) struct Fixture {
    pub(crate) own_home: TempDir,
    pub(crate) data_folder: TempDir,
    pub(crate) database: TestDatabase,
    registry: ProviderAccountRegistry,
    home_lock: AccountHomeLock,
}

impl Fixture {
    /// The two folders and the registry.
    pub(crate) async fn new() -> Self {
        let own_home = tempfile::tempdir().expect("the person's own home is made");
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let database = TestDatabase::new(schema_parts());
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
        Self {
            own_home,
            data_folder,
            database,
            registry,
            home_lock: AccountHomeLock::default(),
        }
    }

    /// The registry the fixture's accounts are in.
    pub(crate) fn registry(&self) -> &ProviderAccountRegistry {
        &self.registry
    }

    /// A registered `provider` account, its home minted in the data folder.
    pub(crate) async fn account(&self, provider: &str) -> RegisteredAccount {
        let provider = ProviderId::new(provider.to_owned()).expect("a provider id");
        let minted = self.registry.mint(provider).expect("the account is minted");
        self.registry
            .admit(
                &minted,
                &AccountAdmission {
                    display_label: None,
                    billing_mode: BillingMode::Subscription,
                    health: None,
                    observed_auth_mode: None,
                },
            )
            .await
            .expect("the account is admitted")
    }

    /// Imports the person's memory into `account`'s home through `legs`.
    pub(crate) async fn import(
        &self,
        legs: &Arc<dyn ProviderMemoryImportLegs>,
        account: &RegisteredAccount,
    ) -> Result<ProviderAccountMemoryImportOutcome, MemoryImportError> {
        import_memory(
            &self.registry,
            &self.home_lock,
            Arc::clone(legs),
            account.account_id.clone(),
        )
        .await
    }
}

/// The count of an `imported` outcome, `None` for `nothingToImport`.
pub(crate) fn imported_count(outcome: &ProviderAccountMemoryImportOutcome) -> Option<u64> {
    match outcome {
        ProviderAccountMemoryImportOutcome::Imported { count, .. } => Some(count.get()),
        ProviderAccountMemoryImportOutcome::NothingToImport {} => None,
    }
}
