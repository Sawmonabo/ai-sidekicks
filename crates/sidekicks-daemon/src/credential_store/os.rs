//! The items kept in the operating system's credential store: the macOS login keychain, the
//! Windows Credential Manager, and on Linux the Secret Service.
//!
//! The store is opened at the first call that needs it, and again at the next call after one that
//! could not use it, since a Secret Service started later, or restarted, is reached only through a
//! new connection; a locked store keeps its connection.
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

use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{
    CredentialStore, CredentialStoreError, CredentialStoreUnreachable, CredentialStoreWatch,
};
use tokio::sync::oneshot;

use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::keyed_lock::KeyedLock;

/// How long one keychain call may take, its waits and an unlock prompt included.
#[expect(dead_code, reason = "the daemon's start passes it")]
pub(crate) const KEYCHAIN_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// This machine's credential store as the daemon reaches it: whether it can be reached, whether it
/// takes items without a prompt, opening it, and what holds its items; a test supplies a store of
/// its own.
pub(crate) trait CredentialStoreAccess: Send + Sync {
    /// Whether the store can be reached now, without opening it. Fails with
    /// [`CredentialStoreUnreachable`] naming the condition that failed and its remedy.
    fn check_reachable(&self) -> BoxFuture<'_, Result<(), CredentialStoreUnreachable>>;

    /// Whether the store takes items now without raising an unlock prompt, read without starting
    /// it. Fails with [`CredentialStoreUnreachable`] when that cannot be read.
    fn is_unlocked(&self) -> BoxFuture<'_, Result<bool, CredentialStoreUnreachable>>;

    /// Opens the store, blocking while it connects. Fails with [`CredentialStoreError`] when it
    /// cannot be built or reached.
    fn open(&self) -> Result<CredentialStore, CredentialStoreError>;

    /// What holds the store's items, in words for the service log.
    fn description(&self) -> BoxFuture<'_, String>;
}

/// The system's own credential store, through the platforms crate, asked over the store's watch.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start hands it to the secret items")
)]
pub(crate) struct SystemCredentialStore {
    /// The watch the start began, whose connection answers every question about the store.
    pub(crate) watch: CredentialStoreWatch,
}

impl CredentialStoreAccess for SystemCredentialStore {
    fn check_reachable(&self) -> BoxFuture<'_, Result<(), CredentialStoreUnreachable>> {
        self.watch.check_reachable().boxed()
    }

    fn is_unlocked(&self) -> BoxFuture<'_, Result<bool, CredentialStoreUnreachable>> {
        self.watch.is_unlocked().boxed()
    }

    fn open(&self) -> Result<CredentialStore, CredentialStoreError> {
        CredentialStore::open()
    }

    fn description(&self) -> BoxFuture<'_, String> {
        self.watch.description().boxed()
    }
}

/// The operating system's credential store and the lock each of its entries is called under,
/// shared by every service's keychain on it; see the module doc.
pub(crate) struct OsCredentialStore {
    /// Opens the store.
    access: Arc<dyn CredentialStoreAccess>,
    /// The store once opened, until a call finds it cannot be used.
    opened: Mutex<Option<CredentialStore>>,
    /// Held by each call on an entry, by service and account, until the store answers; a listing
    /// holds its service with no account.
    entries: KeyedLock<(String, String)>,
    /// How long a caller waits for its call, the wait for the entry included.
    call_timeout: Duration,
}

impl OsCredentialStore {
    /// The calls on the store `access` opens, each answered within `call_timeout`, its wait for the
    /// entry included.
    pub(crate) fn new(access: Arc<dyn CredentialStoreAccess>, call_timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            access,
            opened: Mutex::new(None),
            entries: KeyedLock::new(),
            call_timeout,
        })
    }

    /// The items filed under `service` in this store, sharing its per-entry lock with every other
    /// service's, each call answered within the store's time.
    pub(crate) fn keychain(self: &Arc<Self>, service: &str) -> OsSecretKeychain {
        self.keychain_within(service, self.call_timeout)
    }

    /// The items filed under `service`, as [`Self::keychain`], each call answered within
    /// `call_timeout` instead of the store's time.
    pub(crate) fn keychain_within(
        self: &Arc<Self>,
        service: &str,
        call_timeout: Duration,
    ) -> OsSecretKeychain {
        OsSecretKeychain {
            store: Arc::clone(self),
            service: service.to_owned(),
            call_timeout,
        }
    }

    /// Lists every item filed under `service`, which raises the store's unlock prompt where it
    /// has one. Fails with [`KeychainRefusal`] when the store is locked or cannot be used.
    pub(crate) async fn check_items(
        self: &Arc<Self>,
        service: &str,
    ) -> Result<(), KeychainRefusal> {
        self.call(service, "", self.call_timeout, |credentials, service, _| {
            credentials.accounts(service).map(drop)
        })
        .await
    }

    /// Removes every item filed under `service`, each through its own handle, so an item the store
    /// cannot name goes too. Fails with [`KeychainRefusal`] when the store is locked or cannot be
    /// used, the items before the failure already gone.
    pub(crate) async fn erase_items(
        self: &Arc<Self>,
        service: &str,
    ) -> Result<(), KeychainRefusal> {
        self.call(service, "", self.call_timeout, |credentials, service, _| {
            for item in credentials.accounts(service)? {
                item.remove()?;
            }
            Ok(())
        })
        .await
    }

    // Runs `operation` on the entry under `service` and `account` once every earlier call on it has
    // answered, on a blocking thread, and answers `locked` when that takes longer than
    // `call_timeout`. The entry is held in a task of its own, so it stays held until the store
    // answers even after the caller stops waiting; a task still queued for the entry then leaves
    // the queue.
    async fn call<Answer: Send + 'static>(
        self: &Arc<Self>,
        service: &str,
        account: &str,
        call_timeout: Duration,
        operation: impl FnOnce(&CredentialStore, &str, &str) -> Result<Answer, CredentialStoreError>
        + Send
        + 'static,
    ) -> Result<Answer, KeychainRefusal> {
        // The caller holds the receiver while it waits and drops it when its time runs out.
        let (mut still_waiting, _caller_waits) = oneshot::channel::<()>();
        let store = Arc::clone(self);
        let entry = (service.to_owned(), account.to_owned());
        let held_call = tokio::spawn(async move {
            // Leaving the queue drops the task's store handle and the operation, with any value it
            // carries, at once.
            let _held = tokio::select! {
                held = store.entries.acquire(entry.clone()) => held,
                () = still_waiting.closed() => return None,
            };
            // The caller's time may run out just as the entry comes free.
            if still_waiting.is_closed() {
                return None;
            }
            let (service, account) = entry;
            let blocking_store = Arc::clone(&store);
            let logged_service = service.clone();
            let answer = tokio::task::spawn_blocking(move || {
                let credentials = blocking_store.opened_store()?;
                let answer = operation(&credentials, &service, &account);
                if let Err(refused) = &answer
                    && !refused.is_locked()
                {
                    blocking_store.forget_store();
                }
                answer
            })
            .await;
            if still_waiting.is_closed() {
                tracing::warn!(
                    service = logged_service,
                    is_answered = matches!(answer, Ok(Ok(_))),
                    "A credential store call landed after its caller stopped waiting"
                );
            }
            Some(answer)
        });
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

    // The open store, opened now when no call has opened it or the last one could not use it.
    fn opened_store(&self) -> Result<CredentialStore, CredentialStoreError> {
        let mut opened = self.opened.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(credentials) = opened.as_ref() {
            return Ok(credentials.clone());
        }
        let credentials = self.access.open()?;
        *opened = Some(credentials.clone());
        Ok(credentials)
    }

    // Drops the open store, so the next call opens it again.
    fn forget_store(&self) {
        *self.opened.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

/// A credential store a test hands the daemon: one store it opens, and whether it can be reached,
/// takes items without a prompt and opens, each switched by the test.
#[cfg(test)]
pub(crate) struct TestStoreAccess {
    /// The store each open answers with.
    pub(crate) credentials: CredentialStore,
    /// Whether the store can be reached.
    pub(crate) is_reachable: std::sync::atomic::AtomicBool,
    /// Whether the store takes items without a prompt.
    pub(crate) is_unlocked: std::sync::atomic::AtomicBool,
    /// Whether the store opens.
    pub(crate) opens: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl TestStoreAccess {
    /// A store over `credentials` that can be reached, takes items without a prompt and opens.
    pub(crate) fn new(credentials: CredentialStore) -> Arc<Self> {
        Arc::new(Self {
            credentials,
            is_reachable: std::sync::atomic::AtomicBool::new(true),
            is_unlocked: std::sync::atomic::AtomicBool::new(true),
            opens: std::sync::atomic::AtomicBool::new(true),
        })
    }
}

#[cfg(test)]
impl CredentialStoreAccess for TestStoreAccess {
    fn check_reachable(&self) -> BoxFuture<'_, Result<(), CredentialStoreUnreachable>> {
        let is_reachable = self.is_reachable.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if is_reachable {
                Ok(())
            } else {
                Err(CredentialStoreUnreachable::NoSecretService)
            }
        })
    }

    fn is_unlocked(&self) -> BoxFuture<'_, Result<bool, CredentialStoreUnreachable>> {
        let is_unlocked = self.is_unlocked.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move { Ok(is_unlocked) })
    }

    fn open(&self) -> Result<CredentialStore, CredentialStoreError> {
        if self.opens.load(std::sync::atomic::Ordering::SeqCst) {
            Ok(self.credentials.clone())
        } else {
            Err(CredentialStoreError::unusable(
                "the test's store does not open",
            ))
        }
    }

    fn description(&self) -> BoxFuture<'_, String> {
        Box::pin(async { "the test's store".to_owned() })
    }
}

/// One keychain service's items in the operating system's credential store; see the module doc.
pub(crate) struct OsSecretKeychain {
    /// The store, shared with every other service's keychain on it.
    store: Arc<OsCredentialStore>,
    /// The keychain service the items are filed under.
    service: String,
    /// How long a caller waits for each call, the wait for the entry included.
    call_timeout: Duration,
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
            self.call_timeout,
            move |credentials, service, account| credentials.write(service, account, &value),
        ))
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        Box::pin(self.store.call(
            &self.service,
            account,
            self.call_timeout,
            CredentialStore::read,
        ))
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        Box::pin(self.store.call(
            &self.service,
            account,
            self.call_timeout,
            CredentialStore::remove,
        ))
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        Box::pin(async move {
            let accounts = self
                .store
                .call(
                    &self.service,
                    "",
                    self.call_timeout,
                    |credentials, service, _| {
                        Ok(credentials
                            .accounts(service)?
                            .iter()
                            .map(|item| item.account().map(str::to_owned))
                            .collect::<Vec<_>>())
                    },
                )
                .await?;
            accounts
                .into_iter()
                .map(|account| {
                    account.ok_or_else(|| {
                        KeychainRefusal::new(
                            KeychainRefusalCause::Unavailable,
                            "the credential store holds an item it cannot name, which cannot be \
                             moved",
                        )
                    })
                })
                .collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use secrecy::{ExposeSecret, SecretString};
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_platforms::{BlockingCredentialStore, CredentialStore};

    use super::{OsCredentialStore, TestStoreAccess};
    use crate::credential_store::SecretKeychain;
    use crate::credential_store::service::KeychainService;

    // A store over `blocking_store`, each call answered within `call_timeout`.
    fn store_over(
        blocking_store: &Arc<BlockingCredentialStore>,
        call_timeout: Duration,
    ) -> Arc<OsCredentialStore> {
        let access = TestStoreAccess::new(CredentialStore::from_store(blocking_store.clone()));
        OsCredentialStore::new(access, call_timeout)
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
