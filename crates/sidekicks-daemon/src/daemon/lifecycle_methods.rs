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

use crate::ipc::in_flight_mutations::RecordedCallId;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::provider::driver::daemon_stop::DaemonStopIntent;

/// Resolves once every write pending at the call is durable; stops nothing. It takes the call's
/// own in-flight record, so a wait on the pending mutations excludes the flush itself.
pub(crate) type FlushWrites = Arc<
    dyn Fn(Option<RecordedCallId>) -> BoxFuture<'static, Result<(), HandlerError>> + Send + Sync,
>;

/// What the lifecycle verbs act on: the running daemon.
#[derive(Clone)]
pub(crate) struct LifecycleMethodsDeps {
    /// The flush of the pending writes.
    pub(crate) flush: FlushWrites,
    /// Starts the daemon's stop for the intent given; it runs once the call's reply is queued, so
    /// the reply is written before the stop closes the connection. The stop waits for the writes
    /// already under way within its drain bound.
    pub(crate) accept_stop: Arc<dyn Fn(DaemonStopIntent) + Send + Sync>,
}

/// Registers `daemon.flush`, `daemon.stop`, `daemon.restart` and `daemon.ping`. A stop goes ahead
/// with no wait for the other connected clients; a restart ends the daemon as a stop does, and its
/// caller starts it again. Fails the start when a method is already registered.
pub(crate) fn register_lifecycle_methods(
    registry: &mut MethodRegistryBuilder,
    deps: &LifecycleMethodsDeps,
) -> Result<(), RegistrationError> {
    let flush = Arc::clone(&deps.flush);
    registry.register::<DaemonFlush, _>(move |_: EmptyPayload, context: HandlerContext| {
        let flushed = flush(context.recorded_call);
        async move {
            flushed.await?;
            Ok(DaemonFlushResponse {
                flushed: BoolLiteral,
            })
        }
        .boxed()
    })?;
    register_stop::<DaemonStop>(registry, deps, DaemonStopIntent::Stop)?;
    register_stop::<DaemonRestart>(registry, deps, DaemonStopIntent::Restart)?;
    // The answer arriving is the whole of it.
    registry.register::<DaemonPing, _>(|_: EmptyPayload, _context: HandlerContext| {
        async { Ok(EmptyPayload {}) }.boxed()
    })
}

// Registers a verb that accepts the daemon's stop for `intent`.
fn register_stop<M>(
    registry: &mut MethodRegistryBuilder,
    deps: &LifecycleMethodsDeps,
    intent: DaemonStopIntent,
) -> Result<(), RegistrationError>
where
    M: Method<Params = EmptyPayload, Result = DaemonLifecycleAccepted> + 'static,
{
    let accept_stop = Arc::clone(&deps.accept_stop);
    registry.register::<M, _>(move |_: EmptyPayload, context: HandlerContext| {
        let accept_stop = Arc::clone(&accept_stop);
        context.after_reply.set(move || accept_stop(intent));
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
    use std::sync::{Arc, Mutex, OnceLock, PoisonError};
    use std::time::Duration;

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
    use crate::ipc::in_flight_mutations::InFlightMutations;
    use crate::ipc::registry::{
        Dispatch, DispatchError, HandlerContext, MethodRegistry, MethodRegistryBuilder, Reply,
    };
    use crate::provider::driver::daemon_stop::DaemonStopIntent;

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
        stops: Arc<Mutex<Vec<DaemonStopIntent>>>,
    }

    fn lifecycle() -> Lifecycle {
        let flushes = Arc::new(Mutex::new(Vec::new()));
        let stops = Arc::new(Mutex::new(Vec::new()));
        let held = Arc::clone(&flushes);
        let counted = Arc::clone(&stops);
        let mut builder = MethodRegistryBuilder::new();
        register_lifecycle_methods(
            &mut builder,
            &LifecycleMethodsDeps {
                flush: Arc::new(move |_caller| {
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
                accept_stop: Arc::new(move |intent| {
                    counted
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(intent);
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

    // `daemon.stop` and `daemon.restart` are mutations that each accept one stop once their reply
    // is queued, the restart's carrying its intent so a lasting provider service outlives it;
    // `daemon.start` is no method, since a cold start is the command line's spawn. Killed by a
    // lifecycle verb registered as a query, by a stop that is not accepted, by a stop accepted
    // before its reply is queued, and by `lifecycle_methods.rs`'s restart registered with
    // `DaemonStopIntent::Stop`.
    #[tokio::test]
    async fn stop_and_restart_accept_a_stop_after_their_reply_and_start_is_no_method() {
        let lifecycle = lifecycle();
        let stops = || {
            lifecycle
                .stops
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        };
        let mut accepted = Vec::new();
        for (method, intent) in [
            (DaemonStop::DESCRIPTOR.method, DaemonStopIntent::Stop),
            (DaemonRestart::DESCRIPTOR.method, DaemonStopIntent::Restart),
        ] {
            let descriptor = lifecycle
                .registry
                .descriptor(method)
                .expect("the verb is registered");
            assert_eq!(descriptor.procedure_type, ProcedureType::Mutation);
            assert!(descriptor.is_mutating, "{method} is a mutating call");
            let context = context(1);
            let after_reply = context.after_reply.clone();
            let reply = lifecycle
                .registry
                .dispatch(request(method, Some(&json!({}))), context)
                .await;
            assert_eq!(answer(reply), json!({ "accepted": true }));
            assert_eq!(stops(), accepted, "{method} waits for its reply");
            after_reply.run();
            accepted.push(intent);
            assert_eq!(stops(), accepted);
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
        assert!(
            lifecycle
                .stops
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty(),
            "a flush stops nothing"
        );
    }

    // The flush waits only for the writes recorded before it: dispatched through the in-flight
    // record, which records it as a mutation itself, a flush alone answers at once. Killed by a
    // handler that waits with `None` in place of its own call id, which waits on its own record.
    #[tokio::test]
    async fn a_flush_alone_never_waits_on_its_own_record() {
        let gate: Arc<OnceLock<Arc<InFlightMutations>>> = Arc::default();
        let handler_gate = Arc::clone(&gate);
        let mut builder = MethodRegistryBuilder::new();
        register_lifecycle_methods(
            &mut builder,
            &LifecycleMethodsDeps {
                flush: Arc::new(move |caller| {
                    let in_flight = Arc::clone(handler_gate.get().expect("the gate is built"));
                    async move {
                        in_flight.wait_for_pending(caller).await;
                        Ok(())
                    }
                    .boxed()
                }),
                accept_stop: Arc::new(|_intent| {}),
            },
        )
        .expect("the lifecycle verbs register");
        let registry = Arc::new(builder.freeze());
        let in_flight = Arc::new(InFlightMutations::new(
            Arc::clone(&registry) as Arc<dyn Dispatch>,
            registry,
        ));
        assert!(
            gate.set(Arc::clone(&in_flight)).is_ok(),
            "the gate is set once"
        );
        let flushed = tokio::time::timeout(
            Duration::from_secs(1),
            in_flight.dispatch(
                request(DaemonFlush::DESCRIPTOR.method, Some(&json!({}))),
                context(1),
            ),
        )
        .await
        .expect("a flush alone answers");
        assert_eq!(answer(flushed), json!({ "flushed": true }));
    }
}
