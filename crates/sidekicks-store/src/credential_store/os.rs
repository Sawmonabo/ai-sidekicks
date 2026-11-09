//! The items kept in the operating system's credential store: the macOS login keychain and the
//! Windows Credential Manager. Linux offers no such store: its secrets are sealed by systemd's
//! credential service into the items file.
//!
//! The store is opened at the first call that needs it and kept for the run; a store that does not
//! open is tried again at the next call.
//!
//! A store call blocks until the store answers, and a locked store answers only once the person
//! answers its prompt, so each call runs on a blocking thread and is answered `locked` when it gets
//! no answer within its time. The store shows one prompt at a time and holds every other call
//! behind it, so the calls run one at a time across every service and a call's time starts only at
//! its turn: a prompt the person leaves open delays the calls behind it and fails only its own. The
//! turn stays held until the store's answer even after its caller stopped waiting, so a locked
//! store holds at most one blocking thread, and a late answer always lands before the next call
//! runs, so it never overwrites a retry's value. A call still waiting for its turn when its caller
//! stops waiting leaves the line and never reaches the store; one that lands after its caller
//! stopped waiting is logged. A provider's own calls on the store take the same turn, through
//! [`KeychainTurn`].

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{CredentialStore, CredentialStoreError, SecretStoreOffer};
use sidekicks_std::keyed_lock::{HeldWorkEnd, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use crate::credential_store::seal::SecretSeal;
use crate::credential_store::{KeychainRefusal, SecretKeychain};

/// How long one keychain call may take from its turn at the store, a prompt included.
pub const KEYCHAIN_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How many times shorter than a keychain call the seal service's probe and the sealed file's open
/// check each are: one that does not answer runs out with the call's time still left to record why
/// the sealed file cannot be opened and refuse the call.
pub(crate) const SEAL_CHECK_TIMEOUT_DIVISOR: u32 = 3;

/// What this machine offers for the daemon's secrets, and what holds them in words for the service
/// log; a test supplies an offer of its own.
pub trait CredentialStoreAccess: Send + Sync {
    /// The machine's offer: the operating system's credential store on macOS and Windows,
    /// systemd's credential service on Linux.
    fn offer(&self) -> SecretsOffer;

    /// What holds the secrets, in words for the service log.
    fn description(&self) -> String;
}

/// What this machine offers for the daemon's secrets.
pub enum SecretsOffer {
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
pub struct SystemCredentialStore {
    /// The machine's offer, read once at the start.
    pub offer: SecretStoreOffer,
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

/// The turn every call on the operating system's credential store takes, one call at a time
/// across every service, the daemon's own items and a provider's alike, and the time a call has
/// from its turn; see the module doc.
#[derive(Clone)]
pub struct KeychainTurn {
    /// Held by each call until it ends, so one call reaches the store at a time.
    lock: Arc<KeyedLock<()>>,
    /// How long a caller waits for its call from its turn.
    call_timeout: Duration,
}

impl KeychainTurn {
    /// A turn whose calls each have `call_timeout` from their turn.
    pub fn new(call_timeout: Duration) -> Self {
        Self {
            lock: Arc::new(KeyedLock::new()),
            call_timeout,
        }
    }

    /// How long a call has from its turn.
    pub fn call_timeout(&self) -> Duration {
        self.call_timeout
    }

    /// Runs `work`, one call on the store for `service`, once every earlier call has ended, and
    /// waits for it the call time from its turn. The turn stays held until `work` ends even after
    /// the caller stops waiting, and a late end is logged with `is_answered`'s reading of it; a
    /// call still waiting for its turn then leaves the line unrun. Fails `Unanswered` when `work`
    /// does not end within the call time from its turn, and `Interrupted` when it panics.
    pub async fn run<Answer: Send + 'static>(
        &self,
        service: &str,
        work: impl Future<Output = Answer> + Send + 'static,
        is_answered: impl FnOnce(&Answer) -> bool + Send + 'static,
    ) -> Result<Answer, HeldWorkEnd> {
        let logged_service = service.to_owned();
        let (turn_taken, has_turn) = oneshot::channel::<()>();
        let held_call = self.lock.run_held(
            (),
            async move {
                // A caller that stopped waiting just now has nothing left to tell.
                turn_taken.send(()).unwrap_or(());
                work.await
            },
            move |answer| {
                tracing::warn!(
                    service = logged_service,
                    is_answered = is_answered(answer),
                    "A credential store call landed after its caller stopped waiting"
                );
            },
        );
        let mut held_call = std::pin::pin!(held_call);
        // The wait for the turn is not timed: only the call at the store can be held by a prompt.
        let ended_before_its_turn = tokio::select! {
            biased;
            ended = &mut held_call => Some(ended),
            _ = has_turn => None,
        };
        match ended_before_its_turn {
            Some(ended) => ended,
            None => match tokio::time::timeout(self.call_timeout, held_call).await {
                Ok(ended) => ended,
                Err(_elapsed) => Err(HeldWorkEnd::Unanswered),
            },
        }
    }
}

/// The operating system's credential store and the turn its calls take one at a time, shared by
/// every service's keychain on it; see the module doc.
pub(crate) struct OsCredentialStore {
    /// Opens the store.
    open: StoreOpen,
    /// The store once opened.
    opened: Mutex<Option<CredentialStore>>,
    /// The turn each call takes, so one call reaches the store at a time.
    turn: KeychainTurn,
}

impl OsCredentialStore {
    /// The calls on the store `open` opens, one at a time through `turn`.
    pub(crate) fn new(open: StoreOpen, turn: KeychainTurn) -> Arc<Self> {
        Arc::new(Self {
            open,
            opened: Mutex::new(None),
            turn,
        })
    }

    /// The items filed under `service` in this store, its calls taking turns with every other
    /// service's, each answered within the store's time.
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

    /// Removes every item filed under `service`, each through its own handle, the pieces of a
    /// value larger than one entry included. Fails with [`KeychainRefusal`] when the store is
    /// locked or cannot be used, the items before the failure already gone.
    pub(crate) async fn erase_items(
        self: &Arc<Self>,
        service: &str,
    ) -> Result<(), KeychainRefusal> {
        self.call(service, "", |credentials, service, _| {
            for item in credentials.entries(service)? {
                item.remove()?;
            }
            Ok(())
        })
        .await
    }

    /// Rewrites through the store, in one turn, every item filed under `service` another writer
    /// made, so each serves with no access prompt from then on, and answers how many it rewrote.
    /// Fails with [`KeychainRefusal`] when the store is locked or cannot be used, or an item
    /// cannot be read or written again, the items before it rewritten.
    pub(crate) async fn adopt_items(
        self: &Arc<Self>,
        service: &str,
    ) -> Result<usize, KeychainRefusal> {
        self.call(service, "", |credentials, service, _| {
            credentials.adopt_items(service)
        })
        .await
    }

    // Runs `operation` on the entry under `service` and `account` in the store's turn, on a
    // blocking thread, and answers `locked` when it takes longer than the store's time from its
    // turn.
    async fn call<Answer: Send + 'static>(
        self: &Arc<Self>,
        service: &str,
        account: &str,
        operation: impl FnOnce(&CredentialStore, &str, &str) -> Result<Answer, CredentialStoreError>
        + Send
        + 'static,
    ) -> Result<Answer, KeychainRefusal> {
        let store = Arc::clone(self);
        let (item_service, item_account) = (service.to_owned(), account.to_owned());
        let answered = self
            .turn
            .run(
                service,
                async move {
                    tokio::task::spawn_blocking(move || {
                        operation(&store.opened_store()?, &item_service, &item_account)
                    })
                    .await
                },
                |answer| matches!(answer, Ok(Ok(_))),
            )
            .await;
        match answered {
            Ok(Ok(Ok(answer))) => Ok(answer),
            Ok(Ok(Err(refused))) => {
                let cause = if refused.is_locked() {
                    KeychainRefusalCause::Locked
                } else {
                    KeychainRefusalCause::Unavailable
                };
                Err(KeychainRefusal::new(cause, refused.to_string()).with_failure(refused))
            }
            Ok(Err(interrupted)) => Err(HeldWorkEnd::Interrupted(interrupted).into()),
            Err(end @ HeldWorkEnd::Interrupted(_)) => Err(end.into()),
            // The turn skips the store only once this caller stopped waiting, so this arm is also
            // the answer the call time gives.
            Err(HeldWorkEnd::Unanswered) => Err(KeychainRefusal::new(
                KeychainRefusalCause::Locked,
                format!(
                    "the credential store gave no answer within {:?}",
                    self.turn.call_timeout()
                ),
            )),
        }
    }

    // The open store, opened now when no call has opened it yet.
    fn opened_store(&self) -> Result<CredentialStore, CredentialStoreError> {
        let mut opened = lock(&self.opened);
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
#[cfg(any(test, feature = "test-support"))]
pub struct TestStoreAccess {
    /// What the test offers.
    offer: TestOffer,
    /// Whether the store opens.
    pub opens: Arc<std::sync::atomic::AtomicBool>,
}

// What a test's access offers.
#[cfg(any(test, feature = "test-support"))]
enum TestOffer {
    Store(CredentialStore),
    #[cfg(test)]
    Seal(Arc<crate::credential_store::seal::TestSeal>),
}

#[cfg(any(test, feature = "test-support"))]
impl TestStoreAccess {
    /// The operating system's store over `credentials`, which opens.
    pub fn new(credentials: CredentialStore) -> Arc<Self> {
        Self::offering(TestOffer::Store(credentials))
    }

    /// systemd's credential service as `seal`.
    #[cfg(test)]
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

#[cfg(any(test, feature = "test-support"))]
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
            #[cfg(test)]
            TestOffer::Seal(seal) => SecretsOffer::SealService(Arc::clone(seal) as _),
        }
    }

    fn description(&self) -> String {
        match &self.offer {
            TestOffer::Store(_) => "the test's store".to_owned(),
            #[cfg(test)]
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

    use super::{KeychainTurn, OsCredentialStore};
    use crate::credential_store::SecretKeychain;
    use crate::credential_store::service::KeychainService;

    // A store over `blocking_store`, each call answered within `call_timeout`.
    fn store_over(
        blocking_store: &Arc<BlockingCredentialStore>,
        call_timeout: Duration,
    ) -> Arc<OsCredentialStore> {
        let credentials = CredentialStore::from_store(blocking_store.clone());
        OsCredentialStore::new(
            Arc::new(move || Ok(credentials.clone())),
            KeychainTurn::new(call_timeout),
        )
    }

    /// A call held past its time by a prompt fails alone: a call on another service's item issued
    /// meanwhile waits its turn without reaching the store, then is served once the prompt is
    /// answered, though it waited longer than its own time. Mutations: take the turn per item, so
    /// the second call reaches the store beside the first; count a call's time from when it is
    /// issued, so the second runs out while it waits.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_call_behind_an_open_prompt_waits_its_turn_and_is_served() {
        let blocking_store = BlockingCredentialStore::new();
        let call_timeout = Duration::from_millis(200);
        let store = store_over(&blocking_store, call_timeout);
        let secrets = Arc::new(store.keychain(KeychainService::WorkflowSecrets.as_str()));
        let tokens = Arc::new(store.keychain(KeychainService::ProviderTokens.as_str()));

        let scenario = async {
            let first = tokio::spawn({
                let secrets = Arc::clone(&secrets);
                async move { secrets.read("secret").await.map(drop) }
            });
            blocking_store.wait_for_calls(1).await;
            let second = tokio::spawn({
                let tokens = Arc::clone(&tokens);
                async move { tokens.read("token").await.map(drop) }
            });
            let first = first.await.expect("the first call's task ends");
            // Past the second call's own time counted from when it was issued.
            tokio::time::sleep(call_timeout).await;
            let calls_while_held = blocking_store.calls();
            blocking_store.release();
            let second = second.await.expect("the second call's task ends");
            (first, second, calls_while_held)
        };
        let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
        blocking_store.release();
        let (first, second, calls_while_held) =
            outcome.expect("every call answers within its time");

        assert_eq!(
            first
                .expect_err("the call held past its time is refused")
                .cause(),
            KeychainRefusalCause::Locked
        );
        assert_eq!(calls_while_held, 1);
        second.expect("the call behind the prompt is served once the prompt is answered");
    }

    /// A write held past its caller's time, then a retry with another value: the retry reaches the
    /// store only after the late write lands, so the item holds the retry's value. Mutation: let
    /// go of the turn when the caller gives up, so the retry's write reaches the store beside the
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
