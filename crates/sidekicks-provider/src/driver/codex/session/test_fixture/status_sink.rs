//! A status sink a test hands a session's record, keeping what the leg reported and counting how
//! often the leg was ended.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use sidekicks_std::mutex_lock::lock;

use crate::driver::mcp_server::status::{McpServerStatusEmission, McpServerStatusSink};

/// A status sink that keeps each emission in order and counts each end of its leg.
#[derive(Default)]
pub(crate) struct CountingStatusSink {
    reported: Mutex<Vec<McpServerStatusEmission>>,
    ends: AtomicUsize,
}

impl CountingStatusSink {
    /// What the leg reported, oldest first.
    pub(crate) fn reported(&self) -> Vec<McpServerStatusEmission> {
        lock(&self.reported).clone()
    }

    /// How many times the leg was ended.
    pub(crate) fn ends(&self) -> usize {
        self.ends.load(Ordering::SeqCst)
    }
}

impl McpServerStatusSink for CountingStatusSink {
    fn report_status(&self, emission: McpServerStatusEmission) {
        lock(&self.reported).push(emission);
    }

    fn end_leg(&self) {
        self.ends.fetch_add(1, Ordering::SeqCst);
    }
}
