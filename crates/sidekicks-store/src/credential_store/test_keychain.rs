//! A keychain service over the in-memory test store, and a keychain counting the calls that reach
//! it, for the tests of the crates that keep secrets.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::pause_point::PausePoint;
use tempfile::TempDir;

use crate::credential_store::items::{SecretItems, SecretItemsStart};
use crate::credential_store::os::TestStoreAccess;
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};

/// `service`'s keychain over an in-memory platform store, with that store and the data folder
/// it keeps its place record in, which must outlive the keychain.
pub fn test_keychain(
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
/// refuse, once or until told otherwise, and hold at a pause point.
pub struct CountingKeychain {
    /// The keychain every call goes on to.
    inner: Arc<dyn SecretKeychain>,
    /// The reads made, refused ones included.
    reads: AtomicUsize,
    /// The writes made.
    writes: AtomicUsize,
    /// The cause every read refuses with while set.
    read_refusal: Mutex<Option<KeychainRefusalCause>>,
    /// The cause the next read alone refuses with.
    next_read_refusal: Mutex<Option<KeychainRefusalCause>>,
    /// Where a read waits while a test holds it.
    read_pause: PausePoint,
}

impl CountingKeychain {
    /// A keychain over `inner` that has counted nothing and refuses nothing.
    pub fn new(inner: Arc<dyn SecretKeychain>) -> Self {
        Self {
            inner,
            reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            read_refusal: Mutex::new(None),
            next_read_refusal: Mutex::new(None),
            read_pause: PausePoint::default(),
        }
    }

    /// The keychain under this one, whose calls are not counted.
    pub fn inner(&self) -> &dyn SecretKeychain {
        &*self.inner
    }

    /// The reads made so far.
    pub fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    /// The writes made so far.
    pub fn writes(&self) -> usize {
        self.writes.load(Ordering::SeqCst)
    }

    /// Makes every later read refuse with `cause`, or answer again on `None`.
    pub fn set_read_refusal(&self, cause: Option<KeychainRefusalCause>) {
        *lock(&self.read_refusal) = cause;
    }

    /// Makes the next read alone refuse with `cause`.
    pub fn refuse_next_read(&self, cause: KeychainRefusalCause) {
        *lock(&self.next_read_refusal) = Some(cause);
    }

    /// The pause point every read passes once its answer is known.
    pub fn read_pause(&self) -> &PausePoint {
        &self.read_pause
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
        let refusal = lock(&self.next_read_refusal)
            .take()
            .or(*lock(&self.read_refusal));
        Box::pin(async move {
            let answer = match refusal {
                Some(cause) => Err(KeychainRefusal::of_test_keychain(cause)),
                None => self.inner.read(account).await,
            };
            self.read_pause.pass().await;
            answer
        })
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
