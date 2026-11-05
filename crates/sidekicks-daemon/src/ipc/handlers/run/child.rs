//! A person's controls on a session's helpers: one helper's interrupt and its pause or continue,
//! named by its handle, and the stop of every agent the session dispatched; the interrupt and the
//! stop record the device the call came from as their actor.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::run::control::{
    AgentChildRunInterrupt, AgentChildRunPausedUpdate, AgentChildRunStopAll,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::agent_tree::controls::ChildRunControls;

use super::calling_person;

/// Registers `agent.childRun.interrupt`, `agent.childRun.paused.update` and
/// `agent.childRun.stopAll` over `controls`. Fails the start when one is already registered.
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
    let pauses = Arc::clone(&controls);
    registry.register::<AgentChildRunPausedUpdate, _>(
        move |request, _context: HandlerContext| {
            let controls = Arc::clone(&pauses);
            async move { Ok(controls.paused_update(request).await?) }.boxed()
        },
    )?;
    registry.register::<AgentChildRunStopAll, _>(move |request, context: HandlerContext| {
        let controls = Arc::clone(&controls);
        async move {
            let actor = calling_person(&context, AgentChildRunStopAll::DESCRIPTOR.method)?;
            Ok(controls.stop_all(request, actor).await?)
        }
        .boxed()
    })
}
