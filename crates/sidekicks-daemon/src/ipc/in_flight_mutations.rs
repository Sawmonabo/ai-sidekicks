//! The mutating calls the daemon has taken and not yet finished. The gateway runs several calls at
//! once, so a write a client asked for can still be on its way when a flush or a stop arrives; the
//! flush waits for those calls before it answers, and a stop, for a bounded time, before it closes
//! the database.

use std::collections::HashMap;
use std::pin::pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use crate::bounded_wait::wait_within;
use crate::ipc::registry::{
    Dispatch, DispatchError, HandlerContext, MethodRegistry, Reply, Request,
};

tokio::task_local! {
    /// The id of the recorded call this task runs, so a wait inside it skips its own call.
    static RECORDED_CALL_ID: u64;
}

/// The gate that records every mutating call as it is dispatched, before the gateway reads the
/// connection's next call; a wait made inside a recorded call (a flush) skips that call.
pub(crate) struct InFlightMutations {
    /// The dispatch the calls go on to.
    next: Arc<dyn Dispatch>,
    /// The frozen registry, whose entries say which method mutates.
    registry: Arc<MethodRegistry>,
    /// The recorded calls still running.
    calls: Arc<Mutex<RecordedCalls>>,
}

/// The recorded calls still running, each with its completion handle.
#[derive(Default)]
struct RecordedCalls {
    /// The id the next recorded call takes.
    next_id: u64,
    /// Each running call's completion handle, canceled once the call ends.
    running: HashMap<u64, CancellationToken>,
}

/// One recorded call: dropped when the call's future finishes or is dropped, which forgets it and
/// settles its completion handle.
struct RecordedCall {
    calls: Arc<Mutex<RecordedCalls>>,
    id: u64,
    completion: CancellationToken,
}

impl Drop for RecordedCall {
    fn drop(&mut self) {
        lock(&self.calls).running.remove(&self.id);
        self.completion.cancel();
    }
}

impl InFlightMutations {
    /// The gate over `next`; `registry` is the frozen registry whose entries say which method
    /// mutates.
    pub(crate) fn new(next: Arc<dyn Dispatch>, registry: Arc<MethodRegistry>) -> Self {
        Self {
            next,
            registry,
            calls: Arc::new(Mutex::new(RecordedCalls::default())),
        }
    }

    /// Resolves once every mutating call taken before this wait began has finished, answered or
    /// failed. A call taken afterward does not extend the wait, so a busy daemon still answers its
    /// flush.
    pub(crate) async fn wait_for_pending(&self) {
        for completion in self.running_calls() {
            completion.cancelled().await;
        }
    }

    /// As `wait_for_pending`, giving up after `bound`; answers how many of those calls were still
    /// running then, `0` when every one finished in time.
    pub(crate) async fn wait_for_pending_within(&self, bound: Duration) -> usize {
        let running = self.running_calls();
        let all_finished = pin!(async {
            for completion in &running {
                completion.cancelled().await;
            }
        });
        match wait_within(all_finished, bound, None).await {
            Some(()) => 0,
            None => running
                .iter()
                .filter(|completion| !completion.is_cancelled())
                .count(),
        }
    }

    /// The completion handles of the calls running now, but the one this wait runs inside.
    fn running_calls(&self) -> Vec<CancellationToken> {
        let own_call = RECORDED_CALL_ID.try_with(|id| *id).ok();
        lock(&self.calls)
            .running
            .iter()
            .filter(|&(id, _)| Some(*id) != own_call)
            .map(|(_, completion)| completion.clone())
            .collect()
    }
}

impl Dispatch for InFlightMutations {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        let is_mutating = self
            .registry
            .descriptor(&request.method)
            .is_some_and(|descriptor| descriptor.is_mutating);
        let call = self.next.dispatch(request, context);
        if !is_mutating {
            return call;
        }
        let recorded = record(Arc::clone(&self.calls));
        RECORDED_CALL_ID
            .scope(recorded.id, async move {
                let _recorded = recorded;
                call.await
            })
            .boxed()
    }
}

/// Records a call as running and answers its record, which forgets it when dropped.
fn record(calls: Arc<Mutex<RecordedCalls>>) -> RecordedCall {
    let completion = CancellationToken::new();
    let id = {
        let mut recorded = lock(&calls);
        let id = recorded.next_id;
        recorded.next_id += 1;
        recorded.running.insert(id, completion.clone());
        id
    };
    RecordedCall {
        calls,
        id,
        completion,
    }
}

fn lock(calls: &Mutex<RecordedCalls>) -> MutexGuard<'_, RecordedCalls> {
    calls.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::pin::pin;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use futures::FutureExt as _;
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};
    use serde_json::value::RawValue;
    use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
    use sidekicks_contracts::schema::received_check;
    use sidekicks_contracts::trust_statement::DeviceId;
    use sidekicks_contracts::typescript::TypeName;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use super::InFlightMutations;
    use crate::ipc::registry::{
        Dispatch, HandlerContext, MethodRegistryBuilder, Request, TransportId,
    };

    #[derive(Debug, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(deny_unknown_fields)]
    struct Nothing {}

    struct Write;

    impl Method for Write {
        type Params = Nothing;
        type Result = Nothing;
        const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
            method: "test.write",
            procedure_type: ProcedureType::Mutation,
            is_mutating: true,
            params: TypeName::of::<Nothing>(),
            result: TypeName::of::<Nothing>(),
            emission: None,
            refusals: &[],
            received_check: received_check::<Nothing>,
        };
    }

    /// A mutation whose handler waits for the mutating calls before it, as `daemon.flush` does.
    struct Flush;

    impl Method for Flush {
        type Params = Nothing;
        type Result = Nothing;
        const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
            method: "test.flush",
            ..Write::DESCRIPTOR
        };
    }

    fn call(method: &str) -> Request {
        Request {
            method: method.to_owned(),
            params: Some(RawValue::from_string("{}".to_owned()).expect("the params are JSON")),
            attachments: Vec::new(),
        }
    }

    fn write() -> Request {
        call("test.write")
    }

    fn context() -> HandlerContext {
        HandlerContext {
            transport_id: TransportId(1),
            device_id: DeviceId::new("device".to_owned()).expect("the id is well formed"),
            caller_process_id: None,
            cancellation: CancellationToken::new(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_mutation_taken_after_the_wait_began_does_not_extend_it() {
        // Each call runs until the test releases it, in the order the calls start.
        let releases: Arc<Mutex<VecDeque<CancellationToken>>> = Arc::default();
        let (started, mut has_started) = mpsc::unbounded_channel();
        let handler_releases = Arc::clone(&releases);
        let mut builder = MethodRegistryBuilder::new();
        builder
            .register::<Write, _>(move |nothing, _context| {
                let release = handler_releases
                    .lock()
                    .expect("no test thread panics holding it")
                    .pop_front()
                    .expect("the test queues a release per call");
                started.send(()).expect("the test listens");
                async move {
                    release.cancelled().await;
                    Ok(nothing)
                }
                .boxed()
            })
            .expect("the write registers");
        let registry = Arc::new(builder.freeze());
        let in_flight = Arc::new(InFlightMutations::new(
            Arc::clone(&registry) as Arc<dyn Dispatch>,
            registry,
        ));
        let (first_release, later_release) = (CancellationToken::new(), CancellationToken::new());
        releases
            .lock()
            .expect("no test thread panics holding it")
            .extend([first_release.clone(), later_release.clone()]);

        let first = tokio::spawn(in_flight.dispatch(write(), context()));
        has_started.recv().await.expect("the first call starts");
        let mut wait = pin!(in_flight.wait_for_pending());
        assert!(futures::poll!(wait.as_mut()).is_pending(), "the wait began");
        let later = tokio::spawn(in_flight.dispatch(write(), context()));
        has_started.recv().await.expect("the later call starts");
        assert!(
            tokio::time::timeout(Duration::from_secs(1), wait.as_mut())
                .await
                .is_err(),
            "the wait holds while the first call runs"
        );

        first_release.cancel();
        first
            .await
            .expect("the first call ran")
            .expect("the first call answers");
        tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .expect("the wait ends while the later call runs");
        assert!(!later.is_finished());
        assert_eq!(
            in_flight
                .wait_for_pending_within(Duration::from_millis(10))
                .await,
            1,
            "the later call is still running at the bound"
        );
        later_release.cancel();
    }

    #[tokio::test(start_paused = true)]
    async fn a_flush_waits_for_the_write_before_it_and_never_for_itself() {
        let release = CancellationToken::new();
        let handler_release = release.clone();
        let gate: Arc<OnceLock<Arc<InFlightMutations>>> = Arc::default();
        let handler_gate = Arc::clone(&gate);
        let mut builder = MethodRegistryBuilder::new();
        builder
            .register::<Write, _>(move |nothing, _context| {
                let release = handler_release.clone();
                async move {
                    release.cancelled().await;
                    Ok(nothing)
                }
                .boxed()
            })
            .expect("the write registers");
        builder
            .register::<Flush, _>(move |nothing, _context| {
                let in_flight = Arc::clone(handler_gate.get().expect("the gate is built"));
                async move {
                    in_flight.wait_for_pending().await;
                    Ok(nothing)
                }
                .boxed()
            })
            .expect("the flush registers");
        let registry = Arc::new(builder.freeze());
        let in_flight = Arc::new(InFlightMutations::new(
            Arc::clone(&registry) as Arc<dyn Dispatch>,
            registry,
        ));
        assert!(
            gate.set(Arc::clone(&in_flight)).is_ok(),
            "the gate is set once"
        );

        // Both calls are dispatched before either runs, as the gateway reads one connection's calls.
        let write = in_flight.dispatch(write(), context());
        let mut flush = pin!(in_flight.dispatch(call("test.flush"), context()));
        let write = tokio::spawn(write);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), flush.as_mut())
                .await
                .is_err(),
            "the flush waits for the write dispatched before it"
        );
        release.cancel();
        write
            .await
            .expect("the write ran")
            .expect("the write answers");
        tokio::time::timeout(Duration::from_secs(1), flush)
            .await
            .expect("the flush does not wait for itself")
            .expect("the flush answers");
    }
}
