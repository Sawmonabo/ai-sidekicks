//! The damage gate in front of the method registry, and the damage watch as what a feed's failure
//! is reported to: every call's and every open subscription's failure reaches the watch, so damage
//! a read meets reaches the repair.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_ipc::registry::{Dispatch, DispatchError, HandlerContext, Reply, Request};
use sidekicks_ipc::stream::subscriptions::DispatchFailureWatch;
use sidekicks_store::database::damage::DatabaseDamageWatch;

use crate::daemon::process::jobs::IdleMemoryCollect;

/// The database damage watch, told of a call's or a feed's failure.
#[derive(Clone)]
pub(crate) struct DispatchDamageWatch(pub(crate) Arc<DatabaseDamageWatch>);

impl DispatchFailureWatch for DispatchDamageWatch {
    /// Records the failure as damage as [`DatabaseDamageWatch::report`] does. An internal fault
    /// forwards its message and sources straight through, so its source walk skips the fault
    /// itself; the fault is reported directly, where its own SQLite code is read.
    fn report_dispatch_failure(&self, failure: &DispatchError) {
        if let DispatchError::Internal(fault) = failure {
            self.0.report(fault.as_ref());
        } else {
            self.0.report(failure);
        }
    }
}

/// The gate that tells the watch of every failure a call meets, then hands the failure on to the
/// caller unchanged, holding the idle memory collect off while the call runs.
pub(crate) struct DamageReportGate {
    /// The dispatch the calls go on to.
    next: Arc<dyn Dispatch>,
    /// The watch each failure is told to.
    watch: DispatchDamageWatch,
    /// The collect each call holds off until it answers.
    idle_memory: Arc<IdleMemoryCollect>,
}

impl DamageReportGate {
    /// The gate over `next`, telling `watch` of each failure and holding `idle_memory` off while
    /// a call runs.
    pub(crate) fn new(
        next: Arc<dyn Dispatch>,
        watch: DispatchDamageWatch,
        idle_memory: Arc<IdleMemoryCollect>,
    ) -> Self {
        Self {
            next,
            watch,
            idle_memory,
        }
    }
}

impl Dispatch for DamageReportGate {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        let in_flight = self.idle_memory.touch();
        let call = self.next.dispatch(request, context);
        let watch = self.watch.clone();
        async move {
            let answer = call.await;
            drop(in_flight);
            if let Err(error) = &answer {
                watch.report_dispatch_failure(error);
            }
            answer
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use rusqlite::ffi;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{
        Dispatch, DispatchError, EncodedValue, HandlerContext, Reply, Request,
    };
    use sidekicks_store::database::damage::DatabaseDamageWatch;
    use sidekicks_store::database::writer::messages::WriteJobFailure;
    use tokio::sync::watch;
    use tokio_util::sync::CancellationToken;

    use super::{DamageReportGate, DispatchDamageWatch};
    use crate::daemon::process::jobs::IdleMemoryCollect;

    // What the dispatch behind the gate answers.
    #[derive(Clone, Copy, Debug)]
    enum Answer {
        // A clean reply.
        Reply,
        // An internal fault holding a SQLite failure inside the write that met it.
        WrappedFault(i32),
        // An internal fault that is the SQLite failure itself.
        BareFault(i32),
    }

    // A dispatch answering every call with its one answer, counting the calls it takes.
    struct Stub {
        answer: Answer,
        calls: Arc<AtomicUsize>,
    }

    impl Dispatch for Stub {
        fn dispatch(
            &self,
            _request: Request,
            _context: HandlerContext,
        ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let failure = |code| rusqlite::Error::SqliteFailure(ffi::Error::new(code), None);
            let answer = match self.answer {
                Answer::Reply => Ok(Reply::Result(EncodedValue {
                    json: b"{}".to_vec(),
                    attachments: Vec::new(),
                })),
                Answer::WrappedFault(code) => Err(DispatchError::Internal(Box::new(
                    WriteJobFailure::Statement {
                        statement_index: 0,
                        source: failure(code),
                    },
                ))),
                Answer::BareFault(code) => Err(DispatchError::Internal(Box::new(failure(code)))),
            };
            futures::future::ready(answer).boxed()
        }
    }

    // Removing the gate's report, reading only the top of the chain, missing the extended corrupt
    // code, counting a busy file as damage, or skipping an internal fault's own code each fails a
    // case; so does a gate that swallows the failure or answers a clean call anything but its
    // reply.
    #[rstest]
    #[case::a_clean_reply(Answer::Reply, false)]
    #[case::a_damaged_index_inside_a_write(Answer::WrappedFault(ffi::SQLITE_CORRUPT_INDEX), true)]
    #[case::a_damaged_file_as_the_fault(Answer::BareFault(ffi::SQLITE_NOTADB), true)]
    #[case::a_busy_file(Answer::WrappedFault(ffi::SQLITE_BUSY), false)]
    #[tokio::test]
    async fn the_gate_records_only_damage_and_hands_every_answer_on(
        #[case] answer: Answer,
        #[case] is_damage: bool,
    ) {
        let watch = Arc::new(DatabaseDamageWatch::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = DamageReportGate::new(
            Arc::new(Stub {
                answer,
                calls: Arc::clone(&calls),
            }),
            DispatchDamageWatch(Arc::clone(&watch)),
            Arc::new(IdleMemoryCollect::start(
                watch::channel(0).1,
                CancellationToken::new(),
            )),
        );

        let reply = gate.dispatch(request("test.call", None), context(1)).await;

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the call reaches the dispatch"
        );
        match (answer, reply) {
            (Answer::Reply, Ok(Reply::Result(value))) => assert_eq!(value.json, b"{}"),
            (Answer::WrappedFault(_) | Answer::BareFault(_), Err(DispatchError::Internal(_))) => {}
            (answer, _) => panic!("the gate changed the answer to {answer:?}"),
        }
        assert_eq!(watch.is_found(), is_damage);
    }
}
