//! The retention methods on Settings › Runtime: the two bounds read, set and followed, and
//! `Delete old data`. The purge removes the sessions archived or closed before the cutoff the
//! confirm was read against, a session's finish being its latest archive or close, together with
//! every session a failed purge left marked; the read's count is taken with the same selection, so
//! the confirm names exactly what the purge removes. A purge that removed a session schedules the
//! file's repack, which waits until no run is live, and a backup, which runs while `Back up
//! automatically` is on.

use std::error::Error;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::FutureExt as _;
use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};
use sidekicks_contracts::daemon::retention::{
    DaemonRetentionBounds, DaemonRetentionPurge, DaemonRetentionPurgePreview,
    DaemonRetentionPurgeRequest, DaemonRetentionPurgeResponse, DaemonRetentionRead,
    DaemonRetentionReadResponse, DaemonRetentionSubscribe, DaemonRetentionUpdate,
    DaemonRetentionUpdateRequest,
};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::daemon::backup::run::{BackupTrigger, Backups};
use crate::daemon::configuration::{ConfigurationChange, ConfigurationStore};
use crate::data_acts::purge::rows::PurgeCaller;
use crate::data_acts::purge::{SessionPurge, SessionPurgeOutcome};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::{LatestValueFeed, LatestValueOutlet};
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_std::scheduler::{JobCondition, Scheduler};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::repack::{RepackJobDeps, repack_job};
use sidekicks_workflow::runs::record::{StoredInstantBound, stored_instant_bound};

/// The statements the methods' reads prepare, counted into the read pool's statement capacity.
pub(crate) const RETENTION_STATEMENT_CAPACITY: usize = 2;

const DAY: Duration = Duration::from_hours(24);

// The first instant the stored form writes.
const EARLIEST_STORED_INSTANT: &str = "0000-01-01T00:00:00.000Z";

// The sessions the purge removes: every one a failed purge left marked, and each archived or closed
// one whose latest archive or close came before `@cutoff`, or every one when `@every_finished`.
// A `NULL` cutoff, before every stored instant, selects no finished session.
static SELECTED_SESSIONS_CONDITION: LazyLock<String> = LazyLock::new(|| {
    let marked = <&'static str>::from(SessionState::PurgeRequested);
    let finished = sql_list_of([SessionState::Archived, SessionState::Closed].map(<&str>::from));
    let finishes = sql_list_of(
        [
            SessionEventType::SessionArchived,
            SessionEventType::SessionClosed,
        ]
        .map(SessionEventType::as_str),
    );
    format!(
        "session.state = '{marked}'
      OR (session.state IN ({finished})
          AND (?2 OR (SELECT max(event.occurred_at) FROM session_events AS event
                       WHERE event.session_id = session.id AND event.type IN ({finishes})) < ?1))"
    )
});

static SELECTED_COUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT count(*) FROM sessions AS session WHERE {}",
        *SELECTED_SESSIONS_CONDITION
    )
});

static SELECTED_IDS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT session.id FROM sessions AS session WHERE {} ORDER BY session.rowid",
        *SELECTED_SESSIONS_CONDITION
    )
});

/// What the retention methods read and run through.
pub(crate) struct RetentionMethodsDeps {
    /// The configuration store holding the two bounds.
    pub(crate) configuration: Arc<ConfigurationStore>,
    /// The read pool the selection is read through.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The purge that removes the selected sessions.
    pub(crate) purge: Arc<SessionPurge>,
    /// The scheduler the repack runs on.
    pub(crate) scheduler: Arc<Scheduler>,
    /// What the repack runs through.
    pub(crate) repack: Arc<RepackJobDeps>,
    /// The backups, one of which runs after a purge that removed something while `Back up
    /// automatically` is on.
    pub(crate) backups: Arc<Backups>,
}

/// Why the selection could not be read.
#[derive(Debug, thiserror::Error)]
enum SelectionReadError {
    /// SQLite failed the read, or a stored id did not read as one.
    #[error("the sessions `Delete old data` removes could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SelectionReadError> for HandlerError {
    /// A selection the daemon cannot read is a fault in the daemon.
    fn from(error: SelectionReadError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Registers `daemon.retention.read`, `.update`, `.purge` and `.subscribe`. Fails the start when a
/// method is already registered.
pub(crate) fn register_retention_methods(
    registry: &mut MethodRegistryBuilder,
    deps: RetentionMethodsDeps,
) -> Result<(), RegistrationError> {
    let deps = Arc::new(deps);
    let reading = Arc::clone(&deps);
    registry.register::<DaemonRetentionRead, _>(
        move |_: EmptyPayload, _context: HandlerContext| {
            let deps = Arc::clone(&reading);
            async move { read_retention(&deps).await }.boxed()
        },
    )?;
    let updating = Arc::clone(&deps);
    registry.register::<DaemonRetentionUpdate, _>(
        move |request: DaemonRetentionUpdateRequest, _context: HandlerContext| {
            let deps = Arc::clone(&updating);
            async move {
                let configuration = deps
                    .configuration
                    .update(ConfigurationChange::Bound(request))
                    .await?;
                Ok(configuration.retention)
            }
            .boxed()
        },
    )?;
    let purging = Arc::clone(&deps);
    registry.register::<DaemonRetentionPurge, _>(
        move |request: DaemonRetentionPurgeRequest, _context: HandlerContext| {
            let deps = Arc::clone(&purging);
            async move { purge_old_data(&deps, &request.cutoff_at).await }.boxed()
        },
    )?;
    registry.register_subscription::<DaemonRetentionSubscribe, _>(
        move |_: EmptyPayload, _context: HandlerContext, subscription_id: SubscriptionId| {
            let configuration = Arc::clone(&deps.configuration);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    Ok(follow_bounds(&configuration, outlet))
                })
                .await?;
                let feed: Box<dyn Feed<Emission = DaemonRetentionBounds>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

// The bounds, and what the purge would remove at the cutoff `Keep sessions for` sets now.
async fn read_retention(
    deps: &RetentionMethodsDeps,
) -> Result<DaemonRetentionReadResponse, HandlerError> {
    let bounds = deps.configuration.current().retention;
    let keep =
        DAY.saturating_mul(u32::try_from(bounds.keep_sessions_days.get()).unwrap_or(u32::MAX));
    // A bound reaching before the year 0000 counts from its first instant, before every session.
    let cutoff_at = jiff::Timestamp::now()
        .checked_sub(keep)
        .ok()
        .and_then(WireInstant::from_timestamp)
        .unwrap_or_else(|| {
            WireInstant::try_from(EARLIEST_STORED_INSTANT.to_owned())
                .expect("the year 0000's first instant is an instant")
        });
    let bound = stored_instant_bound(&cutoff_at);
    let count = deps
        .reads
        .read(ReadLength::Short, move |connection| {
            count_selected(connection, &bound)
        })
        .await?;
    Ok(DaemonRetentionReadResponse {
        keep_diagnostic_logs_days: bounds.keep_diagnostic_logs_days,
        keep_sessions_days: bounds.keep_sessions_days,
        purge: DaemonRetentionPurgePreview {
            archived_session_count: SafeInt::new(count).expect("a count of rows is a safe integer"),
            cutoff_at,
        },
    })
}

// Purges the sessions selected at `cutoff_at` and answers how many went; a removal schedules the
// repack, and nothing removed schedules none.
async fn purge_old_data(
    deps: &RetentionMethodsDeps,
    cutoff_at: &WireInstant,
) -> Result<DaemonRetentionPurgeResponse, HandlerError> {
    let bound = stored_instant_bound(cutoff_at);
    let session_ids = deps
        .reads
        .read(ReadLength::Long, move |connection| {
            read_selected_ids(connection, &bound)
        })
        .await?;
    let meter = ProcessorMeter::default();
    let report = deps
        .purge
        .purge(&session_ids, PurgeCaller::Retention, &meter)
        .await;
    match meter.take_spent() {
        Ok(spent) => tracing::info!(
            spent_ms = spent.time.as_millis(),
            readings = spent.readings,
            "the processor time of the purge's payload reclaims, their reads and unlinks"
        ),
        Err(failure) => tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            "the processor time of the purge's payload reclaims could not be read"
        ),
    }
    let mut deleted = 0_u64;
    for (session_id, outcome) in &report.outcomes {
        match outcome {
            SessionPurgeOutcome::Removed { hand_out_failure } => {
                deleted += 1;
                if let Some(failure) = hand_out_failure {
                    tracing::warn!(
                        %session_id,
                        error = failure as &(dyn Error + 'static),
                        "a purged session's project rules were not handed out again"
                    );
                }
            }
            SessionPurgeOutcome::Refused(failure) => tracing::warn!(
                %session_id,
                error = failure as &(dyn Error + 'static),
                "a session was not purged; the next purge tries again"
            ),
        }
    }
    if deleted > 0 {
        if let Err(failure) = deps.scheduler.schedule(
            "repack",
            JobCondition::WhileIdle,
            Duration::ZERO,
            repack_job(Arc::clone(&deps.repack)),
        ) {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the database's repack could not be scheduled"
            );
        }
        if let Err(failure) = deps
            .backups
            .request(&deps.scheduler, BackupTrigger::AfterPurge)
        {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the backup after the purge could not be scheduled"
            );
        }
    }
    Ok(DaemonRetentionPurgeResponse {
        deleted_session_count: SafeInt::new(deleted)
            .expect("a count of sessions is a safe integer"),
    })
}

// The two bindings the selection reads: the cutoff in the stored form, and whether every finished
// session is selected.
fn selection_bindings(bound: &StoredInstantBound) -> [Value; 2] {
    match bound {
        StoredInstantBound::BeforeEvery => [Value::Null, Value::Integer(0)],
        StoredInstantBound::At(cutoff) => {
            [Value::Text(cutoff.as_str().to_owned()), Value::Integer(0)]
        }
        StoredInstantBound::AfterEvery => [Value::Null, Value::Integer(1)],
    }
}

fn count_selected(
    connection: &Connection,
    bound: &StoredInstantBound,
) -> Result<u64, SelectionReadError> {
    let count: i64 = connection
        .prepare_cached(&SELECTED_COUNT_SQL)?
        .query_row(params_from_iter(selection_bindings(bound)), |row| {
            row.get(0)
        })?;
    Ok(u64::try_from(count).unwrap_or(0))
}

fn read_selected_ids(
    connection: &Connection,
    bound: &StoredInstantBound,
) -> Result<Vec<SessionId>, SelectionReadError> {
    let mut statement = connection.prepare_cached(&SELECTED_IDS_SQL)?;
    let ids = statement
        .query_map(params_from_iter(selection_bindings(bound)), |row| {
            text_column(row, 0, |text| SessionId::new(&text))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

// Sends the bounds through `outlet` now, then again each time an update changes them, until the
// returned detach runs.
fn follow_bounds(
    configuration: &ConfigurationStore,
    outlet: LatestValueOutlet<DaemonRetentionBounds>,
) -> impl FnOnce() + Send + use<> {
    let mut changes = configuration.follow();
    let mut sent = changes.borrow_and_update().retention;
    outlet.send(sent);
    let following = tokio::spawn(async move {
        while changes.changed().await.is_ok() {
            let bounds = changes.borrow_and_update().retention;
            if bounds != sent {
                sent = bounds;
                outlet.send(bounds);
            }
        }
    });
    move || following.abort()
}

#[cfg(test)]
mod tests {
    use futures::FutureExt as _;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    use rusqlite::Connection;
    use serde_json::json;
    use sidekicks_contracts::daemon::retention::{
        DaemonRetentionBounds, DaemonRetentionPurge, DaemonRetentionPurgeResponse,
        DaemonRetentionRead, DaemonRetentionReadResponse, DaemonRetentionSubscribe,
        DaemonRetentionUpdate,
    };
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::SessionState;
    use sidekicks_platforms::WallClockTimer;
    use tokio::sync::watch;
    use tokio_util::sync::CancellationToken;

    use super::{RETENTION_STATEMENT_CAPACITY, RetentionMethodsDeps, register_retention_methods};
    use crate::daemon::configuration::{
        ConfigurationStore, DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
    };
    use tempfile::TempDir;

    use crate::daemon::backup::run::BACKUP_BUDGET;
    use crate::daemon::backup::run::tests::test_backups;
    use crate::data_acts::purge::tests::{PurgeFixture, purge_fixture, store_session};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{
        Dispatch as _, EncodedFeed, MethodRegistry, MethodRegistryBuilder, Reply,
    };
    use sidekicks_ipc::stream::feed::CreditGate;
    use sidekicks_shell::test_table::TableFixture;
    use sidekicks_std::scheduler::Scheduler;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
    use sidekicks_store::database::wal_truncation::WriteAheadLogTruncation;
    use sidekicks_store::database::writer::DatabaseWriter;
    use sidekicks_store::database::writer::repack::{
        RepackJobDeps, VolumeFreeBytesReader, repack_job,
    };
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_test_event, test_session_id,
    };
    use sidekicks_store::events::log_service::tests::TestLog;

    const WAIT: Duration = Duration::from_secs(10);

    // Long past any bound a test reads against.
    const LONG_AGO: &str = "2020-01-01T00:00:00.000Z";

    struct RetentionFixture {
        database: TestDatabase,
        log: TestLog,
        truncation: Arc<WriteAheadLogTruncation>,
        registry: MethodRegistry,
        scheduler: Arc<Scheduler>,
        // Kept so the run stays live and the jobs a purge schedules stay parked.
        _live_runs: watch::Sender<u32>,
        _shells: TableFixture,
        _home: TempDir,
    }

    // The retention methods over a purge fixture, with a run live so the repack a purge schedules
    // stays parked and the test runs it itself.
    async fn retention_fixture() -> RetentionFixture {
        let fixture = purge_fixture().await;
        let PurgeFixture {
            database,
            log,
            purge,
            truncation,
            live_runs: _,
            recovery: _,
            _shells: shells,
            _home: home,
        } = fixture;
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            RETENTION_STATEMENT_CAPACITY + DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
        ));
        let configuration = Arc::new(
            ConfigurationStore::open(Arc::clone(&log.writer), &reads)
                .await
                .expect("the configuration store opens"),
        );
        let live_runs = watch::Sender::new(1);
        let scheduler = Arc::new(Scheduler::start(
            Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
            None,
            live_runs.subscribe(),
        ));
        let mut builder = MethodRegistryBuilder::new();
        register_retention_methods(
            &mut builder,
            RetentionMethodsDeps {
                configuration,
                reads,
                purge: Arc::new(purge),
                scheduler: Arc::clone(&scheduler),
                repack: repack_deps(
                    &log.writer,
                    &truncation,
                    &database.path(),
                    |_| Ok(u64::MAX),
                    live_runs.subscribe(),
                ),
                backups: test_backups(
                    &database,
                    &log,
                    home.path().to_path_buf(),
                    Arc::new(|_meter| async { Ok(Vec::new()) }.boxed()),
                ),
            },
        )
        .expect("the retention methods register");
        RetentionFixture {
            database,
            log,
            truncation,
            registry: builder.freeze(),
            scheduler,
            _live_runs: live_runs,
            _shells: shells,
            _home: home,
        }
    }

    fn repack_deps(
        writer: &Arc<DatabaseWriter>,
        truncation: &Arc<WriteAheadLogTruncation>,
        database_path: &Path,
        read_volume_free_bytes: VolumeFreeBytesReader,
        live_runs: watch::Receiver<u32>,
    ) -> Arc<RepackJobDeps> {
        Arc::new(RepackJobDeps {
            writer: Arc::clone(writer),
            truncation: Arc::clone(truncation),
            database_path: database_path.to_path_buf(),
            read_volume_free_bytes,
            live_runs,
            budget: BACKUP_BUDGET,
        })
    }

    // A count of live runs that stays at none.
    fn no_live_runs() -> watch::Receiver<u32> {
        watch::Sender::new(0).subscribe()
    }

    async fn call<Answer: serde::de::DeserializeOwned>(
        registry: &MethodRegistry,
        method: &str,
        params: serde_json::Value,
    ) -> Answer {
        let Ok(Reply::Result(value)) = registry
            .dispatch(request(method, Some(&params)), context(1))
            .await
        else {
            panic!("{method} answers a result");
        };
        serde_json::from_slice(&value.json).expect("the result reads as its type")
    }

    // A finished session whose latest archive or close came at `finished_at`, with `events`
    // more rows so its purge frees pages.
    fn store_finished(
        reader: &Connection,
        state: SessionState,
        finished_at: &str,
        events: usize,
    ) -> SessionId {
        let session_id = test_session_id();
        store_session(reader, session_id, state);
        for _ in 0..events {
            insert_test_event(
                reader,
                session_id,
                json!({
                    "type": "session.pinned",
                    "payload": { "sessionId": session_id, "at": LONG_AGO },
                }),
                None,
                finished_at,
            );
        }
        let event_type = if state == SessionState::Closed {
            "session.closed"
        } else {
            "session.archived"
        };
        insert_test_event(
            reader,
            session_id,
            json!({
                "type": event_type,
                "payload": { "sessionId": session_id, "newState": state },
            }),
            None,
            finished_at,
        );
        session_id
    }

    fn wal_bytes(database_path: &Path) -> u64 {
        let mut wal = database_path.as_os_str().to_owned();
        wal.push("-wal");
        std::fs::metadata(PathBuf::from(wal)).map_or(0, |metadata| metadata.len())
    }

    fn freelist_count(reader: &Connection) -> i64 {
        reader
            .pragma_query_value(None, "freelist_count", |row| row.get(0))
            .expect("the test reads the free pages")
    }

    fn session_count(reader: &Connection, session_id: SessionId) -> i64 {
        reader
            .query_row(
                "SELECT count(*) FROM sessions WHERE id = ?1",
                [session_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test counts the session")
    }

    // The purge removes the sessions archived or closed before the read's cutoff, by their latest
    // finish and not their row's times, and every marked one; the read counts exactly those; a
    // purge selecting nothing schedules neither the repack nor the backup and still truncates the
    // log, and one that removes something schedules both. The repack is skipped without twice the
    // file free, and otherwise leaves an empty log and no free page. Killed by the finish read
    // from the session row, by the read and the purge selecting apart, by a purge of nothing
    // scheduling either job or skipping the truncation, by a removal scheduling neither, by the
    // free-room check inverted, and by the second truncation dropped.
    #[tokio::test]
    async fn the_purge_removes_what_the_read_counted_and_the_repack_reclaims_the_file() {
        let fixture = retention_fixture().await;
        let database_path = fixture.database.path();
        let first_read: DaemonRetentionReadResponse = call(
            &fixture.registry,
            DaemonRetentionRead::DESCRIPTOR.method,
            json!({}),
        )
        .await;
        let nothing: DaemonRetentionPurgeResponse = call(
            &fixture.registry,
            DaemonRetentionPurge::DESCRIPTOR.method,
            json!({ "cutoffAt": first_read.purge.cutoff_at }),
        )
        .await;
        assert_eq!(nothing.deleted_session_count.get(), 0);
        assert_eq!(fixture.scheduler.waiting_job_names(), Vec::<&str>::new());
        let reader = fixture.database.reader();
        let old_archived = store_finished(&reader, SessionState::Archived, LONG_AGO, 400);
        let old_closed = store_finished(&reader, SessionState::Closed, LONG_AGO, 400);
        let now = WireInstant::now();
        let recent = store_finished(&reader, SessionState::Archived, now.as_str(), 0);
        let marked = test_session_id();
        store_session(&reader, marked, SessionState::PurgeRequested);

        let read: DaemonRetentionReadResponse = call(
            &fixture.registry,
            DaemonRetentionRead::DESCRIPTOR.method,
            json!({}),
        )
        .await;
        assert_eq!(read.purge.archived_session_count.get(), 3);
        let purged: DaemonRetentionPurgeResponse = call(
            &fixture.registry,
            DaemonRetentionPurge::DESCRIPTOR.method,
            json!({ "cutoffAt": read.purge.cutoff_at }),
        )
        .await;
        assert_eq!(purged.deleted_session_count.get(), 3);
        let mut scheduled = fixture.scheduler.waiting_job_names();
        scheduled.sort_unstable();
        assert_eq!(scheduled, ["backup", "repack"]);
        for removed in [old_archived, old_closed, marked] {
            assert_eq!(session_count(&reader, removed), 0);
        }
        assert_eq!(
            session_count(&reader, recent),
            1,
            "the recent session stays"
        );

        tokio::time::timeout(WAIT, fixture.truncation.settled())
            .await
            .expect("the purge's truncation ends");
        let free_after_purge = freelist_count(&reader);
        assert!(free_after_purge > 0, "the purge freed pages");

        let mut skipped = repack_job(repack_deps(
            &fixture.log.writer,
            &fixture.truncation,
            &database_path,
            |_| Ok(0),
            no_live_runs(),
        ));
        skipped(CancellationToken::new())
            .await
            .expect("a skipped repack ends");
        assert_eq!(freelist_count(&reader), free_after_purge, "no repack ran");

        let mut repack = repack_job(repack_deps(
            &fixture.log.writer,
            &fixture.truncation,
            &database_path,
            |_| Ok(u64::MAX),
            no_live_runs(),
        ));
        repack(CancellationToken::new())
            .await
            .expect("the repack ends");
        tokio::time::timeout(WAIT, fixture.truncation.settled())
            .await
            .expect("the repack's truncation ends");
        assert_eq!(freelist_count(&reader), 0);
        assert_eq!(wal_bytes(&database_path), 0);

        let late = test_session_id();
        store_session(&reader, late, SessionState::Active);
        drop(reader);
        fixture
            .log
            .writer
            .write(vec![WriteStatement {
                sql: "UPDATE sessions SET name = 'renamed' WHERE id = ?1".into(),
                bindings: StatementBindings::Positional(vec![rusqlite::types::Value::Text(
                    late.text().as_str().to_owned(),
                )]),
                expected_row_count: Some(1),
            }])
            .await
            .expect("a write lands in the log");
        assert!(wal_bytes(&database_path) > 0);
        let nothing: DaemonRetentionPurgeResponse = call(
            &fixture.registry,
            DaemonRetentionPurge::DESCRIPTOR.method,
            json!({ "cutoffAt": read.purge.cutoff_at }),
        )
        .await;
        assert_eq!(nothing.deleted_session_count.get(), 0);
        tokio::time::timeout(WAIT, fixture.truncation.settled())
            .await
            .expect("the truncation ends");
        assert_eq!(wal_bytes(&database_path), 0, "a purge of nothing truncates");
    }

    async fn next_bounds(
        feed: &mut Box<dyn EncodedFeed>,
        gate: &CreditGate,
    ) -> DaemonRetentionBounds {
        let value = tokio::time::timeout(WAIT, feed.next(gate))
            .await
            .expect("an emission comes")
            .expect("the bounds read")
            .expect("the stream goes on");
        serde_json::from_slice(&value.json).expect("the emission reads as its type")
    }

    // A subscriber hears the bounds as they stand first, and each subscriber hears an update.
    // Killed by a subscriber that hears only changes, and by an update that reaches no follower.
    #[tokio::test]
    async fn a_subscriber_hears_the_bounds_first_and_each_update() {
        let fixture = retention_fixture().await;
        let subscribe = || {
            fixture.registry.dispatch(
                request(
                    DaemonRetentionSubscribe::DESCRIPTOR.method,
                    Some(&json!({})),
                ),
                context(1),
            )
        };
        let gate = CreditGate::with_credit(4);
        let Ok(Reply::Subscription {
            feed: mut first, ..
        }) = subscribe().await
        else {
            panic!("the subscribe answers a subscription");
        };
        let Ok(Reply::Subscription {
            feed: mut second, ..
        }) = subscribe().await
        else {
            panic!("the subscribe answers a subscription");
        };
        let standing = next_bounds(&mut first, &gate).await;
        assert_eq!(standing.keep_diagnostic_logs_days.get(), 7);
        assert_eq!(standing.keep_sessions_days.get(), 90);
        assert_eq!(next_bounds(&mut second, &gate).await, standing);

        let updated: DaemonRetentionBounds = call(
            &fixture.registry,
            DaemonRetentionUpdate::DESCRIPTOR.method,
            json!({ "keepSessionsDays": 30 }),
        )
        .await;
        assert_eq!(updated.keep_sessions_days.get(), 30);
        assert_eq!(next_bounds(&mut first, &gate).await, updated);
        assert_eq!(next_bounds(&mut second, &gate).await, updated);
    }
}
