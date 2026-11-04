//! A person's controls on one helper of a run, named by its handle: each records the device the
//! call came from as its actor.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::run::control::AgentChildRunInterrupt;
use sidekicks_contracts::run::events::{InterventionActor, InterventionDeviceActor};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_session::agent_tree::controls::ChildRunControls;

/// The connection's device names the daemon itself, which no person's call can carry.
#[derive(Debug, thiserror::Error)]
#[error("the calling device names the daemon itself")]
struct CallingDeviceIsDaemon;

// The person whose device made the call to `method`, as an intervention's actor; a device that
// names the daemon itself is a fault.
fn calling_person(
    context: &HandlerContext,
    method: &'static str,
) -> Result<InterventionActor, HandlerError> {
    let actor = InterventionDeviceActor::new(context.calling_device(method)?)
        .ok_or_else(|| HandlerError::Internal(Box::new(CallingDeviceIsDaemon)))?;
    Ok(InterventionActor::Device(actor))
}

/// Registers `agent.childRun.interrupt` over `controls`. Fails the start when it is already
/// registered.
pub(crate) fn register_child_run_controls(
    registry: &mut MethodRegistryBuilder,
    controls: Arc<ChildRunControls>,
) -> Result<(), RegistrationError> {
    registry.register::<AgentChildRunInterrupt, _>(move |request, context: HandlerContext| {
        let controls = Arc::clone(&controls);
        async move {
            let actor = calling_person(&context, AgentChildRunInterrupt::DESCRIPTOR.method)?;
            Ok(controls.interrupt(request, actor).await?)
        }
        .boxed()
    })
}
