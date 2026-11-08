//! A tool-trace port for tests: its switch a test sets, and each trace it records kept.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use sidekicks_std::mutex_lock::lock;

use crate::port::tool_traces::{ToolTrace, ToolTraces};

/// Keeps each trace recorded while its switch, off at first, is on.
#[derive(Default)]
pub(crate) struct KeptToolTraces {
    is_recording: AtomicBool,
    traces: Mutex<Vec<ToolTrace>>,
}

impl KeptToolTraces {
    /// Turns the switch on or off.
    pub(crate) fn set_recording(&self, is_recording: bool) {
        self.is_recording.store(is_recording, Ordering::SeqCst);
    }

    /// Each trace recorded so far, in order.
    pub(crate) fn traces(&self) -> Vec<ToolTrace> {
        lock(&self.traces).clone()
    }
}

impl ToolTraces for KeptToolTraces {
    fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    fn record(&self, trace: ToolTrace) -> BoxFuture<'_, ()> {
        if self.is_recording() {
            lock(&self.traces).push(trace);
        }
        Box::pin(std::future::ready(()))
    }
}
