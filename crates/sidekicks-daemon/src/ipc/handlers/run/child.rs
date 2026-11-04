//! A person's controls on a session's helpers: one helper's interrupt, named by its handle, and
//! the stop of every agent the session dispatched; each records the device the call came from as
//! its actor.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::run::control::{AgentChildRunInterrupt, AgentChildRunStopAll};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::agent_tree::controls::ChildRunControls;

use super::calling_person;

/// Registers `agent.childRun.interrupt` and `agent.childRun.stopAll` over `controls`. Fails the
/// start when one is already registered.
pub(crate) fn register_child_run_controls(
    registry: &mut MethodRegistryBuilder,
    controls: Arc<ChildRunControls>,
) -> Result<(), RegistrationError> {
    let interrupts = Arc::clone(&controls);
    registry.register::<AgentChildRunInterrupt, _>(move |request, context: HandlerContext| {
        let controls = Arc::clone(&interrupts);
        async move {
            let actor = calling_person(&context, AgentChildRunInterrupt::DESCRIPTOR.method)?;
            Ok(controls.interrupt(request, actor).await?)
        }
        .boxed()
    })?;
    registry.register::<AgentChildRunStopAll, _>(move |request, context: HandlerContext| {
        let controls = Arc::clone(&controls);
        async move {
            let actor = calling_person(&context, AgentChildRunStopAll::DESCRIPTOR.method)?;
            Ok(controls.stop_all(request, actor).await?)
        }
        .boxed()
    })
}
