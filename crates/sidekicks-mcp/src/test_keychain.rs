//! One keychain service over the store's in-memory test keychain, and a keychain counting the
//! calls that reach it, for the crate's tests.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::TestStoreAccess;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use tempfile::TempDir;

/// `service`'s keychain over the store's in-memory test keychain, with the in-memory store under
/// it and the data folder it keeps its place record in.
pub(crate) fn test_keychain(
    service: KeychainService,
) -> (TempDir, PlatformCredentialStore, Arc<dyn SecretKeychain>) {
    let data_folder = tempfile::tempdir().expect("the test makes a data folder");
    let credentials = PlatformCredentialStore::in_memory();
    let items = SecretItems::new(SecretItemsStart {
        data_folder: data_folder.path().to_path_buf(),
        runs_while_logged_out: false,
        access: TestStoreAccess::new(credentials.clone()) as _,
        call_timeout: Duration::from_secs(5),
    })
    .expect("the system gives random bytes");
    let keychain = Arc::new(items.keychain(service));
    (data_folder, credentials, keychain)
}

/// A keychain counting the reads and writes that reach the one under it, whose reads a test can
/// set to refuse.
pub(crate) struct CountingKeychain {
    /// The keychain every call goes on to.
    inner: Arc<dyn SecretKeychain>,
    /// The reads made, refused ones included.
    reads: AtomicUsize,
    /// The writes made.
    writes: AtomicUsize,
    /// The cause every read refuses with while set.
    read_refusal: Mutex<Option<KeychainRefusalCause>>,
}

impl CountingKeychain {
    /// A keychain over `inner` that has counted nothing and refuses nothing.
    pub(crate) fn new(inner: Arc<dyn SecretKeychain>) -> Self {
        Self {
            inner,
            reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            read_refusal: Mutex::new(None),
        }
    }

    /// The reads made so far.
    pub(crate) fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    /// The writes made so far.
    pub(crate) fn writes(&self) -> usize {
        self.writes.load(Ordering::SeqCst)
    }

    /// Makes every later read refuse with `cause`, or answer again on `None`.
    pub(crate) fn set_read_refusal(&self, cause: Option<KeychainRefusalCause>) {
        *lock(&self.read_refusal) = cause;
    }
}

impl SecretKeychain for CountingKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.inner.write(account, value)
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        match *lock(&self.read_refusal) {
            Some(cause) => Box::pin(async move { Err(KeychainRefusal::of_test_keychain(cause)) }),
            None => self.inner.read(account),
        }
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        self.inner.remove(account)
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        self.inner.accounts()
    }
}
