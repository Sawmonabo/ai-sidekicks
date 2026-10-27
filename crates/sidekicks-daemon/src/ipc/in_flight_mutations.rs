//! The mutating calls the daemon has taken and not yet finished. The gateway runs several calls at
//! once, so a write a client asked for can still be on its way when a flush or a stop arrives; the
//! flush waits for those calls before it answers, and a stop, for a bounded time, before it closes
//! the database.

use std::collections::BTreeMap;
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use crate::bounded_wait::wait_within;
use crate::ipc::registry::{
    Dispatch, DispatchError, HandlerContext, MethodRegistry, Reply, Request,
};
use crate::mutex_lock::lock;

/// A recorded mutating call's place: ids rise in the order the gate records calls, so a call
/// recorded earlier has a smaller id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct RecordedCallId(u64);

/// The gate that records every mutating call as it is dispatched, before the gateway reads the
/// connection's next call, and hands the call its id in its `HandlerContext`.
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
    /// Each running call's completion handle, canceled once the call ends, in the order recorded.
    running: BTreeMap<RecordedCallId, CancellationToken>,
}

/// One recorded call: dropped when the call's future finishes or is dropped, which forgets it and
/// settles its completion handle.
struct RecordedCall {
    calls: Arc<Mutex<RecordedCalls>>,
    id: RecordedCallId,
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

    /// Resolves once every mutating call recorded before `caller` has finished, answered or
    /// failed; `caller` is the waiting call's own `recorded_call`, and `None` (a wait outside a
    /// recorded call) waits for every call running now. A call recorded later never extends the
    /// wait, so a busy daemon still answers its flush and two flushes never wait on each other.
    pub(crate) async fn wait_for_pending(&self, caller: Option<RecordedCallId>) {
        for completion in self.running_calls(caller) {
            completion.cancelled().await;
        }
    }

    /// As `wait_for_pending`, giving up after `bound`; answers how many of those calls were still
    /// running then, `0` when every one finished in time.
    pub(crate) async fn wait_for_pending_within(
        &self,
        caller: Option<RecordedCallId>,
        bound: Duration,
    ) -> usize {
        let running = self.running_calls(caller);
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

    /// The completion handles of the calls running now that were recorded before `caller`.
    fn running_calls(&self, caller: Option<RecordedCallId>) -> Vec<CancellationToken> {
        let calls = lock(&self.calls);
        let running = match caller {
            Some(caller) => calls.running.range(..caller),
            None => calls.running.range(..),
        };
        running.map(|(_, completion)| completion.clone()).collect()
    }
}

impl Dispatch for InFlightMutations {
    fn dispatch(
        &self,
        request: Request,
        mut context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        let is_mutating = self
            .registry
            .descriptor(&request.method)
            .is_some_and(|descriptor| descriptor.is_mutating);
        if !is_mutating {
            return self.next.dispatch(request, context);
        }
        let recorded = record(Arc::clone(&self.calls));
        context.recorded_call = Some(recorded.id);
        let call = self.next.dispatch(request, context);
        async move {
            let _recorded = recorded;
            call.await
        }
        .boxed()
    }
}

/// Records a call as running and answers its record, which forgets it when dropped.
fn record(calls: Arc<Mutex<RecordedCalls>>) -> RecordedCall {
    let completion = CancellationToken::new();
    let id = {
        let mut recorded = lock(&calls);
        let id = RecordedCallId(recorded.next_id);
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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::pin::pin;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use futures::FutureExt as _;
    use serde_json::json;
    use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
    use sidekicks_contracts::schema::received_check;
    use sidekicks_contracts::typescript::TypeName;
    use sidekicks_contracts::wire::attachment::check_received;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use super::InFlightMutations;
    use crate::ipc::call_fixtures::{Nothing, context, request};
    use crate::ipc::registry::{Dispatch, HandlerContext, MethodRegistryBuilder, Request};

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
            check_params: check_received::<Nothing>,
            keyed: false,
            takes_call_slot: true,
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
        request(method, Some(&json!({})))
    }

    fn write() -> Request {
        call("test.write")
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

        let first = tokio::spawn(in_flight.dispatch(write(), context(1)));
        has_started.recv().await.expect("the first call starts");
        let mut wait = pin!(in_flight.wait_for_pending(None));
        assert!(futures::poll!(wait.as_mut()).is_pending(), "the wait began");
        let later = tokio::spawn(in_flight.dispatch(write(), context(1)));
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
                .wait_for_pending_within(None, Duration::from_millis(10))
                .await,
            1,
            "the later call is still running at the bound"
        );
        later_release.cancel();
    }

    #[tokio::test(start_paused = true)]
    async fn a_flush_waits_for_the_write_before_it_and_never_for_itself_or_a_later_flush() {
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
            .register::<Flush, _>(move |nothing, context: HandlerContext| {
                let in_flight = Arc::clone(handler_gate.get().expect("the gate is built"));
                async move {
                    in_flight.wait_for_pending(context.recorded_call).await;
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

        // Every call is dispatched before any runs, as the gateway reads one connection's calls.
        let write = in_flight.dispatch(write(), context(1));
        let mut flush = pin!(in_flight.dispatch(call("test.flush"), context(1)));
        let later_flush = in_flight.dispatch(call("test.flush"), context(2));
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
        let (flushed, later_flushed) = tokio::time::timeout(
            Duration::from_secs(1),
            futures::future::join(flush, later_flush),
        )
        .await
        .expect("neither flush waits for itself or for a flush after it");
        flushed.expect("the flush answers");
        later_flushed.expect("the later flush answers");
    }
}
