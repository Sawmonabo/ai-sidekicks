//! A host another crate's tests reach over their own approval seam: its registry installed through
//! a spawn's binding, each call answered through the host's dispatch, and its executor counting
//! the calls it ran.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::Map;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;

use super::{
    CallbackToolActivityRecord, CallbackToolActivitySink, CallbackToolApprovalSeam,
    CallbackToolExecutor, CallbackToolHost, CallbackToolPortError, CallbackToolSpawnRequest,
};
use crate::callback_tools::spawn_binding::{
    CallbackToolSpawnBinding, bind_callback_tools_for_spawn,
};
use crate::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};

/// A host over a given approval seam with one spawn's registry installed, whose executor completes
/// every call it is handed and counts them.
pub struct TestCallbackToolHost {
    binding: CallbackToolSpawnBinding,
    executed: Arc<CountingExecutor>,
}

impl TestCallbackToolHost {
    /// A host over `seam` with `provider`'s spawn for `session_id` offering `tool_names`.
    pub fn new(
        seam: Arc<dyn CallbackToolApprovalSeam>,
        session_id: SessionId,
        provider: ProviderId,
        tool_names: &[&str],
    ) -> Self {
        let executed = Arc::new(CountingExecutor::default());
        let host = Arc::new(CallbackToolHost::new(
            Arc::clone(&executed) as _,
            Arc::new(IgnoredActivity),
            Some(seam),
        ));
        let requested_tools = tool_names
            .iter()
            .map(|name| SessionCallbackTool {
                name: (*name).to_owned(),
                description: "A test tool.".to_owned(),
                input_schema: Map::new(),
            })
            .collect();
        let binding = bind_callback_tools_for_spawn(
            &host,
            CallbackToolSpawnRequest {
                session_id,
                provider,
                requested_tools,
                provider_registration_unavailable: None,
            },
        );
        Self { binding, executed }
    }

    /// Answers `invocation` through the host's dispatch, as the spawn's provider's call is.
    pub async fn call(&self, invocation: CallbackToolInvocation) -> CallbackToolResult {
        (self.binding.dispatcher)(invocation).await
    }

    /// How many calls the executor has run.
    pub fn executed_count(&self) -> usize {
        self.executed.count.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
struct CountingExecutor {
    count: AtomicUsize,
}

impl CallbackToolExecutor for CountingExecutor {
    fn execute(
        &self,
        _invocation: CallbackToolInvocation,
    ) -> BoxFuture<'_, Result<CallbackToolResult, CallbackToolPortError>> {
        self.count.fetch_add(1, Ordering::SeqCst);
        async { Ok(CallbackToolResult::Completed { output: None }) }.boxed()
    }
}

struct IgnoredActivity;

impl CallbackToolActivitySink for IgnoredActivity {
    fn record<'a>(
        &'a self,
        _record: &'a CallbackToolActivityRecord,
    ) -> BoxFuture<'a, Result<(), CallbackToolPortError>> {
        async { Ok(()) }.boxed()
    }
}
