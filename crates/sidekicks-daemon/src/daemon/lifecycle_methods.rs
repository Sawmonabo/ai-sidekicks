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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};

    use futures::FutureExt as _;
    use serde_json::{Value, json};
    use sidekicks_contracts::daemon::lifecycle::{DaemonFlush, DaemonRestart, DaemonStop};
    use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
    use sidekicks_contracts::schema::received_check;
    use sidekicks_contracts::typescript::TypeName;
    use sidekicks_contracts::wire::attachment::check_received;
    use tokio::sync::oneshot;

    use super::{LifecycleMethodsDeps, register_lifecycle_methods};
    use crate::ipc::call_fixtures::{Named, Nothing, context, request};
    use crate::ipc::registry::{
        Dispatch as _, DispatchError, HandlerContext, MethodRegistry, MethodRegistryBuilder, Reply,
    };

    /// A method of another namespace sharing the flush's last segment.
    struct SessionFlush;

    impl Method for SessionFlush {
        type Params = Nothing;
        type Result = Named;
        const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
            method: "session.flush",
            procedure_type: ProcedureType::Mutation,
            is_mutating: true,
            params: TypeName::of::<Nothing>(),
            result: TypeName::of::<Named>(),
            emission: None,
            refusals: &[],
            received_check: received_check::<Nothing>,
            check_params: check_received::<Nothing>,
            keyed: false,
            takes_call_slot: true,
        };
    }

    // The lifecycle verbs beside `session.flush`, with each flush held until the test lets it go
    // and each accepted stop counted.
    struct Lifecycle {
        registry: MethodRegistry,
        flushes: Arc<Mutex<Vec<oneshot::Sender<()>>>>,
        stops: Arc<AtomicUsize>,
    }

    fn lifecycle() -> Lifecycle {
        let flushes = Arc::new(Mutex::new(Vec::new()));
        let stops = Arc::new(AtomicUsize::new(0));
        let held = Arc::clone(&flushes);
        let counted = Arc::clone(&stops);
        let mut builder = MethodRegistryBuilder::new();
        register_lifecycle_methods(
            &mut builder,
            &LifecycleMethodsDeps {
                flush: Arc::new(move || {
                    let (release, released) = oneshot::channel();
                    held.lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(release);
                    async move {
                        released.await.expect("the test lets the flush go");
                        Ok(())
                    }
                    .boxed()
                }),
                accept_stop: Arc::new(move || {
                    counted.fetch_add(1, Ordering::SeqCst);
                }),
            },
        )
        .expect("the lifecycle verbs register");
        builder
            .register::<SessionFlush, _>(|_: Nothing, _context: HandlerContext| {
                async {
                    Ok(Named {
                        name: "sess".to_owned(),
                    })
                }
                .boxed()
            })
            .expect("a name in another namespace registers beside them");
        Lifecycle {
            registry: builder.freeze(),
            flushes,
            stops,
        }
    }

    fn answer(reply: Result<Reply, DispatchError>) -> Value {
        let Ok(Reply::Result(answer)) = reply else {
            panic!("the call answers");
        };
        serde_json::from_slice(&answer.json).expect("the answer is JSON")
    }

    // `daemon.stop` and `daemon.restart` are mutations that each accept one stop; `daemon.start`
    // is no method, since a cold start is the command line's spawn. Killed by a lifecycle verb
    // registered as a query, and by a stop that is not accepted.
    #[tokio::test]
    async fn stop_and_restart_are_mutations_that_accept_a_stop_and_start_is_no_method() {
        let lifecycle = lifecycle();
        for (count, method) in [
            DaemonStop::DESCRIPTOR.method,
            DaemonRestart::DESCRIPTOR.method,
        ]
        .into_iter()
        .enumerate()
        {
            let descriptor = lifecycle
                .registry
                .descriptor(method)
                .expect("the verb is registered");
            assert_eq!(descriptor.procedure_type, ProcedureType::Mutation);
            assert!(descriptor.is_mutating, "{method} is a mutating call");
            let reply = lifecycle
                .registry
                .dispatch(request(method, Some(&json!({}))), context(1))
                .await;
            assert_eq!(answer(reply), json!({ "accepted": true }));
            assert_eq!(lifecycle.stops.load(Ordering::SeqCst), count + 1);
        }
        assert!(matches!(
            lifecycle
                .registry
                .dispatch(request("daemon.start", Some(&json!({}))), context(1))
                .await,
            Err(DispatchError::MethodNotFound)
        ));
    }

    // A flush answers only once every pending write is durable and stops nothing, so the sessions
    // and shells keep running; `daemon.flush` and `session.flush` each reach their own handler.
    // Killed by a flush that answers before its writes settle, by a flush that accepts a stop,
    // and by names matched on their last segment.
    #[tokio::test]
    async fn a_flush_waits_for_its_writes_and_stops_nothing_and_names_never_collide() {
        let lifecycle = lifecycle();
        let mut flushed = lifecycle.registry.dispatch(
            request(DaemonFlush::DESCRIPTOR.method, Some(&json!({}))),
            context(1),
        );
        assert!(
            futures::poll!(&mut flushed).is_pending(),
            "the flush waits for its writes"
        );
        let session_flush = lifecycle
            .registry
            .dispatch(request("session.flush", Some(&json!({}))), context(1))
            .await;
        assert_eq!(answer(session_flush), json!({ "name": "sess" }));
        let release = lifecycle
            .flushes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop()
            .expect("the flush asked for its writes");
        release.send(()).expect("the flush still waits");
        assert_eq!(answer(flushed.await), json!({ "flushed": true }));
        assert_eq!(
            lifecycle.stops.load(Ordering::SeqCst),
            0,
            "a flush stops nothing"
        );
    }
}
