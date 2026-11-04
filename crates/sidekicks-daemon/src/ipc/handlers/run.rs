//! Run methods served on the socket: a person's controls on a run, the run queue's sends and
//! changes with its stream, the stream of every run's state in a session, the live intake of the
//! provider's safety holds it carries, and a person's controls on a session's helpers: one
//! helper's interrupt, and the stop of every agent the session dispatched, which sweeps its tree.

use sidekicks_contracts::run::events::{InterventionActor, InterventionDeviceActor};
use sidekicks_ipc::registry::{HandlerContext, HandlerError};

pub(crate) mod child;
pub(crate) mod control;
pub(crate) mod queue;
pub(crate) mod safety_holds;
pub(crate) mod state;

/// The connection's device names the daemon itself, which no person's call can carry.
#[derive(Debug, thiserror::Error)]
#[error("the calling device names the daemon itself")]
struct CallingDeviceIsDaemon;

/// The person whose device made the call to `method`, as an intervention's actor. Fails as the
/// connection's device read fails, and as a fault when that device names the daemon itself.
pub(super) fn calling_person(
    context: &HandlerContext,
    method: &'static str,
) -> Result<InterventionActor, HandlerError> {
    let actor = InterventionDeviceActor::new(context.calling_device(method)?)
        .ok_or_else(|| HandlerError::Internal(Box::new(CallingDeviceIsDaemon)))?;
    Ok(InterventionActor::Device(actor))
}
