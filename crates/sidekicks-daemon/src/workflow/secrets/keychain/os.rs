//! The keychain entries kept in the operating system's credential store: the macOS login keychain,
//! the Windows Credential Manager, and on Linux the Secret Service.
//!
//! A store call blocks until the store answers, and a locked store answers only once the person
//! answers its unlock prompt, so each call runs on a blocking thread and is answered `locked` when
//! it gets no answer within its time. The calls on one entry run one at a time, and the entry stays
//! held until the store's answer even after its caller stopped waiting, so a locked store holds at
//! most one blocking thread per entry. A call that is still queued for its entry when its caller
//! stops waiting leaves the queue and never reaches the store, so a queued call answered `locked`
//! changes nothing later; a call already running when its caller stops waiting may still land once
//! the store answers.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{CredentialStore, CredentialStoreError};
use tokio::sync::oneshot;

use crate::keyed_lock::KeyedLock;
use crate::workflow::secrets::store::{SecretKeychain, WorkflowSecretStoreUnavailable};

// How long one keychain call may take, its wait for the entry and an unlock prompt included.
#[expect(dead_code, reason = "the daemon's start passes it")]
const KEYCHAIN_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// The operating system's credential store and the lock each of its entries is called under,
/// shared by every service's keychain on it. The daemon's start builds one per credential store
/// and hands every keychain on it a handle.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the credential store's keychains when the operating \
                  system's credential store can be used"
    )
)]
pub(crate) struct OsCredentialStore {
    /// The store the calls reach.
    credentials: CredentialStore,
    /// Held by each call on an entry, by service and account, until the store answers.
    entries: KeyedLock<(String, String)>,
    /// How long a caller waits for its call, the wait for the entry included.
    call_timeout: Duration,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the credential store's keychains when the operating \
                  system's credential store can be used"
    )
)]
impl OsCredentialStore {
    /// The calls on `credentials`, each answered within `call_timeout`, its wait for the entry
    /// included.
    pub(crate) fn new(credentials: CredentialStore, call_timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            credentials,
            entries: KeyedLock::new(),
            call_timeout,
        })
    }

    /// The entries filed under `service` in this store, sharing its per-entry lock with every
    /// other service's.
    pub(crate) fn keychain(self: &Arc<Self>, service: &str) -> OsSecretKeychain {
        OsSecretKeychain {
            store: Arc::clone(self),
            service: service.to_owned(),
        }
    }

    // Runs `operation` on the entry under `service` and `account` once every earlier call on it has
    // answered, on a blocking thread, and answers `locked` when that takes longer than the call's
    // time. The entry is held in a task of its own, so it stays held until the store answers even
    // after the caller stops waiting; a task still queued for the entry then leaves the queue.
    async fn call<Answer: Send + 'static>(
        self: &Arc<Self>,
        service: &str,
        account: &str,
        operation: impl FnOnce(&CredentialStore, &str, &str) -> Result<Answer, CredentialStoreError>
        + Send
        + 'static,
    ) -> Result<Answer, WorkflowSecretStoreUnavailable> {
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
            let credentials = store.credentials.clone();
            let (service, account) = entry;
            Some(
                tokio::task::spawn_blocking(move || operation(&credentials, &service, &account))
                    .await,
            )
        });
        match tokio::time::timeout(self.call_timeout, held_call).await {
            Ok(Ok(Some(Ok(Ok(answer))))) => Ok(answer),
            Ok(Ok(Some(Ok(Err(refused))))) => {
                let cause = if refused.is_locked() {
                    KeychainRefusalCause::Locked
                } else {
                    KeychainRefusalCause::Unavailable
                };
                Err(
                    WorkflowSecretStoreUnavailable::new(cause, refused.to_string())
                        .with_failure(refused),
                )
            }
            Ok(Ok(Some(Err(interrupted))) | Err(interrupted)) => {
                Err(WorkflowSecretStoreUnavailable::new(
                    KeychainRefusalCause::Unavailable,
                    "the credential store call ended without an answer",
                )
                .with_failure(interrupted))
            }
            // The task skips the store only once this caller stopped waiting, so this arm is the
            // same answer the timeout gives.
            Ok(Ok(None)) | Err(_) => Err(WorkflowSecretStoreUnavailable::new(
                KeychainRefusalCause::Locked,
                format!(
                    "the credential store gave no answer within {:?}",
                    self.call_timeout
                ),
            )),
        }
    }
}

/// One keychain service's entries in the operating system's credential store; see the module doc.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the credential store's keychains when the operating \
                  system's credential store can be used"
    )
)]
pub(crate) struct OsSecretKeychain {
    /// The store, shared with every other service's keychain on it.
    store: Arc<OsCredentialStore>,
    /// The keychain service the entries are filed under.
    service: String,
}

impl SecretKeychain for OsSecretKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), WorkflowSecretStoreUnavailable>> {
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
    ) -> BoxFuture<'call, Result<Option<SecretString>, WorkflowSecretStoreUnavailable>> {
        Box::pin(
            self.store
                .call(&self.service, account, |credentials, service, account| {
                    credentials.read(service, account)
                }),
        )
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, WorkflowSecretStoreUnavailable>> {
        Box::pin(
            self.store
                .call(&self.service, account, |credentials, service, account| {
                    credentials.remove(service, account)
                }),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_platforms::{BlockingCredentialStore, CredentialStore};

    use super::OsCredentialStore;
    use crate::workflow::secrets::store::SecretKeychain;

    const SERVICE: &str = "ai-sidekicks-workflow-secrets";

    /// A call the store does not answer in time reads `locked`; a second call on the same entry
    /// while the first holds it reads `locked` too, leaves the entry's queue at once with its store
    /// handle, and never reaches the store, even once the first's call ends. Mutation: race no
    /// `select!` against the caller giving up, so the second call's task stays queued holding the
    /// store until the first's call ends (the outer timeout fails the test).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_held_entry_answers_locked_and_a_call_given_up_never_reaches_the_store() {
        let blocking_store = BlockingCredentialStore::new();
        let store = OsCredentialStore::new(
            CredentialStore::from_store(blocking_store.clone()),
            Duration::from_millis(200),
        );
        let keychain = Arc::new(store.keychain(SERVICE));
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
            let handles_after_second = Arc::strong_count(&store);
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
            (
                first,
                second,
                handles_before_second,
                handles_after_second,
                calls_while_held,
            )
        };
        let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
        blocking_store.release();
        let (first, second, handles_before_second, handles_after_second, calls_while_held) =
            outcome.expect("every call answers within its time");

        for refused in [first, second] {
            assert_eq!(
                refused
                    .expect_err("a call with no answer is refused")
                    .cause(),
                KeychainRefusalCause::Locked
            );
        }
        assert_eq!(handles_after_second, handles_before_second);
        assert_eq!(calls_while_held, 1);
        assert_eq!(blocking_store.calls(), 2);
    }
}
