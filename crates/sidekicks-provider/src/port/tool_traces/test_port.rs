//! A tool-trace port for tests: its switch a test sets, and every trace it is handed kept,
//! whatever the switch reads, so the switch a test proves is the caller's check.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use sidekicks_std::mutex_lock::lock;

use crate::port::tool_traces::{ToolTrace, ToolTraces};

/// Keeps every trace it is handed; its switch, off at first, only answers `is_recording`.
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

    /// Each trace handed so far, in order.
    pub(crate) fn traces(&self) -> Vec<ToolTrace> {
        lock(&self.traces).clone()
    }
}

impl ToolTraces for KeptToolTraces {
    fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    fn record(&self, trace: ToolTrace) -> BoxFuture<'_, ()> {
        lock(&self.traces).push(trace);
        Box::pin(std::future::ready(()))
    }
}
