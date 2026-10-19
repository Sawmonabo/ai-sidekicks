//! The service's lifecycle verbs: the flush a quit sends, the stop and restart Settings › Runtime
//! and the command line send, and the answer to main's ping on a quiet link.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::daemon::lifecycle::{
    DaemonFlush, DaemonFlushResponse, DaemonLifecycleAccepted, DaemonPing, DaemonRestart,
    DaemonStop,
};
use sidekicks_contracts::method::Method;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::wire::BoolLiteral;

use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};

/// What the lifecycle verbs act on: the running daemon.
#[derive(Clone)]
pub(crate) struct LifecycleMethodsDeps {
    /// Resolves once every write pending at the call is durable; stops nothing.
    pub(crate) flush: Arc<dyn Fn() -> BoxFuture<'static, Result<(), HandlerError>> + Send + Sync>,
    /// Starts the daemon's stop once the current reply is written; the stop waits for the writes
    /// already under way within its drain bound.
    pub(crate) accept_stop: Arc<dyn Fn() + Send + Sync>,
}

/// Registers `daemon.flush`, `daemon.stop`, `daemon.restart` and `daemon.ping`. A stop goes ahead
/// with no wait for the other connected clients; a restart ends the daemon as a stop does, and its
/// caller starts it again. Fails the start when a method is already registered.
pub(crate) fn register_lifecycle_methods(
    registry: &mut MethodRegistryBuilder,
    deps: &LifecycleMethodsDeps,
) -> Result<(), RegistrationError> {
    let flush = Arc::clone(&deps.flush);
    registry.register::<DaemonFlush, _>(move |_: EmptyPayload, _context: HandlerContext| {
        let flushed = flush();
        async move {
            flushed.await?;
            Ok(DaemonFlushResponse {
                flushed: BoolLiteral,
            })
        }
        .boxed()
    })?;
    register_stop::<DaemonStop>(registry, deps)?;
    register_stop::<DaemonRestart>(registry, deps)?;
    // The answer arriving is the whole of it.
    registry.register::<DaemonPing, _>(|_: EmptyPayload, _context: HandlerContext| {
        async { Ok(EmptyPayload {}) }.boxed()
    })
}

// Registers a verb that accepts the daemon's stop.
fn register_stop<M>(
    registry: &mut MethodRegistryBuilder,
    deps: &LifecycleMethodsDeps,
) -> Result<(), RegistrationError>
where
    M: Method<Params = EmptyPayload, Result = DaemonLifecycleAccepted> + 'static,
{
    let accept_stop = Arc::clone(&deps.accept_stop);
    registry.register::<M, _>(move |_: EmptyPayload, _context: HandlerContext| {
        accept_stop();
        async {
            Ok(DaemonLifecycleAccepted {
                accepted: BoolLiteral,
            })
        }
        .boxed()
    })
}
