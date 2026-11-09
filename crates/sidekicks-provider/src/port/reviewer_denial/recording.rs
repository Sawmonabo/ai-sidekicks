//! A reviewer-denial port for the drivers' tests: it keeps whether each block it takes may be
//! allowed once, and hands each released binding to the test.

use std::error::Error;
use std::sync::Mutex;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_std::mutex_lock::lock;

use crate::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};

/// The approval pipeline's intake as a test sees it: each block's `is_overridable`, in order, and
/// each release handed to `on_release`.
pub(crate) struct RecordingReviewerDenials {
    overridable: Mutex<Vec<bool>>,
    on_release: Box<dyn Fn(&RuntimeBindingId) + Send + Sync>,
}

impl RecordingReviewerDenials {
    /// An intake that hands each binding whose held presses are released to `on_release`.
    pub(crate) fn new(on_release: impl Fn(&RuntimeBindingId) + Send + Sync + 'static) -> Self {
        Self {
            overridable: Mutex::default(),
            on_release: Box::new(on_release),
        }
    }

    /// Whether each block taken so far may be allowed once, in the order taken.
    pub(crate) fn overridable(&self) -> Vec<bool> {
        lock(&self.overridable).clone()
    }
}

impl ReviewerDenialPort for RecordingReviewerDenials {
    fn take_denial(
        &self,
        denial: ProviderReviewerDenial,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.overridable).push(denial.is_overridable);
        Box::pin(async { Ok(()) })
    }

    fn release_held_presses(&self, binding_id: &RuntimeBindingId) {
        (self.on_release)(binding_id);
    }
}
