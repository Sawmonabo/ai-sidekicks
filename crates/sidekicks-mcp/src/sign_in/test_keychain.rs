//! The sign-ins' keychain service over the store's in-memory test keychain, for the sign-in's
//! tests.

use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::TestStoreAccess;
use sidekicks_store::credential_store::service::KeychainService;
use tempfile::TempDir;

/// The sign-ins' keychain service over the store's in-memory test keychain, with the in-memory
/// store under it and the data folder it keeps its place record in.
pub(crate) fn test_keychain() -> (TempDir, PlatformCredentialStore, Arc<dyn SecretKeychain>) {
    let data_folder = tempfile::tempdir().expect("the test makes a data folder");
    let credentials = PlatformCredentialStore::in_memory();
    let items = SecretItems::new(SecretItemsStart {
        data_folder: data_folder.path().to_path_buf(),
        runs_while_logged_out: false,
        access: TestStoreAccess::new(credentials.clone()) as _,
        call_timeout: Duration::from_secs(5),
    })
    .expect("the system gives random bytes");
    let keychain = Arc::new(items.keychain(KeychainService::McpSignIns));
    (data_folder, credentials, keychain)
}
