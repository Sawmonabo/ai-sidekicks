//! The live index: the search index the daemon serves `session.search` and `transcript.search`
//! from, beside the one stored on disk. It opens in the background at the daemon's start, building
//! the index again in a child process when it cannot serve, and brings it in step with the
//! database before it answers its first search; a search waits for the open, and so does the
//! provider start, so no provider process adds to a build's memory. From then on each commit of
//! the daemon's writer applies what the outbox holds, each durable index commit has its outbox rows
//! deleted and wakes the merging. A failed open, rebuild or first catch-up fails every search
//! waiting and every later one, and is reported once. A failed apply after the open is logged
//! once and leaves searches answering from the last durable commit; it is tried again only once a
//! wait of 1 s doubling to 60 s runs out, a commit of the writer meanwhile waiting with it, and its
//! recovery is logged once.
//! A close takes no new search, lets the searches taken, the apply and the merge under way finish,
//! ends a build under way once its process has exited, then closes the index and waits for the
//! outbox deletes.

use std::cmp;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use rusqlite::Connection;
use sidekicks_contracts::session::methods::{SessionSearchRequest, SessionSearchResponse};
use sidekicks_contracts::transcript::search::{TranscriptSearchRequest, TranscriptSearchResponse};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::Spawner;
use sidekicks_search::index::{SearchIndex, SearchIndexError};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduledJobHandle, Scheduler};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio::sync::{Notify, OwnedRwLockReadGuard, RwLock, watch};
use tokio::task::JoinError;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::search::index::applier::{SearchIndexApplier, SearchIndexApplyError};
use crate::search::index::outbox::{AppliedOutbox, OutboxReader, delete_applied_outbox};
use crate::search::index::rebuild::{
    SearchIndexBuildRequest, SearchIndexChildError, SearchIndexOpenError, SearchIndexOpening,
    SearchIndexRebuildReason, build_search_index_in_child, open_search_index,
};
use crate::search::merging::SearchIndexMerging;
use crate::search::rowid_floors::{FloorPositionInFlight, FloorPositionsInFlight};
use crate::search::service::{SessionSearchError, SessionSearchService};
use crate::search::transcript::{TranscriptSearchError, search_transcript};

// The scheduler's name for the job that lets go of expired held searches.
const HELD_SEARCH_EXPIRY_JOB: &str = "search_held_expiry";

// The wait before a failed apply is tried again without a commit, doubled after each failure up to
// the longest.
const APPLY_RETRY_FIRST_WAIT: Duration = Duration::from_secs(1);
const APPLY_RETRY_LONGEST_WAIT: Duration = Duration::from_mins(1);

/// What the live index is started with.
pub struct LiveIndexOptions {
    /// The daemon's database, which a build reads in its own process.
    pub database_path: PathBuf,
    /// The index's folder in the daemon's data folder, an absolute path.
    pub index_folder: PathBuf,
    /// The daemon's own program, which a build runs in its `index` mode.
    pub program: PathBuf,
    /// Where a build's process is started.
    pub spawner: Spawner,
    /// The daemon's read connections: every search and outbox read runs on them.
    pub reads: Arc<DatabaseReadPool>,
    /// The daemon's writer: its commits start each apply, and it deletes the applied outbox rows.
    pub writer: Arc<DatabaseWriter>,
    /// The daemon's scheduler, which lets go of held searches at their expiry by the wall clock.
    pub scheduler: Arc<Scheduler>,
}

/// Why the live index failed or did not close cleanly.
#[derive(Debug, thiserror::Error)]
pub enum LiveIndexError {
    /// SQLite refused a read of the outbox or of the groups' members.
    #[error("a read of the search outbox failed")]
    Database(#[from] rusqlite::Error),
    /// A read did not reach a connection.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The index's open failed.
    #[error(transparent)]
    Open(#[from] SearchIndexOpenError),
    /// The index's build in its child process failed.
    #[error(transparent)]
    Build(#[from] SearchIndexChildError),
    /// The index built again still could not serve, for this reason.
    #[error("the search index was built again and still could not serve: {}", <&str>::from(.0))]
    StillUnservable(SearchIndexRebuildReason),
    /// The open's catch-up with the outbox failed, so the index is behind the database.
    #[error(transparent)]
    Apply(#[from] SearchIndexApplyError),
    /// The index refused the groups' members.
    #[error("the search index refused the groups' members")]
    GroupMembers(#[source] SearchIndexError),
    /// The index did not close.
    #[error("the search index did not close")]
    Close(#[source] SearchIndexError),
    /// A task of the live index ended without an answer.
    #[error("a task of the search index ended without an answer")]
    Task(#[from] JoinError),
}

/// Why the live index's close did not end cleanly: the first failure, with any after it.
pub type LiveIndexCloseError = CleanupFailures<LiveIndexError>;

/// Why a search on the live index was not answered.
#[derive(Debug, thiserror::Error)]
pub enum LiveIndexSearchError<Failure> {
    /// The live index has closed, or a close came while the search waited for the open.
    #[error("the search index has closed; the search did not run")]
    Closed,
    /// The open, a rebuild or the open's catch-up failed, so the index cannot answer.
    #[error("the search index failed")]
    Failed(#[source] Arc<LiveIndexError>),
    /// The search's read did not reach a connection.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The search itself failed.
    #[error(transparent)]
    Search(Failure),
}

impl From<LiveIndexSearchError<TranscriptSearchError>> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`, a cursor it cannot read
    /// `session.event.cursorUnresolvable`; an index that cannot answer or a failed read is a
    /// fault in the daemon.
    fn from(error: LiveIndexSearchError<TranscriptSearchError>) -> Self {
        match error {
            LiveIndexSearchError::Search(TranscriptSearchError::Refused(refusal)) => {
                Self::Refused(refusal)
            }
            LiveIndexSearchError::Search(TranscriptSearchError::CursorUnresolvable(
                unresolvable,
            )) => unresolvable.into(),
            LiveIndexSearchError::Search(
                fault @ (TranscriptSearchError::Database(_)
                | TranscriptSearchError::Index(_)
                | TranscriptSearchError::HitPosition(_)
                | TranscriptSearchError::HitRowId(_)),
            ) => Self::Internal(Box::new(fault)),
            fault @ (LiveIndexSearchError::Closed
            | LiveIndexSearchError::Failed(_)
            | LiveIndexSearchError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<LiveIndexSearchError<SessionSearchError>> for HandlerError {
    /// A cursor that continues no held search answers `session.search.cursorUnresolvable`; an
    /// index that cannot answer or a failed read is a fault in the daemon.
    fn from(error: LiveIndexSearchError<SessionSearchError>) -> Self {
        match error {
            LiveIndexSearchError::Search(SessionSearchError::Refused(refusal)) => {
                Self::Refused(refusal)
            }
            LiveIndexSearchError::Search(
                fault @ (SessionSearchError::Database(_)
                | SessionSearchError::Index(_)
                | SessionSearchError::HitPosition(_)),
            ) => Self::Internal(Box::new(fault)),
            fault @ (LiveIndexSearchError::Closed
            | LiveIndexSearchError::Failed(_)
            | LiveIndexSearchError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

// Where the live index stands; searches wait while it opens.
enum LiveIndexState {
    Opening,
    Open(OpenIndex),
    Failed(Arc<LiveIndexError>),
    Closed,
}

// The open index and its applier, which a search reads the applied floor from.
#[derive(Clone)]
struct OpenIndex {
    index: Arc<SearchIndex>,
    applier: Arc<SearchIndexApplier>,
}

// The held-search expiry the scheduler holds, and the instant it runs at.
struct HeldSearchExpiry {
    instant: SystemTime,
    job: ScheduledJobHandle,
}

// What the live index's task, its searches and its expiry job share.
struct LiveIndexShared {
    state: watch::Sender<LiveIndexState>,
    // Taken shared by each search and exclusively by the close, which so waits out the searches
    // taken.
    searches: Arc<RwLock<()>>,
    reads: Arc<DatabaseReadPool>,
    // Where in the floor log each search being read stands, until it is answered.
    floors_in_flight: Arc<FloorPositionsInFlight>,
    session_search: SessionSearchService,
    scheduler: Arc<Scheduler>,
    held_search_expiry: Mutex<Option<HeldSearchExpiry>>,
    // Canceled by the close: ends a build under way and the apply loop.
    stop: CancellationToken,
}

/// The search index the daemon serves searches from; see the module doc. Start it with
/// [`LiveIndex::start`], which returns while the index still opens.
pub struct LiveIndex {
    shared: Arc<LiveIndexShared>,
    // The task that opens, serves and closes the index, settling with the close's answer.
    finished: Shared<BoxFuture<'static, Result<(), Arc<LiveIndexCloseError>>>>,
}

impl LiveIndex {
    /// Starts opening the index in `options.index_folder` on a task of its own and returns at
    /// once; commits of the writer from now on are applied once the index is open.
    pub fn start(options: LiveIndexOptions) -> Self {
        // Followed before the open, so a commit during it is applied once the index is open.
        let commits = options.writer.follow_commits();
        let shared =
            LiveIndexShared::new(Arc::clone(&options.reads), Arc::clone(&options.scheduler));
        let finished = tokio::spawn(run(Arc::clone(&shared), options, commits))
            .map(|joined| {
                joined.unwrap_or_else(|failure| {
                    Err(Arc::new(CleanupFailures::new(
                        LiveIndexError::Task(failure),
                        Vec::new(),
                        "closing the search index",
                    )))
                })
            })
            .boxed()
            .shared();
        Self { shared, finished }
    }

    /// Settles once the index has opened, the open has failed, or a close came first; the
    /// provider start waits on it.
    pub async fn when_open_settled(&self) {
        let mut state = self.shared.state.subscribe();
        state
            .wait_for(|state| !matches!(state, LiveIndexState::Opening))
            .await
            .expect("the live index holds the state's sender");
    }

    /// Settles with why the open, a rebuild or the open's catch-up failed, once one has; never
    /// settles otherwise. Every search waiting and every later one fails with the same failure.
    pub async fn when_failed(&self) -> Arc<LiveIndexError> {
        let mut state = self.shared.state.subscribe();
        let failed = state
            .wait_for(|state| matches!(state, LiveIndexState::Failed(_)))
            .await
            .expect("the live index holds the state's sender");
        let LiveIndexState::Failed(failure) = &*failed else {
            unreachable!("the wait ends only on a failure");
        };
        Arc::clone(failure)
    }

    /// One page of a `session.search`, once the index is open; a session
    /// `read_damaged_from_sequence` names a damaged point for shows no log hit at or past it.
    /// Fails as the search does, or with the live index's failure or close.
    pub async fn search_sessions(
        &self,
        request: SessionSearchRequest,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    ) -> Result<SessionSearchResponse, LiveIndexSearchError<SessionSearchError>> {
        let shared = Arc::clone(&self.shared);
        let answer = self
            .search(move |connection, index, applied_floor_position| {
                shared.session_search.search(
                    connection,
                    index,
                    &request,
                    &*read_damaged_from_sequence,
                    applied_floor_position,
                    SystemTime::now(),
                )
            })
            .await;
        arm_held_search_expiry(&self.shared);
        answer
    }

    /// One page of a `transcript.search`, once the index is open; a session whose history is
    /// damaged from `damaged_from_sequence` on is searched before that point. Fails as the search
    /// does, or with the live index's failure or close.
    pub async fn search_transcript(
        &self,
        request: TranscriptSearchRequest,
        damaged_from_sequence: Option<i64>,
    ) -> Result<TranscriptSearchResponse, LiveIndexSearchError<TranscriptSearchError>> {
        self.search(move |connection, index, applied_floor_position| {
            search_transcript(
                connection,
                index,
                &request,
                damaged_from_sequence,
                applied_floor_position,
            )
        })
        .await
    }

    /// Takes no new search, lets the searches taken, the apply and the merge under way finish,
    /// then closes the index and waits for the outbox deletes; a close while the index opens ends
    /// a build under way and settles once the build's process has exited. Repeated calls share the
    /// first close. Fails with what a step of the close failed with, or with a failure that came
    /// after the close began.
    pub async fn close(&self) -> Result<(), Arc<LiveIndexCloseError>> {
        self.shared.state.send_if_modified(|state| {
            let is_serving = matches!(state, LiveIndexState::Opening | LiveIndexState::Open(_));
            if is_serving {
                *state = LiveIndexState::Closed;
            }
            is_serving
        });
        self.shared.stop.cancel();
        self.finished.clone().await
    }

    // Runs `search` on a read connection once the index is open, holding the close off until it
    // has answered.
    async fn search<Search, Output, Failure>(
        &self,
        search: Search,
    ) -> Result<Output, LiveIndexSearchError<Failure>>
    where
        Search: FnOnce(&Connection, &SearchIndex, i64) -> Result<Output, Failure> + Send + 'static,
        Output: Send + 'static,
        Failure: Send + 'static,
    {
        let (open, taken) = self.take_search().await?;
        let shared = Arc::clone(&self.shared);
        let answer = self
            .shared
            .reads
            .read(ReadLength::Long, move |connection| {
                let _taken = taken;
                // Entered once the read place is taken, so the floor is the newest before the
                // search's view; left once the search has answered, after a first page held its
                // search.
                let in_flight = shared.enter_search(&open);
                let floor_position = in_flight.position();
                let answer = search(connection, &open.index, floor_position);
                drop(in_flight);
                Ok::<_, DatabaseReadError>(answer)
            })
            .await?;
        answer.map_err(LiveIndexSearchError::Search)
    }

    // The open index and a hold on the close, once the open has settled.
    async fn take_search<Failure>(
        &self,
    ) -> Result<(OpenIndex, OwnedRwLockReadGuard<()>), LiveIndexSearchError<Failure>> {
        let mut state = self.shared.state.subscribe();
        let settled = state
            .wait_for(|state| !matches!(state, LiveIndexState::Opening))
            .await
            .expect("the live index holds the state's sender");
        match &*settled {
            LiveIndexState::Open(open) => {
                // The close takes the lock only once the state has left `Open`, which cannot
                // happen while this reads it.
                let taken = Arc::clone(&self.shared.searches)
                    .try_read_owned()
                    .expect("no close waits for the searches while the index is open");
                Ok((open.clone(), taken))
            }
            LiveIndexState::Failed(failure) => {
                Err(LiveIndexSearchError::Failed(Arc::clone(failure)))
            }
            LiveIndexState::Closed => Err(LiveIndexSearchError::Closed),
            LiveIndexState::Opening => unreachable!("the wait ends only once the open settles"),
        }
    }
}

impl Drop for LiveIndex {
    // A live index dropped without a close still ends its task, which closes the index.
    fn drop(&mut self) {
        self.shared.stop.cancel();
    }
}

impl LiveIndexShared {
    // Shared state for an index still opening, holding no search.
    fn new(reads: Arc<DatabaseReadPool>, scheduler: Arc<Scheduler>) -> Arc<Self> {
        Arc::new(Self {
            state: watch::Sender::new(LiveIndexState::Opening),
            searches: Arc::new(RwLock::new(())),
            reads,
            floors_in_flight: Arc::default(),
            session_search: SessionSearchService::new(),
            scheduler,
            held_search_expiry: Mutex::new(None),
            stop: CancellationToken::new(),
        })
    }

    // Records `failure` as the live index's, failing every search from now on; once a close has
    // begun, the close answers it instead.
    fn fail(&self, failure: LiveIndexError) -> Result<(), LiveIndexError> {
        let mut failure = Some(failure);
        self.state.send_if_modified(|state| {
            if matches!(state, LiveIndexState::Closed) {
                return false;
            }
            *state = LiveIndexState::Failed(Arc::new(
                failure
                    .take()
                    .expect("the state is changed at most once here"),
            ));
            true
        });
        failure.map_or(Ok(()), Err)
    }

    // A search on its read connection, at the floor the index last matched the database at; it
    // counts in the kept floor until it has answered.
    fn enter_search(&self, open: &OpenIndex) -> FloorPositionInFlight {
        self.floors_in_flight
            .enter(|| open.applier.floor_position())
    }

    // The kept floor: the lowest floor log entry the applier's caught-up read, a search being read
    // or a held search still reads. The searches being read are read before the held ones, since a
    // first page holds its search before it leaves them.
    fn kept_floor_position(&self, applier: &SearchIndexApplier) -> i64 {
        let in_flight = self.floors_in_flight.oldest().unwrap_or(i64::MAX);
        let held = self
            .session_search
            .oldest_held_floor_position()
            .unwrap_or(i64::MAX);
        cmp::min(applier.floor_position(), cmp::min(in_flight, held))
    }

    // Lets go of every held search and of the job that would expire them.
    fn let_go_of_held_searches(&self) {
        self.session_search.let_go_of_held_searches();
        let expiry = lock(&self.held_search_expiry).take();
        if let Some(expiry) = expiry {
            expiry.job.cancel();
        }
    }
}

// Schedules the let-go of held searches at the first one's expiry, in place of the instant
// scheduled before; nothing is scheduled while none is held.
fn arm_held_search_expiry(shared: &Arc<LiveIndexShared>) {
    let mut armed = lock(&shared.held_search_expiry);
    // Read under the lock, so a close letting go in between cannot leave a job scheduled after it.
    let next_expiry = shared.session_search.next_held_search_expiry();
    if armed.as_ref().map(|expiry| expiry.instant) == next_expiry {
        return;
    }
    if let Some(previous) = armed.take() {
        previous.job.cancel();
    }
    let Some(instant) = next_expiry else {
        return;
    };
    let expiring = Arc::downgrade(shared);
    let scheduled = shared.scheduler.schedule_at(
        HELD_SEARCH_EXPIRY_JOB,
        JobCondition::Always,
        instant,
        move |_| {
            let_go_of_expired_searches(&expiring);
            async { Ok(()) }.boxed()
        },
    );
    match scheduled {
        Ok(job) => *armed = Some(HeldSearchExpiry { instant, job }),
        // The searches stay held until a later search arms the expiry or the bound on held
        // searches lets them go.
        Err(failure) => tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            "search_held_expiry_not_scheduled"
        ),
    }
}

// The expiry job's run: lets go of what has expired and arms the next expiry.
fn let_go_of_expired_searches(expiring: &Weak<LiveIndexShared>) {
    if let Some(shared) = expiring.upgrade() {
        shared
            .session_search
            .let_go_of_expired_searches(SystemTime::now());
        arm_held_search_expiry(&shared);
    }
}

// The live index's task: opens the index, serves it until the close or a failure, then closes it
// and waits for the outbox deletes; settles with the close's answer.
async fn run(
    shared: Arc<LiveIndexShared>,
    options: LiveIndexOptions,
    mut commits: watch::Receiver<u64>,
) -> Result<(), Arc<LiveIndexCloseError>> {
    let (deletes, applied) = watch::channel(None);
    let deleting = tokio::spawn(delete_applied(Arc::clone(&options.writer), applied));
    let mut failures = serve(&shared, &options, &mut commits, &deletes).await;
    // The deletes end with the newest commit heard once nothing sends more.
    drop(deletes);
    if let Err(failure) = deleting.await {
        failures.push(LiveIndexError::Task(failure));
    }
    let mut failures = failures.into_iter();
    match failures.next() {
        None => Ok(()),
        Some(first) => Err(Arc::new(CleanupFailures::new(
            first,
            failures.collect(),
            "closing the search index",
        ))),
    }
}

// Opens and serves the index, then closes it; answers what the close should fail with.
async fn serve(
    shared: &LiveIndexShared,
    options: &LiveIndexOptions,
    commits: &mut watch::Receiver<u64>,
    deletes: &watch::Sender<Option<AppliedOutbox>>,
) -> Vec<LiveIndexError> {
    let (index, rebuild_reason) = match open_or_build(shared, options).await {
        Ok(Some(opened)) => opened,
        Ok(None) => return Vec::new(),
        Err(failure) => return shared.fail(failure).err().into_iter().collect(),
    };
    let index: Arc<SearchIndex> = Arc::from(index);
    let open = OpenIndex {
        applier: Arc::new(SearchIndexApplier::new(
            Arc::clone(&index),
            Arc::clone(&shared.reads),
        )),
        index,
    };
    let index_commits = Arc::new(Notify::new());
    let mut merging = None;
    let mut failures = Vec::new();
    if !shared.stop.is_cancelled() {
        match catch_up(shared, &open, deletes, &index_commits).await {
            Ok(()) => {
                let is_open = shared.state.send_if_modified(|state| {
                    let is_opening = matches!(state, LiveIndexState::Opening);
                    if is_opening {
                        *state = LiveIndexState::Open(open.clone());
                    }
                    is_opening
                });
                if is_open {
                    if let Some(reason) = rebuild_reason {
                        tracing::info!(
                            reason = <&'static str>::from(reason),
                            "search_index_rebuilt"
                        );
                    }
                    merging = Some(SearchIndexMerging::start(
                        Arc::clone(&open.index),
                        Arc::clone(&index_commits),
                    ));
                    follow_commits(shared, &open, commits, deletes, &index_commits).await;
                }
            }
            Err(failure) => {
                if let Err(failure) = shared.fail(failure) {
                    failures.push(failure);
                }
            }
        }
    }
    if let Some(merging) = merging
        && let Err(failure) = merging.stop().await
    {
        failures.push(LiveIndexError::Task(failure));
    }
    // The searches taken finish first, so none holds its search after the let-go.
    let _searches = shared.searches.write().await;
    shared.let_go_of_held_searches();
    let closing = Arc::clone(&open.index);
    match tokio::task::spawn_blocking(move || closing.close()).await {
        Ok(Ok(())) => {}
        Ok(Err(failure)) => failures.push(LiveIndexError::Close(failure)),
        Err(failure) => failures.push(LiveIndexError::Task(failure)),
    }
    failures
}

// The index in its folder, built again in a child process first when it cannot serve, with why it
// was built again; `None` once a close ended a build under way.
async fn open_or_build(
    shared: &LiveIndexShared,
    options: &LiveIndexOptions,
) -> Result<Option<(Box<SearchIndex>, Option<SearchIndexRebuildReason>)>, LiveIndexError> {
    let highest_id_given = shared
        .reads
        .read(ReadLength::Short, |connection| {
            Ok::<_, LiveIndexError>(OutboxReader::new(connection).highest_id_given()?)
        })
        .await?;
    let reason = match open_search_index(options.index_folder.clone(), highest_id_given).await? {
        SearchIndexOpening::Opened(index) => return Ok(Some((index, None))),
        SearchIndexOpening::RebuildNeeded(reason) => reason,
    };
    let request = SearchIndexBuildRequest {
        database_path: options.database_path.clone(),
        index_folder: options.index_folder.clone(),
        last_outbox_id: highest_id_given,
    };
    match build_search_index_in_child(&options.spawner, &options.program, &request, &shared.stop)
        .await
    {
        Ok(()) => {}
        Err(SearchIndexChildError::Canceled) => return Ok(None),
        Err(failure) => return Err(failure.into()),
    }
    match open_search_index(options.index_folder.clone(), highest_id_given).await? {
        SearchIndexOpening::Opened(index) => Ok(Some((index, Some(reason)))),
        SearchIndexOpening::RebuildNeeded(again) => Err(LiveIndexError::StillUnservable(again)),
    }
}

// Brings the index in step with the database before its first search: the outbox rows its newest
// commit already holds are reported for deletion, every row past them is applied, then every
// group's members are loaded.
async fn catch_up(
    shared: &LiveIndexShared,
    open: &OpenIndex,
    deletes: &watch::Sender<Option<AppliedOutbox>>,
    index_commits: &Notify,
) -> Result<(), LiveIndexError> {
    let last_applied_outbox_id = open.index.last_applied_outbox_id();
    if last_applied_outbox_id > 0 {
        deletes.send_replace(Some(AppliedOutbox {
            last_outbox_id: last_applied_outbox_id,
            kept_floor_position: 0,
        }));
    }
    apply_waiting(shared, open, deletes, index_commits).await?;
    let groups = shared
        .reads
        .read(ReadLength::Long, |connection| {
            Ok::<_, LiveIndexError>(OutboxReader::new(connection).read_every_group_members()?)
        })
        .await?;
    let index = Arc::clone(&open.index);
    tokio::task::spawn_blocking(move || index.set_group_members(&groups))
        .await?
        .map_err(LiveIndexError::GroupMembers)
}

// Applies what the outbox holds after each commit of the writer, until the close. A failed apply
// leaves the index at its last durable commit, which searches go on reading; it is logged once and
// tried again only once its wait runs out, the wait doubling while it fails, so a commit meanwhile
// starts no apply and a lasting failure costs one apply a wait. An apply under way when the close
// comes finishes first.
async fn follow_commits(
    shared: &LiveIndexShared,
    open: &OpenIndex,
    commits: &mut watch::Receiver<u64>,
    deletes: &watch::Sender<Option<AppliedOutbox>>,
    index_commits: &Notify,
) {
    // While an apply's failure stands: the wait it was given, and when it runs out.
    let mut retry: Option<(Duration, Instant)> = None;
    loop {
        let retry_at = retry.map(|(_, at)| at);
        tokio::select! {
            biased;
            () = shared.stop.cancelled() => return,
            changed = commits.changed() => {
                if changed.is_err() {
                    // The writer is gone, so no write commits again before the close.
                    shared.stop.cancelled().await;
                    return;
                }
                // While a failure stands, the commit's rows wait for the retry, which applies
                // everything waiting.
                if retry_at.is_some_and(|at| Instant::now() < at) {
                    continue;
                }
            }
            () = tokio::time::sleep_until(retry_at.unwrap_or_else(Instant::now)),
                if retry_at.is_some() => {}
        }
        match apply_waiting(shared, open, deletes, index_commits).await {
            Ok(()) => {
                if retry.take().is_some() {
                    tracing::info!("search_index_apply_recovered");
                }
            }
            Err(failure) => {
                let wait = match retry {
                    None => {
                        tracing::warn!(
                            error = &failure as &(dyn Error + 'static),
                            "search_index_apply_failed"
                        );
                        APPLY_RETRY_FIRST_WAIT
                    }
                    Some((wait, _)) => cmp::min(wait * 2, APPLY_RETRY_LONGEST_WAIT),
                };
                retry = Some((wait, Instant::now() + wait));
            }
        }
    }
}

// Applies every outbox row waiting; each durable commit has its rows deleted and wakes the merging.
async fn apply_waiting(
    shared: &LiveIndexShared,
    open: &OpenIndex,
    deletes: &watch::Sender<Option<AppliedOutbox>>,
    index_commits: &Notify,
) -> Result<(), SearchIndexApplyError> {
    open.applier
        .apply_waiting(|last_outbox_id| {
            deletes.send_replace(Some(AppliedOutbox {
                last_outbox_id,
                kept_floor_position: shared.kept_floor_position(&open.applier),
            }));
            index_commits.notify_one();
        })
        .await
}

// Deletes applied outbox rows one write after another, each for the newest commit heard by then,
// until the live index stops sending. A failed delete is logged; its rows go with the next one.
async fn delete_applied(
    writer: Arc<DatabaseWriter>,
    mut applied: watch::Receiver<Option<AppliedOutbox>>,
) {
    while applied.changed().await.is_ok() {
        let Some(newest) = *applied.borrow_and_update() else {
            continue;
        };
        if let Err(failure) = delete_applied_outbox(&writer, newest).await {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "search_outbox_delete_failed"
            );
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_services;
#[cfg(test)]
mod tests;
