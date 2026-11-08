//! A raw-message port for tests: its switch a test sets, and each message it records kept.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::mutex_lock::lock;

use crate::port::raw_provider_messages::RawProviderMessages;

/// Keeps each message recorded while its switch, off at first, is on.
#[derive(Default)]
pub(crate) struct KeptRawMessages {
    is_recording: AtomicBool,
    messages: Mutex<Vec<(ProviderId, String)>>,
}

impl KeptRawMessages {
    /// Turns the switch on or off.
    pub(crate) fn set_recording(&self, is_recording: bool) {
        self.is_recording.store(is_recording, Ordering::SeqCst);
    }

    /// Each message recorded so far, in order, with the provider that sent it.
    pub(crate) fn messages(&self) -> Vec<(ProviderId, String)> {
        lock(&self.messages).clone()
    }
}

impl RawProviderMessages for KeptRawMessages {
    fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    fn record(&self, provider: ProviderId, message: String) -> BoxFuture<'_, ()> {
        if self.is_recording() {
            lock(&self.messages).push((provider, message));
        }
        Box::pin(std::future::ready(()))
    }
}
