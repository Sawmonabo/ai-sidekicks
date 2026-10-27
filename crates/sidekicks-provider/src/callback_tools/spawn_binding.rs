//! One spawn's binding to the host: the tools it offers and the dispatcher scoped to its own
//! installation, released when the binding drops.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::id::SessionId;

use crate::callback_tools::host::{
    CallbackToolAdmission, CallbackToolHost, CallbackToolRegistryToken, CallbackToolSpawnRequest,
};
use crate::driver::callback_tool::{CallbackToolDispatcher, CallbackToolInvocation};

/// One spawn's callback-tool wiring: what to offer the provider and the dispatcher to answer its
/// calls with. Dropping it releases the spawn's registry; a spawn that never established calls
/// [`CallbackToolSpawnBinding::rollback`] instead.
#[must_use = "dropping the binding releases the spawn's callback-tool registry"]
pub(crate) struct CallbackToolSpawnBinding {
    /// Whether the spawn offers its tools, and which.
    pub(crate) admission: CallbackToolAdmission,
    /// Answers each call; bound even on a withholding, so a stray call is a recorded refusal.
    pub(crate) dispatcher: CallbackToolDispatcher,
    host: Arc<CallbackToolHost>,
    session_id: SessionId,
    token: CallbackToolRegistryToken,
    is_rolled_back: bool,
}

impl CallbackToolSpawnBinding {
    /// Undoes the spawn's registry after the spawn failed, restoring the one it replaced, which a
    /// driver may still be using; with none replaced it is the same as dropping the binding.
    pub(crate) fn rollback(mut self) {
        self.host
            .end_installation(self.session_id, &self.token, true);
        self.is_rolled_back = true;
    }
}

impl Drop for CallbackToolSpawnBinding {
    fn drop(&mut self) {
        if !self.is_rolled_back {
            self.host
                .end_installation(self.session_id, &self.token, false);
        }
    }
}

/// Installs the registry `request` asks for and binds its dispatcher to that installation, so a
/// later spawn's registry never answers this spawn's calls.
pub(crate) fn bind_callback_tools_for_spawn(
    host: &Arc<CallbackToolHost>,
    request: CallbackToolSpawnRequest,
) -> CallbackToolSpawnBinding {
    let session_id = request.session_id;
    let (token, admission) = host.resolve_spawn_registry(request);
    let dispatcher_host = Arc::clone(host);
    let dispatcher_token = token.clone();
    let dispatcher: CallbackToolDispatcher = Arc::new(move |invocation: CallbackToolInvocation| {
        let host = Arc::clone(&dispatcher_host);
        let token = dispatcher_token.clone();
        async move { host.dispatch(invocation, &token).await }.boxed()
    });
    CallbackToolSpawnBinding {
        admission,
        dispatcher,
        host: Arc::clone(host),
        session_id,
        token,
        is_rolled_back: false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use serde_json::{Map, Value};
    use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::{CallbackToolSpawnBinding, bind_callback_tools_for_spawn};
    use crate::callback_tools::host::{
        CallbackToolActivityRecord, CallbackToolActivitySink, CallbackToolAdmission,
        CallbackToolApprovalBasis, CallbackToolApprovalOutcome, CallbackToolApprovalSeam,
        CallbackToolExecutor, CallbackToolHost, CallbackToolPortError, CallbackToolSpawnRequest,
    };
    use crate::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};
    use crate::driver::diagnostics::RecordedEvents;
    use crate::driver::registry::test_provider;

    const SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
    const TOOL: &str = "search";

    /// The seam, executor and sink at once: the seam allows by policy, or fails when told to.
    struct TestPorts {
        is_seam_failing: bool,
    }

    impl CallbackToolApprovalSeam for TestPorts {
        fn evaluate<'a>(
            &'a self,
            _invocation: &'a CallbackToolInvocation,
            _provider: &'a ProviderId,
        ) -> BoxFuture<'a, Result<CallbackToolApprovalOutcome, CallbackToolPortError>> {
            let basis = CallbackToolApprovalBasis::Policy;
            let outcome = if self.is_seam_failing {
                Err("the policy store is closed".into())
            } else {
                Ok(CallbackToolApprovalOutcome::Allow { basis })
            };
            async { outcome }.boxed()
        }
    }

    impl CallbackToolExecutor for TestPorts {
        fn execute(
            &self,
            _invocation: CallbackToolInvocation,
        ) -> BoxFuture<'_, Result<CallbackToolResult, CallbackToolPortError>> {
            async { Ok(CallbackToolResult::Completed { output: None }) }.boxed()
        }
    }

    impl CallbackToolActivitySink for TestPorts {
        fn record<'a>(
            &'a self,
            _record: &'a CallbackToolActivityRecord,
        ) -> BoxFuture<'a, Result<(), CallbackToolPortError>> {
            async { Ok(()) }.boxed()
        }
    }

    /// A host whose seam is absent (`None`), failing, or allowing.
    fn host_with(is_seam_failing: Option<bool>) -> Arc<CallbackToolHost> {
        let ports = Arc::new(TestPorts {
            is_seam_failing: is_seam_failing.unwrap_or(false),
        });
        let seam: Option<Arc<dyn CallbackToolApprovalSeam>> =
            is_seam_failing.map(|_| Arc::clone(&ports) as Arc<dyn CallbackToolApprovalSeam>);
        let executor: Arc<dyn CallbackToolExecutor> = Arc::clone(&ports) as _;
        Arc::new(CallbackToolHost::new(executor, ports, seam))
    }

    fn bind(host: &Arc<CallbackToolHost>) -> CallbackToolSpawnBinding {
        let tool = SessionCallbackTool {
            name: TOOL.to_owned(),
            description: "Searches the session.".to_owned(),
            input_schema: Map::new(),
        };
        bind_callback_tools_for_spawn(
            host,
            CallbackToolSpawnRequest {
                session_id: SessionId::new(SESSION).expect("the text is a UUID"),
                provider: test_provider(),
                requested_tools: vec![tool],
                provider_registration_unavailable: None,
            },
        )
    }

    /// Calls `binding`'s dispatcher; the test doubles answer at once, so one poll settles it.
    fn call(binding: &CallbackToolSpawnBinding) -> CallbackToolResult {
        let invocation = CallbackToolInvocation {
            tool_name: FreeFormText::new(TOOL.to_owned()).expect("the name is in bounds"),
            arguments: Map::from_iter([("query".to_owned(), Value::from("x"))]),
            tool_call_id: ToolCallId::new("call-1".to_owned()).expect("the id is in bounds"),
            session_id: SessionId::new(SESSION).expect("the text is a UUID"),
            run_id: RunId::new("0192f0c8-7a3e-7b4c-9d2e-3f4a5b6c7d8e").expect("the text is a UUID"),
        };
        (binding.dispatcher)(invocation)
            .now_or_never()
            .expect("the test doubles answer at once")
    }

    #[test]
    fn only_the_live_installation_answers_or_is_restored_and_no_adjudication_is_denied() {
        use CallbackToolResult::{Completed, Denied, Failed};

        let recorded = RecordedEvents::default();
        recorded.record_during(|| {
            let host = host_with(Some(false));
            let first = bind(&host);
            let second = bind(&host);
            assert!(
                matches!(call(&first), Failed { .. }),
                "a replaced spawn's call is refused though the live registry has the same tool"
            );
            assert!(matches!(call(&second), Completed { .. }));
            second.rollback();
            assert!(
                matches!(call(&first), Completed { .. }),
                "a rollback restores the registry it replaced"
            );
            // A replaced spawn's teardown takes it off the rollback, so the failed spawn's rollback
            // restores nothing and logs no restore.
            let third = bind(&host);
            drop(first);
            third.rollback();

            let withheld = bind(&host_with(None));
            assert!(matches!(
                withheld.admission,
                CallbackToolAdmission::Withheld { .. }
            ));
            assert!(matches!(call(&withheld), Denied { .. }));
            let failing = bind(&host_with(Some(true)));
            assert!(matches!(call(&failing), Denied { .. }));
        });
        assert_eq!(
            recorded.counters(),
            [
                "driver.callbackTool.registrySuperseded",
                "driver.callbackTool.invocationRefused",
                "driver.callbackTool.registrySuperseded",
                "driver.callbackTool.registrySuperseded",
                "driver.callbackTool.registryReleaseIgnored",
                "driver.callbackTool.registryWithheld",
                "driver.callbackTool.seamAbsent",
                "driver.callbackTool.seamAbsent",
            ]
        );
    }
}
