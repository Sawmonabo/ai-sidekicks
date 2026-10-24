//! The items kept in the operating system's credential store: the macOS login keychain and the
//! Windows Credential Manager. Linux offers no such store: its secrets are sealed by systemd's
//! credential service into the items file.
//!
//! The store is opened at the first call that needs it and kept for the run; a store that does not
//! open is tried again at the next call.
//!
//! A store call blocks until the store answers, and a locked store answers only once the person
//! answers its unlock prompt, so each call runs on a blocking thread and is answered `locked` when
//! it gets no answer within its time. The calls on one entry run one at a time, and the entry stays
//! held until the store's answer even after its caller stopped waiting, so a locked store holds at
//! most one blocking thread per entry, and a late answer always lands before the next call on that
//! entry runs, so it never overwrites a retry's value. A call that is still queued for its entry
//! when its caller stops waiting leaves the queue and never reaches the store; one that lands after
//! its caller stopped waiting is logged.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{CredentialStore, CredentialStoreError, SecretStoreOffer};

use crate::credential_store::seal::SecretSeal;
use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::keyed_lock::KeyedLock;

/// How long one keychain call may take, its waits and an unlock prompt included.
#[expect(dead_code, reason = "the daemon's start passes it")]
pub(crate) const KEYCHAIN_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// What this machine offers for the daemon's secrets, and what holds them in words for the service
/// log; a test supplies an offer of its own.
pub(crate) trait CredentialStoreAccess: Send + Sync {
    /// The machine's offer: the operating system's credential store on macOS and Windows,
    /// systemd's credential service on Linux.
    fn offer(&self) -> SecretsOffer;

    /// What holds the secrets, in words for the service log.
    fn description(&self) -> String;
}

/// What this machine offers for the daemon's secrets.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start hands the machine's offer to the secret items"
    )
)]
pub(crate) enum SecretsOffer {
    /// The operating system's credential store, which `StoreOpen` opens.
    OperatingSystem(StoreOpen),
    /// systemd's credential service, which seals each secret into the items file.
    SealService(Arc<dyn SecretSeal>),
}

/// Opens the operating system's credential store, blocking while it does. Fails with
/// [`CredentialStoreError`] when the store cannot be built.
pub(crate) type StoreOpen =
    Arc<dyn Fn() -> Result<CredentialStore, CredentialStoreError> + Send + Sync>;

/// What this machine offers for the daemon's secrets, through the platforms crate.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start hands it to the secret items")
)]
pub(crate) struct SystemCredentialStore {
    /// The machine's offer, read once at the start.
    pub(crate) offer: SecretStoreOffer,
}

impl CredentialStoreAccess for SystemCredentialStore {
    fn offer(&self) -> SecretsOffer {
        match &self.offer {
            SecretStoreOffer::OperatingSystem(opener) => {
                let opener = *opener;
                SecretsOffer::OperatingSystem(Arc::new(move || opener.open()))
            }
            SecretStoreOffer::SealService(seal) => {
                SecretsOffer::SealService(Arc::new(seal.clone()))
            }
        }
    }

    fn description(&self) -> String {
        match &self.offer {
            SecretStoreOffer::OperatingSystem(opener) => opener.description().to_owned(),
            SecretStoreOffer::SealService(seal) => format!(
                "systemd's credential service at {}",
                seal.socket_path().display()
            ),
        }
    }
}

/// The operating system's credential store and the lock each of its entries is called under,
/// shared by every service's keychain on it; see the module doc.
pub(crate) struct OsCredentialStore {
    /// Opens the store.
    open: StoreOpen,
    /// The store once opened.
    opened: Mutex<Option<CredentialStore>>,
    /// Held by each call on an entry, by service and account, until the store answers; a listing
    /// holds its service with no account.
    entries: Arc<KeyedLock<(String, String)>>,
    /// How long a caller waits for its call, the wait for the entry included.
    call_timeout: Duration,
}

impl OsCredentialStore {
    /// The calls on the store `open` opens, each answered within `call_timeout`, its wait for the
    /// entry included.
    pub(crate) fn new(open: StoreOpen, call_timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            open,
            opened: Mutex::new(None),
            entries: Arc::new(KeyedLock::new()),
            call_timeout,
        })
    }

    /// The items filed under `service` in this store, sharing its per-entry lock with every other
    /// service's, each call answered within the store's time.
    pub(crate) fn keychain(self: &Arc<Self>, service: &str) -> OsSecretKeychain {
        OsSecretKeychain {
            store: Arc::clone(self),
            service: service.to_owned(),
        }
    }

    /// Lists every item filed under `service`, which raises the store's unlock prompt where it
    /// has one. Fails with [`KeychainRefusal`] when the store is locked or cannot be used.
    pub(crate) async fn check_items(
        self: &Arc<Self>,
        service: &str,
    ) -> Result<(), KeychainRefusal> {
        self.call(service, "", |credentials, service, _| {
            credentials.accounts(service).map(drop)
        })
        .await
    }

    /// Removes every item filed under `service`, each through its own handle. Fails with
    /// [`KeychainRefusal`] when the store is locked or cannot be used, the items before the failure
    /// already gone.
    pub(crate) async fn erase_items(
        self: &Arc<Self>,
        service: &str,
    ) -> Result<(), KeychainRefusal> {
        self.call(service, "", |credentials, service, _| {
            for item in credentials.accounts(service)? {
                item.remove()?;
            }
            Ok(())
        })
        .await
    }

    // Runs `operation` on the entry under `service` and `account` once every earlier call on it has
    // answered, on a blocking thread, and answers `locked` when that takes longer than the store's
    // time. The entry stays held until the store answers even after the caller stops
    // waiting; a call still queued for the entry then leaves the queue.
    async fn call<Answer: Send + 'static>(
        self: &Arc<Self>,
        service: &str,
        account: &str,
        operation: impl FnOnce(&CredentialStore, &str, &str) -> Result<Answer, CredentialStoreError>
        + Send
        + 'static,
    ) -> Result<Answer, KeychainRefusal> {
        let store = Arc::clone(self);
        let (service, account) = (service.to_owned(), account.to_owned());
        let logged_service = service.clone();
        let held_call = self.entries.run_held(
            (service.clone(), account.clone()),
            async move {
                tokio::task::spawn_blocking(move || {
                    operation(&store.opened_store()?, &service, &account)
                })
                .await
            },
            move |answer| {
                tracing::warn!(
                    service = logged_service,
                    is_answered = matches!(answer, Ok(Ok(_))),
                    "A credential store call landed after its caller stopped waiting"
                );
            },
        );
        let call_timeout = self.call_timeout;
        match tokio::time::timeout(call_timeout, held_call).await {
            Ok(Ok(Some(Ok(Ok(answer))))) => Ok(answer),
            Ok(Ok(Some(Ok(Err(refused))))) => {
                let cause = if refused.is_locked() {
                    KeychainRefusalCause::Locked
                } else {
                    KeychainRefusalCause::Unavailable
                };
                Err(KeychainRefusal::new(cause, refused.to_string()).with_failure(refused))
            }
            Ok(Ok(Some(Err(interrupted))) | Err(interrupted)) => Err(KeychainRefusal::new(
                KeychainRefusalCause::Unavailable,
                "the credential store call ended without an answer",
            )
            .with_failure(interrupted)),
            // The task skips the store only once this caller stopped waiting, so this arm is the
            // same answer the timeout gives.
            Ok(Ok(None)) | Err(_) => Err(KeychainRefusal::new(
                KeychainRefusalCause::Locked,
                format!("the credential store gave no answer within {call_timeout:?}"),
            )),
        }
    }

    // The open store, opened now when no call has opened it yet.
    fn opened_store(&self) -> Result<CredentialStore, CredentialStoreError> {
        let mut opened = self.opened.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(credentials) = opened.as_ref() {
            return Ok(credentials.clone());
        }
        let credentials = (self.open)()?;
        *opened = Some(credentials.clone());
        Ok(credentials)
    }
}

/// What a test hands the daemon: the operating system's store over one store, which the test
/// switches between opening and not, or systemd's credential service as a test's seal.
#[cfg(test)]
pub(crate) struct TestStoreAccess {
    /// What the test offers.
    offer: TestOffer,
    /// Whether the store opens.
    pub(crate) opens: Arc<std::sync::atomic::AtomicBool>,
}

// What a test's access offers.
#[cfg(test)]
enum TestOffer {
    Store(CredentialStore),
    Seal(Arc<crate::credential_store::seal::TestSeal>),
}

#[cfg(test)]
impl TestStoreAccess {
    /// The operating system's store over `credentials`, which opens.
    pub(crate) fn new(credentials: CredentialStore) -> Arc<Self> {
        Self::offering(TestOffer::Store(credentials))
    }

    /// systemd's credential service as `seal`.
    pub(crate) fn sealing(seal: Arc<crate::credential_store::seal::TestSeal>) -> Arc<Self> {
        Self::offering(TestOffer::Seal(seal))
    }

    fn offering(offer: TestOffer) -> Arc<Self> {
        Arc::new(Self {
            offer,
            opens: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        })
    }
}

#[cfg(test)]
impl CredentialStoreAccess for TestStoreAccess {
    fn offer(&self) -> SecretsOffer {
        match &self.offer {
            TestOffer::Store(credentials) => {
                let (credentials, opens) = (credentials.clone(), Arc::clone(&self.opens));
                SecretsOffer::OperatingSystem(Arc::new(move || {
                    if opens.load(std::sync::atomic::Ordering::SeqCst) {
                        Ok(credentials.clone())
                    } else {
                        Err(CredentialStoreError::unusable(
                            "the test's store does not open",
                        ))
                    }
                }))
            }
            TestOffer::Seal(seal) => SecretsOffer::SealService(Arc::clone(seal) as _),
        }
    }

    fn description(&self) -> String {
        match &self.offer {
            TestOffer::Store(_) => "the test's store".to_owned(),
            TestOffer::Seal(_) => "the test's seal".to_owned(),
        }
    }
}

/// One keychain service's items in the operating system's credential store; see the module doc.
pub(crate) struct OsSecretKeychain {
    /// The store, shared with every other service's keychain on it.
    store: Arc<OsCredentialStore>,
    /// The keychain service the items are filed under.
    service: String,
}

impl SecretKeychain for OsSecretKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        let value = value.clone();
        Box::pin(self.store.call(
            &self.service,
            account,
            move |credentials, service, account| credentials.write(service, account, &value),
        ))
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        Box::pin(
            self.store
                .call(&self.service, account, CredentialStore::read),
        )
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        Box::pin(
            self.store
                .call(&self.service, account, CredentialStore::remove),
        )
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        Box::pin(
            self.store
                .call(&self.service, "", |credentials, service, _| {
                    Ok(credentials
                        .accounts(service)?
                        .iter()
                        .map(|item| item.account().to_owned())
                        .collect())
                }),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use secrecy::{ExposeSecret, SecretString};
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_platforms::{BlockingCredentialStore, CredentialStore};

    use super::OsCredentialStore;
    use crate::credential_store::SecretKeychain;
    use crate::credential_store::service::KeychainService;

    // A store over `blocking_store`, each call answered within `call_timeout`.
    fn store_over(
        blocking_store: &Arc<BlockingCredentialStore>,
        call_timeout: Duration,
    ) -> Arc<OsCredentialStore> {
        let credentials = CredentialStore::from_store(blocking_store.clone());
        OsCredentialStore::new(Arc::new(move || Ok(credentials.clone())), call_timeout)
    }

    /// A call the store does not answer in time reads `locked`; a second call on the same entry
    /// while the first holds it reads `locked` too, leaves the entry's queue at once with its store
    /// handle, and never reaches the store, even once the first's call ends. Mutation: race no
    /// `select!` against the caller giving up, so the second call's task stays queued holding the
    /// store until the first's call ends (the outer timeout fails the test).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_held_entry_answers_locked_and_a_call_given_up_never_reaches_the_store() {
        let blocking_store = BlockingCredentialStore::new();
        let store = store_over(&blocking_store, Duration::from_millis(200));
        let keychain = Arc::new(store.keychain(KeychainService::WorkflowSecrets.as_str()));
        let handles_idle = Arc::strong_count(&store);

        let scenario = async {
            let first = tokio::spawn({
                let keychain = Arc::clone(&keychain);
                async move { keychain.read("secret").await.map(drop) }
            });
            blocking_store.wait_for_calls(1).await;
            let handles_before_second = Arc::strong_count(&store);
            let second = keychain.read("secret").await.map(drop);
            // The second call's task lets go of its store handle as soon as its caller gives up.
            while Arc::strong_count(&store) > handles_before_second {
                tokio::task::yield_now().await;
            }
            let first = first.await.expect("the first call's task ends");
            let calls_while_held = blocking_store.calls();

            blocking_store.release();
            // Once the first call's task lets go of the entry, the next call takes it at once.
            while Arc::strong_count(&store) > handles_idle {
                tokio::task::yield_now().await;
            }
            let third = tokio::spawn({
                let keychain = Arc::clone(&keychain);
                async move { keychain.read("secret").await.map(drop) }
            });
            blocking_store.wait_for_calls(2).await;
            drop(third.await.expect("the third call's task ends"));
            (first, second, calls_while_held)
        };
        let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
        blocking_store.release();
        let (first, second, calls_while_held) =
            outcome.expect("every call answers within its time");

        for refused in [first, second] {
            assert_eq!(
                refused
                    .expect_err("a call with no answer is refused")
                    .cause(),
                KeychainRefusalCause::Locked
            );
        }
        assert_eq!(calls_while_held, 1);
        assert_eq!(blocking_store.calls(), 2);
    }

    /// A write held past its caller's time, then a retry with another value: the retry reaches the
    /// store only after the late write lands, so the item holds the retry's value. Mutation: let
    /// go of the entry when the caller gives up, so the retry's write reaches the store beside the
    /// late one and either may land last.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_late_write_lands_before_the_retry_and_never_overwrites_it() {
        let blocking_store = BlockingCredentialStore::new();
        let store = store_over(&blocking_store, Duration::from_millis(200));
        let keychain = Arc::new(store.keychain(KeychainService::WorkflowSecrets.as_str()));

        let scenario = async {
            let late = keychain
                .write("secret", &SecretString::from("first"))
                .await
                .expect_err("a write with no answer in time is refused");
            let retry = tokio::spawn({
                let keychain = Arc::clone(&keychain);
                async move {
                    keychain
                        .write("secret", &SecretString::from("second"))
                        .await
                }
            });
            // Long enough for a retry that took the entry to reach the store.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let calls_before_release = blocking_store.calls();
            blocking_store.release();
            let retry = retry.await.expect("the retry's task ends");
            (late, retry, calls_before_release)
        };
        let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
        blocking_store.release();
        let (late, retry, calls_before_release) =
            outcome.expect("every call answers within its time");

        assert_eq!(late.cause(), KeychainRefusalCause::Locked);
        retry.expect("the retry is written once the late write lands");
        assert_eq!(calls_before_release, 1);
        let kept = keychain.read("secret").await.expect("the store answers");
        assert_eq!(
            kept.as_ref().map(ExposeSecret::expose_secret),
            Some("second")
        );
    }
}
