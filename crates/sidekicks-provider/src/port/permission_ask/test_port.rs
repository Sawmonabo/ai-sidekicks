//! An ask port for tests that records every ask taken and every withdrawal, in order, and tells a
//! waiter at each.

use std::error::Error;
use std::sync::Mutex;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Notify;

use crate::port::permission_ask::{
    PermissionAskPort, ProviderPermissionAsk, ProviderPermissionAskWithdrawal,
};

/// Every ask the driver hands the permission pipeline and every withdrawal, in order.
#[derive(Default)]
pub(crate) struct RecordedAsks {
    taken: Mutex<Vec<ProviderPermissionAsk>>,
    withdrawn: Mutex<Vec<ProviderPermissionAskWithdrawal>>,
    changed: Notify,
}

impl RecordedAsks {
    /// The asks taken so far, in order.
    pub(crate) fn taken(&self) -> Vec<ProviderPermissionAsk> {
        lock(&self.taken).clone()
    }

    /// The withdrawals so far, in order.
    pub(crate) fn withdrawn(&self) -> Vec<ProviderPermissionAskWithdrawal> {
        lock(&self.withdrawn).clone()
    }

    /// Waits for the next ask or withdrawal, or answers at once for one recorded since the last
    /// wait.
    pub(crate) async fn changed(&self) {
        self.changed.notified().await;
    }

    /// The first ask taken, once one is.
    pub(crate) async fn first(&self) -> ProviderPermissionAsk {
        loop {
            if let Some(first) = lock(&self.taken).first().cloned() {
                return first;
            }
            self.changed().await;
        }
    }
}

impl PermissionAskPort for RecordedAsks {
    fn take_ask(
        &self,
        ask: ProviderPermissionAsk,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.taken).push(ask);
        // A stored permit, so a change made before its waiter waits is not lost.
        self.changed.notify_one();
        async { Ok(()) }.boxed()
    }

    fn withdraw_ask(
        &self,
        withdrawal: ProviderPermissionAskWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.withdrawn).push(withdrawal);
        self.changed.notify_one();
        async { Ok(()) }.boxed()
    }
}
