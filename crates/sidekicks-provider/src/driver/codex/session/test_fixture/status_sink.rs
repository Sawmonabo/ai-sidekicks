//! A status sink a test hands a session's record, keeping what the leg reported and counting how
//! often the leg was ended, and the tool-server startups a test's service sends that leg.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::event_normalizer::CODEX_MCP_SERVER_STARTUP_STATUS_UPDATED_METHOD;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::mcp_server::status::{McpServerStatusEmission, McpServerStatusSink};

/// A tool server's startup in `status` on `thread_id`, with its `error` text where one is given,
/// as the service sends it.
pub(crate) fn mcp_server_startup(
    thread_id: &str,
    server_name: &str,
    status: &str,
    error: Option<&str>,
) -> CodexSessionInbound {
    let params =
        json!({"threadId": thread_id, "name": server_name, "status": status, "error": error});
    CodexSessionInbound::Frame {
        method: CODEX_MCP_SERVER_STARTUP_STATUS_UPDATED_METHOD.to_owned(),
        params: RawValue::from_string(params.to_string()).expect("the params are JSON"),
    }
}

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
