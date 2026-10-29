//! The lock on each account's credential home: every act the daemon runs in an account's home
//! holds it, so no two run there at once, and an act whose answer serves everyone asking for it is
//! run once, each later asker waiting on the answer in flight.
//!
//! - A hold waits behind every act that asked for the home first and ends when it drops.
//! - A shared act joins the one in flight on the account, else starts only while no other act
//!   holds the home. It runs in a task of its own, so it keeps the home until it ends even after
//!   every asker stops waiting, and leaves no act behind that would hold the home for ever.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use tokio::task::JoinError;

/// The per-account lock on credential homes, one for the daemon; see the module doc.
#[derive(Default)]
pub struct AccountHomeLock {
    holds: KeyedLock<ProviderAccountId>,
}

impl AccountHomeLock {
    /// Waits for `provider_account_id`'s home behind every act that asked for it first and answers
    /// the hold, which frees the home when it drops.
    pub async fn hold(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> KeyHold<'_, ProviderAccountId> {
        self.holds.acquire(provider_account_id).await
    }
}

/// A shared act ended without an answer: its task panicked or the runtime stopped under it.
#[derive(Clone, Debug, thiserror::Error)]
#[error("the act in the account's credential home ended without an answer")]
pub struct AccountHomeActEnded(#[source] Arc<JoinError>);

// One act in flight, which every asker on its account awaits; `None` when the home was held.
type AccountHomeFlight<Answer> =
    Shared<BoxFuture<'static, Result<Option<Answer>, AccountHomeActEnded>>>;

/// One kind of act in account homes whose answer serves every asker: at most one in flight per
/// account, run under the home's hold; see the module doc.
pub struct AccountHomeFlights<Answer> {
    home_lock: Arc<AccountHomeLock>,
    in_flight: Arc<Mutex<HashMap<ProviderAccountId, AccountHomeFlight<Answer>>>>,
}

impl<Answer: Clone + Send + Sync + 'static> AccountHomeFlights<Answer> {
    /// Acts of one kind run under `home_lock`'s holds.
    pub fn new(home_lock: Arc<AccountHomeLock>) -> Self {
        Self {
            home_lock,
            in_flight: Arc::default(),
        }
    }

    /// Joins the act in flight on `provider_account_id`, else starts `work` under the home's hold
    /// when no other act holds it, and answers the act's answer; `None` when the home was held, so
    /// nothing ran. Fails when the act's task ended without an answer.
    pub async fn run_if_free(
        &self,
        provider_account_id: ProviderAccountId,
        work: impl FnOnce() -> BoxFuture<'static, Answer> + Send + 'static,
    ) -> Result<Option<Answer>, AccountHomeActEnded> {
        let flight = {
            let mut in_flight = lock(&self.in_flight);
            if let Some(flight) = in_flight.get(&provider_account_id) {
                flight.clone()
            } else {
                let flight = self.start(provider_account_id.clone(), work);
                in_flight.insert(provider_account_id, flight.clone());
                flight
            }
        };
        flight.await
    }

    // Spawns the act's task, which takes the home only when it is free, and drops its entry once
    // the home is freed, so an asker in between joins the answer rather than finding the home
    // held by an act already done.
    fn start(
        &self,
        provider_account_id: ProviderAccountId,
        work: impl FnOnce() -> BoxFuture<'static, Answer> + Send + 'static,
    ) -> AccountHomeFlight<Answer> {
        let home_lock = Arc::clone(&self.home_lock);
        let in_flight = Arc::clone(&self.in_flight);
        let task = tokio::spawn(async move {
            let answer = if let Ok(hold) = home_lock.holds.try_acquire(provider_account_id.clone())
            {
                let answer = work().await;
                drop(hold);
                Some(answer)
            } else {
                None
            };
            lock(&in_flight).remove(&provider_account_id);
            answer
        });
        async move {
            task.await
                .map_err(|error| AccountHomeActEnded(Arc::new(error)))
        }
        .boxed()
        .shared()
    }
}
