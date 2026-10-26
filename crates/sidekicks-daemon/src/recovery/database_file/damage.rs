//! Damage to the database file found while the daemon has it open: the start's check, or any read
//! or write SQLite failed as corrupt. The file cannot be replaced under open connections, so the
//! damage is recorded beside the file, the daemon stops, and its next start repairs the file from
//! the record, before anything opens it. The damage gate tells the watch of every call's failure,
//! and the open subscriptions of every feed's, so damage a read meets reaches the repair.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::ErrorCode;
use tokio::sync::{SetOnce, SetOnceError};

use crate::daemon::process::jobs::IdleMemoryCollect;
use crate::database::writer::sqlite_error_code;
use crate::error_description::describe_error;
use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::ipc::registry::{Dispatch, DispatchError, HandlerContext, Reply, Request};
use crate::missing_entry::MissingEntry as _;
use crate::recovery::database_file::sibling_path;

/// The suffix of the damage record kept beside the database file.
const DAMAGE_RECORD_SUFFIX: &str = ".damaged";

/// The damage record's mode: only the user reads it.
const DAMAGE_RECORD_MODE: u32 = 0o600;

/// Whether SQLite failed because the file is damaged: any `SQLITE_CORRUPT` code, an index's
/// included, which a write can raise too, or a file that is not a database, carried by `error` or
/// the first of its sources to carry a SQLite code.
pub(crate) fn is_database_damage_error(error: &(dyn Error + 'static)) -> bool {
    matches!(
        sqlite_error_code(error),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

/// Learns of damage to the database file once, from whichever part of the daemon meets it.
pub(crate) struct DatabaseDamageWatch {
    found: SetOnce<String>,
}

impl DatabaseDamageWatch {
    /// A watch that has found no damage.
    pub(crate) fn new() -> Self {
        Self {
            found: SetOnce::new(),
        }
    }

    /// Resolves with what the first damage found was; never resolves while none is.
    pub(crate) async fn when_found(&self) -> &str {
        self.found.wait().await
    }

    /// What the first damage found was, `None` while none is.
    pub(crate) fn found(&self) -> Option<&str> {
        self.found.get().map(String::as_str)
    }

    /// Whether damage has been found, so a caller acts before a waiter on `when_found` runs.
    pub(crate) fn is_found(&self) -> bool {
        self.found.initialized()
    }

    /// Records damage the check or a caller describes as `damage`; only the first counts.
    pub(crate) fn find(&self, damage: String) {
        if let Err(SetOnceError(later)) = self.found.set(damage) {
            // Two parts of the daemon can meet the damage at once; the first find is the one the
            // repair reads, so a later one is dropped.
            drop(later);
        }
    }

    /// Records `error` as damage when SQLite raised it for a damaged file; any other failure is
    /// left to its caller. The start, the recovery pass and every read that meets a failure call
    /// it; nothing is built for a failure that is no damage, or once damage is found.
    pub(crate) fn report(&self, error: &(dyn Error + 'static)) {
        if !self.is_found() && is_database_damage_error(error) {
            self.find(describe_error(error));
        }
    }

    /// Records a call's or a feed's failure as damage as [`DatabaseDamageWatch::report`] does.
    /// An internal fault forwards its message and sources straight through, so its source walk
    /// skips the fault itself; the fault is reported directly, where its own SQLite code is read.
    pub(crate) fn report_dispatch_failure(&self, error: &DispatchError) {
        if let DispatchError::Internal(fault) = error {
            self.report(fault.as_ref());
        } else {
            self.report(error);
        }
    }
}

/// Records the damage beside the database file, durably, so the next start repairs the file.
/// Fails with the crash-safe write's failure.
pub(crate) async fn record_database_damage(
    database_path: &Path,
    damage: &str,
) -> Result<(), AtomicWriteError> {
    write_file_atomically(
        &damage_record_path(database_path),
        damage.to_owned(),
        DAMAGE_RECORD_MODE,
    )
    .await
}

/// The damage a run recorded for the next start to repair, `None` when none was. Fails with the
/// file system's error.
pub(crate) async fn read_database_damage(database_path: &Path) -> io::Result<Option<String>> {
    tokio::fs::read_to_string(damage_record_path(database_path))
        .await
        .none_if_missing()
}

/// Removes the damage record once the file it named is replaced or gone; a missing record is
/// already removed. Fails with the file system's error.
pub(crate) async fn remove_database_damage(database_path: &Path) -> io::Result<()> {
    tokio::fs::remove_file(damage_record_path(database_path))
        .await
        .none_if_missing()
        .map(drop)
}

fn damage_record_path(database_path: &Path) -> PathBuf {
    sibling_path(database_path, DAMAGE_RECORD_SUFFIX)
}

/// The gate that tells the watch of every failure a call meets, then hands the failure on to the
/// caller unchanged, holding the idle memory collect off while the call runs.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which puts the gate in front of the registry"
    )
)]
pub(crate) struct DamageReportGate {
    /// The dispatch the calls go on to.
    next: Arc<dyn Dispatch>,
    /// The watch each failure is told to.
    watch: Arc<DatabaseDamageWatch>,
    /// The collect each call holds off until it answers.
    idle_memory: Arc<IdleMemoryCollect>,
}

impl DamageReportGate {
    /// The gate over `next`, telling `watch` of each failure and holding `idle_memory` off while
    /// a call runs.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
    pub(crate) fn new(
        next: Arc<dyn Dispatch>,
        watch: Arc<DatabaseDamageWatch>,
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
        let watch = Arc::clone(&self.watch);
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
    use tokio::sync::watch;
    use tokio_util::sync::CancellationToken;

    use super::{DamageReportGate, DatabaseDamageWatch};
    use crate::daemon::process::jobs::IdleMemoryCollect;
    use crate::database::writer::messages::WriteJobFailure;
    use crate::ipc::call_fixtures::{context, request};
    use crate::ipc::registry::{
        Dispatch, DispatchError, EncodedValue, HandlerContext, Reply, Request,
    };

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
            Arc::clone(&watch),
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
