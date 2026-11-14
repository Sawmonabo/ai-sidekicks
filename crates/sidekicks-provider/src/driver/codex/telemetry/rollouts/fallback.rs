//! Each Codex launch's rollout fallback: for each stop its export status counts, the rollout files
//! in its service's home are read for the requests no export carried, stamped after the newest
//! record the launch's last export carried before that stop: one pass as the stop is found, one at
//! each request turn the launch settles and one at each export read, each file resumed from the
//! offset its last read stopped at and opened only once it grew. A file of a thread a session
//! streams is read too; any other is read once the walk from the thread it came from reaches a
//! thread a session holds. Each record is handed to its session as it is read, with its sighting,
//! which the usage record passes over where the stream or the export priced the request first. The
//! first export after a stop ends it, under the export status's lock; each file is then read on at
//! each export until the turn it showed live at that export's newest record has ended, and let go,
//! its offset kept, so no later stop reads it from its start. A stop an export ended before the
//! fallback looked is read the same way.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, watch};

use crate::bounded_queue::remember;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::drain::push_exported_response;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement, CodexRolloutFacts,
};
use crate::driver::codex::telemetry::rollouts::file::{
    CodexRolloutFile, CodexRolloutRequest, CodexRolloutThread, CodexRolloutTier,
};
use crate::driver::codex::thread::ancestry::{
    CodexListedThread, CodexThreadPlacement, CodexUnplacedThread, list_recent_helper_threads,
    place_codex_thread,
};
use crate::pricing::export_status::{ExportStatusTracker, PublishedExportStatus};
use crate::pricing::usage_files::read_usage_file_lines;

/// The folder of a Codex home its rollout files are written under, by day.
const SESSIONS_FOLDER: &str = "sessions";

/// How many rollout files one launch's fallback follows, and how many it keeps the offset of once
/// let go; past the first a new file is passed over, logged, and past the second the oldest let go
/// is forgotten, so a later stop reads it from its start, its records passed over by the usage
/// record.
const ROLLOUTS_KEPT: usize = 256;

/// How many walks a file's thread gets while the listing lacks it before it is given up.
const WALKS_KEPT: u8 = 3;

/// The handles a launch's fallback reads and publishes through: the launch's export status, which
/// counts its stops and takes the rollout files it cannot read, its exports' stamps and the stops
/// they ended, and the wake each export read gives.
#[derive(Clone)]
pub(crate) struct CodexLaunchRollouts {
    tracker: Weak<ExportStatusTracker>,
    status: watch::Receiver<PublishedExportStatus>,
    times: Arc<Mutex<CodexExportTimes>>,
    exported_read: Arc<Notify>,
}

impl CodexLaunchRollouts {
    /// The handles of a launch registered at `registered_at_ms`, in Unix milliseconds, whose
    /// export status `tracker` keeps.
    pub(crate) fn new(tracker: &Arc<ExportStatusTracker>, registered_at_ms: u64) -> Self {
        Self {
            tracker: Arc::downgrade(tracker),
            status: tracker.status(),
            times: Arc::new(Mutex::new(CodexExportTimes {
                registered_at_ms,
                newest_export_stamp_ms: None,
                exports_read: 0,
                last_ended_stop: 0,
                ended_stops: VecDeque::new(),
            })),
            exported_read: Arc::new(Notify::new()),
        }
    }

    /// An export of the launch was read after `stops` stops of its status, its newest record
    /// stamped at `newest_record_ms` (`None` where none is stamped) and arriving at
    /// `arrived_at_ms`, in Unix milliseconds. The first export after a stop ends that stop at its
    /// newest record, since a response logged after it goes in a later export, or just before its
    /// arrival where no record is stamped. Runs under the export status's lock, so no stop comes
    /// between it and the turn.
    pub(crate) fn export_read(
        &self,
        stops: u64,
        newest_record_ms: Option<u64>,
        arrived_at_ms: u64,
    ) {
        let mut times = lock(&self.times);
        if stops > times.last_ended_stop {
            let since_ms = times.since_ms();
            times.ended_stops.push_back(CodexEndedStop {
                stop: stops,
                since_ms,
                newest_record_ms: newest_record_ms.unwrap_or(arrived_at_ms.saturating_sub(1)),
            });
            times.last_ended_stop = stops;
        }
        times.newest_export_stamp_ms = times.newest_export_stamp_ms.max(newest_record_ms);
        times.exports_read += 1;
        drop(times);
        self.exported_read.notify_one();
    }
}

// The stamps of a launch's exports and how many were read, and the stops they ended with where
// each stop's reading starts.
struct CodexExportTimes {
    registered_at_ms: u64,
    newest_export_stamp_ms: Option<u64>,
    exports_read: u64,
    // The last stop an export ended.
    last_ended_stop: u64,
    // The stops an export ended that the fallback has not let go, oldest first.
    ended_stops: VecDeque<CodexEndedStop>,
}

// A stop an export ended: where its reading starts, and the newest record of that export, the
// last stamp a response it lost can have been logged at.
struct CodexEndedStop {
    stop: u64,
    since_ms: u64,
    newest_record_ms: u64,
}

impl CodexExportTimes {
    // Where a stop that begins now starts pricing: just past the newest record exported, since a
    // record stamped as it was in its export, else at the launch's registration.
    fn since_ms(&self) -> u64 {
        self.newest_export_stamp_ms
            .map_or(self.registered_at_ms, |newest_ms| newest_ms + 1)
    }

    // The stop `stop` an export ended, if one has.
    fn ended(&self, stop: u64) -> Option<&CodexEndedStop> {
        self.ended_stops.iter().find(|ended| ended.stop == stop)
    }
}

// Where a followed file's requests are filed.
enum CodexRolloutPlacement {
    // Its thread is not yet known, or the walk has not reached a held thread yet; `walks` counts
    // the walks the listing lacked it for.
    Unplaced {
        walks: u8,
    },
    // A thread `session_id` streams, each record checked against the stream's own.
    Streamed {
        session_id: SessionId,
    },
    // Below `session_thread`, which `session_id` holds, filed as `child_thread`.
    Below {
        session_id: SessionId,
        session_thread: String,
        child_thread: String,
    },
    // A thread reaching no held thread: never read for price.
    Passed,
}

// One followed rollout file: what its lines told, where its next read starts, its size when last
// seen, where its requests go, and whether its last read failed.
struct CodexFollowedRollout {
    file: CodexRolloutFile,
    offset: u64,
    size: u64,
    placement: CodexRolloutPlacement,
    is_read_failed: bool,
}

impl CodexFollowedRollout {
    // Whether the file is still to be read past a stop's end at `ended_ms`: its thread known and
    // not yet placed, its walks not used up, or a turn it showed live then not yet ended, whose
    // records Codex writes before its end; a turn the file never ends is let go at the next turn
    // the file shows begun, or with the launch.
    fn is_followed_past(&self, ended_ms: u64) -> bool {
        match &self.placement {
            CodexRolloutPlacement::Unplaced { .. } => self.file.thread().is_some(),
            CodexRolloutPlacement::Streamed { .. } | CodexRolloutPlacement::Below { .. } => {
                self.file.has_turn_live_from(ended_ms)
            }
            CodexRolloutPlacement::Passed => false,
        }
    }
}

// Where a file's requests are filed: the session, and the placement off its stream, `None` on the
// thread the session streams.
struct CodexRolloutTarget {
    session_id: SessionId,
    placed: Option<CodexOffStreamPlacement>,
}

// What the fallback reads: from `since_ms` on, begun at a stop and kept until the newest stop it
// began, `stop`, has ended and each file it follows is let go; `is_scanned` says a pass has looked
// for its files.
struct CodexReading {
    stop: u64,
    since_ms: u64,
    is_scanned: bool,
}

/// Why a launch's fallback woke.
pub(crate) enum CodexFallbackDue {
    /// A pass is due, [`CodexRolloutFallback::next_pass`] saying which.
    Pass,
    /// The launch's export status is gone, after its last export was read.
    LaunchEnded,
}

/// One launch's rollout fallback, run by the launch's own work task, which owns it: what it reads,
/// begun at each stop the export status counts, the files it follows meanwhile, and the files it
/// let go, oldest first, each kept as its last read left it.
pub(crate) struct CodexRolloutFallback {
    rollouts: CodexLaunchRollouts,
    last_begun_stop: u64,
    // The exports read as the last pass began.
    exports_seen: u64,
    reading: Option<CodexReading>,
    files: HashMap<PathBuf, CodexFollowedRollout>,
    let_go: VecDeque<(PathBuf, CodexFollowedRollout)>,
}

impl CodexRolloutFallback {
    /// A fallback over `rollouts`, which begins at the first stop [`Self::next_pass`] finds.
    pub(crate) fn new(rollouts: CodexLaunchRollouts) -> Self {
        Self {
            rollouts,
            last_begun_stop: 0,
            exports_seen: 0,
            reading: None,
            files: HashMap::new(),
            let_go: VecDeque::new(),
        }
    }

    /// Whether the fallback reads.
    pub(crate) fn is_reading(&self) -> bool {
        self.reading.is_some()
    }

    /// Waits until a pass is due or the launch has ended. The files the status names never wake
    /// it.
    pub(crate) async fn wait_until_due(&mut self) -> CodexFallbackDue {
        loop {
            if self.is_pass_due() {
                return CodexFallbackDue::Pass;
            }
            let exported_read = Arc::clone(&self.rollouts.exported_read);
            tokio::select! {
                changed = self.rollouts.status.changed() => {
                    if changed.is_err() {
                        return CodexFallbackDue::LaunchEnded;
                    }
                }
                () = exported_read.notified() => {}
            }
        }
    }

    // Whether a stop the fallback has not begun is counted, or an export was read since the last
    // pass while it reads.
    fn is_pass_due(&mut self) -> bool {
        let stops = self.rollouts.status.borrow_and_update().stops;
        let is_exported_since =
            self.reading.is_some() && lock(&self.rollouts.times).exports_read > self.exports_seen;
        stops > self.last_begun_stop || is_exported_since
    }

    /// Moves on to the next pass due, answering whether one is: the stops counted since the last
    /// one begun, read from the first one's start, which an export that ended it already set, and
    /// a reading still alive from an earlier stop begins there too; else a read at the exports
    /// read since the last pass. Each stop's start is read under the stamps' lock, so an export
    /// ending it however soon bounds it.
    pub(crate) fn next_pass(&mut self) -> bool {
        let stops = self.rollouts.status.borrow().stops;
        let times = lock(&self.rollouts.times);
        if stops > self.last_begun_stop {
            let first = self.last_begun_stop + 1;
            let since_ms = times
                .ended(first)
                .map_or_else(|| times.since_ms(), |ended| ended.since_ms);
            self.last_begun_stop = stops;
            self.exports_seen = times.exports_read;
            match &mut self.reading {
                Some(reading) => {
                    reading.stop = stops;
                    reading.since_ms = since_ms;
                    reading.is_scanned = false;
                }
                None => {
                    self.reading = Some(CodexReading {
                        stop: stops,
                        since_ms,
                        is_scanned: false,
                    });
                }
            }
            return true;
        }
        if self.reading.is_some() && times.exports_read > self.exports_seen {
            self.exports_seen = times.exports_read;
            return true;
        }
        false
    }

    // Stops reading once every file it followed was let go: the stops ended up to the one read go.
    fn stop_reading(&mut self) {
        let Some(reading) = self.reading.take() else {
            return;
        };
        lock(&self.rollouts.times)
            .ended_stops
            .retain(|ended| ended.stop > reading.stop);
    }

    /// One pass over `service`'s rollout files. Until the stop read has ended, and once as it is
    /// begun: new ones in its home found, a file let go taken up again from where it was left,
    /// and a recent helper's in the day folder of its thread's making where the scan missed it;
    /// past its end, only the files followed are looked at. Each followed file that grew is read
    /// on from its offset once its thread is placed, each request it states handed to its session,
    /// the files whose turn live at the stop's end has ended let go, and the files it cannot read
    /// published.
    pub(crate) async fn pass(&mut self, service: &Arc<CodexService>) {
        let Some(reading) = &self.reading else {
            return;
        };
        let (stop, since_ms, is_scanned) = (reading.stop, reading.since_ms, reading.is_scanned);
        let ended_ms = lock(&self.rollouts.times)
            .ended(stop)
            .map(|ended| ended.newest_record_ms);
        let found = if ended_ms.is_none() || !is_scanned {
            let sessions = service.home().codex_home.join(SESSIONS_FOLDER);
            let helpers = self.list_unfollowed_helpers(service, since_ms).await;
            tokio::task::spawn_blocking(move || {
                let mut found = find_rollouts(&sessions, since_ms);
                for helper in helpers {
                    found.extend(find_helper_rollout(&sessions, &helper));
                }
                found
            })
            .await
        } else {
            let followed: Vec<PathBuf> = self.files.keys().cloned().collect();
            tokio::task::spawn_blocking(move || {
                followed
                    .into_iter()
                    .filter_map(|path| {
                        let size = std::fs::metadata(&path).ok()?.len();
                        Some((path, size))
                    })
                    .collect::<Vec<_>>()
            })
            .await
        };
        let found = found.unwrap_or_else(|error| {
            tracing::warn!(%error, "a codex launch's rollout files could not be listed");
            Vec::new()
        });
        if let Some(reading) = &mut self.reading {
            reading.is_scanned = true;
        }
        for (path, size) in found {
            if let Some(followed) = self.files.get_mut(&path) {
                followed.size = size;
                continue;
            }
            if self.files.len() >= ROLLOUTS_KEPT {
                tracing::warn!(
                    path = %path.display(),
                    "a codex launch follows too many rollout files; this one is passed over"
                );
                continue;
            }
            let followed = match self.let_go.iter().position(|(kept, _)| *kept == path) {
                Some(index) => {
                    let (_path, mut followed) = self
                        .let_go
                        .remove(index)
                        .expect("the position is in the queue");
                    followed.size = size;
                    // A thread passed over before is walked again for this stop.
                    if matches!(followed.placement, CodexRolloutPlacement::Passed) {
                        followed.placement = CodexRolloutPlacement::Unplaced { walks: 0 };
                    }
                    followed
                }
                None => CodexFollowedRollout {
                    file: CodexRolloutFile::default(),
                    offset: 0,
                    size,
                    placement: CodexRolloutPlacement::Unplaced { walks: 0 },
                    is_read_failed: false,
                },
            };
            self.files.insert(path, followed);
        }
        for (path, followed) in &mut self.files {
            follow(service, path, followed, since_ms).await;
        }
        if let Some(ended_ms) = ended_ms {
            let ended: Vec<_> = self
                .files
                .extract_if(|_path, followed| !followed.is_followed_past(ended_ms))
                .collect();
            for (path, followed) in ended {
                if let Some((forgotten, _followed)) =
                    remember(&mut self.let_go, (path, followed), ROLLOUTS_KEPT)
                {
                    tracing::debug!(
                        path = %forgotten.display(),
                        "a codex launch keeps too many rollout files let go; \
                         the oldest is forgotten"
                    );
                }
            }
            if self.files.is_empty() {
                self.stop_reading();
            }
        }
        self.publish_unreadable();
    }

    // The helper threads `service` updated from `since_ms` on whose rollout file the fallback does
    // not follow; none where the listing fails, which is logged.
    async fn list_unfollowed_helpers(
        &self,
        service: &CodexService,
        since_ms: u64,
    ) -> Vec<CodexListedThread> {
        let listed = match service.connection() {
            Ok(connection) => list_recent_helper_threads(&connection).await,
            Err(error) => Err(error),
        };
        let listed = listed.unwrap_or_else(|error| {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a codex launch's helper threads could not be listed for their rollout files"
            );
            Vec::new()
        });
        listed
            .into_iter()
            .filter(|thread| {
                let since_s = i64::try_from(since_ms / 1_000).unwrap_or(i64::MAX);
                thread.updated_at >= since_s
                    && !self
                        .files
                        .keys()
                        .any(|path| is_rollout_of(path, &thread.id))
            })
            .collect()
    }

    // Publishes the files the fallback cannot read: one whose read failed, or whose settled turn
    // left no record.
    fn publish_unreadable(&self) {
        let Some(tracker) = self.rollouts.tracker.upgrade() else {
            return;
        };
        let mut names: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(_path, followed)| followed.is_read_failed || followed.file.is_unreadable())
            .map(|(path, _followed)| path.clone())
            .collect();
        names.sort();
        tracker.publish_unreadable_files(names);
    }
}

// Reads `followed` on where it grew past its offset: up to its first `session_meta` while its
// thread is unknown, then, once its thread is placed, to its end, each request stamped from
// `since_ms` on handed to the session its placement names as it is read.
async fn follow(
    service: &Arc<CodexService>,
    path: &Path,
    followed: &mut CodexFollowedRollout,
    since_ms: u64,
) {
    loop {
        let held_thread = match &followed.placement {
            CodexRolloutPlacement::Below { session_thread, .. } => Some(session_thread.as_str()),
            CodexRolloutPlacement::Streamed { .. } => followed
                .file
                .thread()
                .map(|thread| thread.thread_id.as_str()),
            CodexRolloutPlacement::Unplaced { .. } | CodexRolloutPlacement::Passed => None,
        };
        if held_thread.is_some_and(|thread| service.session_of_thread(thread).is_none()) {
            followed.placement = CodexRolloutPlacement::Unplaced { walks: 0 };
        }
        let unplaced = match (&followed.placement, followed.file.thread()) {
            (CodexRolloutPlacement::Passed, _) => return,
            (CodexRolloutPlacement::Unplaced { walks }, Some(thread)) => {
                Some((*walks, thread.clone()))
            }
            (
                CodexRolloutPlacement::Unplaced { .. }
                | CodexRolloutPlacement::Below { .. }
                | CodexRolloutPlacement::Streamed { .. },
                _,
            ) => None,
        };
        if let Some((walks, thread)) = unplaced {
            followed.placement = place(service, &thread, walks).await;
            if matches!(followed.placement, CodexRolloutPlacement::Unplaced { .. }) {
                return;
            }
            continue;
        }
        if followed.size <= followed.offset {
            return;
        }
        let is_thread_unknown = followed.file.thread().is_none();
        let file = std::mem::take(&mut followed.file);
        let read_path = path.to_owned();
        let offset = followed.offset;
        let target = match &followed.placement {
            CodexRolloutPlacement::Below {
                session_id,
                session_thread,
                child_thread,
            } => Some(CodexRolloutTarget {
                session_id: *session_id,
                placed: Some(CodexOffStreamPlacement::BelowThread {
                    session_thread: session_thread.clone(),
                    child_thread: child_thread.clone(),
                }),
            }),
            CodexRolloutPlacement::Streamed { session_id } => Some(CodexRolloutTarget {
                session_id: *session_id,
                placed: None,
            }),
            CodexRolloutPlacement::Unplaced { .. } | CodexRolloutPlacement::Passed => None,
        };
        let read_service = Arc::clone(service);
        let read = tokio::task::spawn_blocking(move || {
            read_on(
                &read_path,
                offset,
                file,
                since_ms,
                target.as_ref().map(|target| (target, &*read_service)),
            )
        })
        .await;
        let (file, read) = match read {
            Ok(read) => read,
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "a codex rollout read did not end");
                followed.is_read_failed = true;
                return;
            }
        };
        followed.file = file;
        match read {
            Ok(offset) => {
                followed.offset = offset;
                followed.is_read_failed = false;
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    path = %path.display(),
                    "a codex rollout file could not be read"
                );
                followed.is_read_failed = true;
                return;
            }
        }
        // A read that stopped at the file's first line places its thread next.
        if !(is_thread_unknown && followed.file.thread().is_some()) {
            return;
        }
    }
}

// Reads `path` on from `offset` into `file`, stopping just past the line that names its thread
// where it is not known yet; each request read is handed, as its line is read, to `target`'s
// session on its service, so a read cut short leaves only unread lines behind. Answers the file,
// and the offset the next read starts at or the failure. Blocking.
fn read_on(
    path: &Path,
    offset: u64,
    mut file: CodexRolloutFile,
    since_ms: u64,
    target: Option<(&CodexRolloutTarget, &CodexService)>,
) -> (CodexRolloutFile, io::Result<u64>) {
    let is_thread_unknown = file.thread().is_none();
    let read = read_usage_file_lines(path, offset, |line| {
        let request = file.read_line(line, since_ms);
        if let (Some(request), Some((target, service)), Some(thread)) =
            (request, target, file.thread())
        {
            price_rollout_request(service, target, &thread.thread_id, request);
        }
        if is_thread_unknown && file.thread().is_some() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    (file, read)
}

// Hands `request`, of `thread_id`'s file, to `target`'s session on `service`, under the account
// its record's time ran on; one whose model or key does not fit the wire is refused and logged.
fn price_rollout_request(
    service: &CodexService,
    target: &CodexRolloutTarget,
    thread_id: &str,
    request: CodexRolloutRequest,
) {
    let (service_tier, is_root_tier) = match request.tier {
        CodexRolloutTier::Snapshot(tier) => (tier.and_then(BoundedText::new), false),
        CodexRolloutTier::RootThread => (None, true),
    };
    let (Ok(model_id), Some(request_key)) = (
        FreeFormText::new(request.model),
        BoundedText::new(request.response_id),
    ) else {
        tracing::warn!(
            conversation_id = thread_id,
            "a codex rollout record's model or response id does not fit the wire; it is refused"
        );
        return;
    };
    let exported = CodexExportedResponse {
        response: CodexCompletedResponse {
            conversation_id: thread_id.to_owned(),
            model_id,
            service_tier,
            counts: request.counts,
            observed_at_ms: request.at_ms,
            provider_account_id: service.account_at(request.at_ms),
        },
        placed: target.placed.clone(),
        rollout: Some(CodexRolloutFacts {
            request_key,
            is_root_tier,
            filing_run: None,
        }),
    };
    push_exported_response(service, target.session_id, exported);
}

// Where `thread`'s requests go: on the session that streams it, else below the first held thread
// up from the thread it came from, on that thread's session; one with no held thread above it is
// passed. A walk the listing lacks the thread for, or that fails, leaves it unplaced for the next
// pass, past `WALKS_KEPT` walks passed.
async fn place(
    service: &CodexService,
    thread: &CodexRolloutThread,
    walks: u8,
) -> CodexRolloutPlacement {
    if let Some(session_id) = service.session_of_thread(&thread.thread_id) {
        return CodexRolloutPlacement::Streamed { session_id };
    }
    let Some(parent) = &thread.parent_thread_id else {
        return CodexRolloutPlacement::Passed;
    };
    if let Some(session_id) = service.session_of_thread(parent) {
        return CodexRolloutPlacement::Below {
            session_id,
            session_thread: parent.clone(),
            child_thread: thread.thread_id.clone(),
        };
    }
    let walked = match service.connection() {
        Ok(connection) => {
            place_codex_thread(&connection, parent, |thread| {
                service.session_of_thread(thread)
            })
            .await
        }
        Err(error) => Err(error),
    };
    // A walk the listing lacked the thread for, or that failed, is one of its `WALKS_KEPT`.
    let unplaced = if walks < WALKS_KEPT {
        CodexRolloutPlacement::Unplaced { walks: walks + 1 }
    } else {
        CodexRolloutPlacement::Passed
    };
    match walked {
        Ok(CodexThreadPlacement::BelowSession {
            session_id,
            session_thread,
            child_thread,
        }) => CodexRolloutPlacement::Below {
            session_id,
            session_thread,
            child_thread,
        },
        // Taken by a session between the two looks: placed by the next pass.
        Ok(CodexThreadPlacement::Streamed) => CodexRolloutPlacement::Unplaced { walks },
        Ok(CodexThreadPlacement::Unplaced(
            CodexUnplacedThread::NoHeldAncestor | CodexUnplacedThread::Loop,
        )) => CodexRolloutPlacement::Passed,
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed)) => {
            if matches!(unplaced, CodexRolloutPlacement::Passed) {
                tracing::warn!(
                    conversation_id = thread.thread_id.as_str(),
                    "a codex rollout's thread is still not listed; its file is passed over"
                );
            }
            unplaced
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                conversation_id = thread.thread_id.as_str(),
                "a codex rollout's thread could not be walked; it is walked again next pass, \
                 while its walks last"
            );
            unplaced
        }
    }
}

// The rollout files under `sessions` written in day folders from the day before `since_ms`'s,
// in UTC, on, and modified since it, each with its size; a folder that cannot be read is logged
// and passed over. Blocking.
fn find_rollouts(sessions: &Path, since_ms: u64) -> Vec<(PathBuf, u64)> {
    let since = UNIX_EPOCH + Duration::from_millis(since_ms);
    let first_day = i64::try_from(since_ms)
        .ok()
        .and_then(|since_ms| jiff::Timestamp::from_millisecond(since_ms).ok())
        .and_then(|since| {
            since
                .to_zoned(jiff::tz::TimeZone::UTC)
                .date()
                .yesterday()
                .ok()
        });
    let Some(first_day) = first_day else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (year, year_folder) in numbered_folders(sessions) {
        if year < i64::from(first_day.year()) {
            continue;
        }
        for (month, month_folder) in numbered_folders(&year_folder) {
            if year == i64::from(first_day.year()) && month < i64::from(first_day.month()) {
                continue;
            }
            for (day, day_folder) in numbered_folders(&month_folder) {
                let date = i16::try_from(year)
                    .ok()
                    .zip(i8::try_from(month).ok())
                    .zip(i8::try_from(day).ok());
                let Some(((year, month), day)) = date else {
                    continue;
                };
                if jiff::civil::Date::new(year, month, day).is_ok_and(|date| date >= first_day) {
                    found.extend(modified_rollouts(&day_folder, since));
                }
            }
        }
    }
    found
}

// Each folder in `folder` named by a number, with its number.
fn numbered_folders(folder: &Path) -> Vec<(i64, PathBuf)> {
    read_entries(folder)
        .into_iter()
        .filter_map(|(name, path)| name.parse::<i64>().ok().map(|number| (number, path)))
        .collect()
}

// Each `rollout-*.jsonl` file in `folder` modified at or after `since`, with its size.
fn modified_rollouts(folder: &Path, since: SystemTime) -> Vec<(PathBuf, u64)> {
    read_entries(folder)
        .into_iter()
        .filter(|(name, path)| {
            name.starts_with("rollout-")
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        })
        .filter_map(|(_name, path)| {
            let metadata = std::fs::metadata(&path).ok()?;
            let modified = metadata.modified().ok()?;
            (modified >= since).then_some((path, metadata.len()))
        })
        .collect()
}

// Whether `path` is the rollout file of `thread_id`, which Codex names
// `rollout-<time>-<thread id>.jsonl`.
fn is_rollout_of(path: &Path, thread_id: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with("rollout-") && name.ends_with(&format!("-{thread_id}.jsonl"))
        })
}

// The rollout file of `helper` under `sessions`, in the day folder of its thread's making by this
// system's clock, as Codex names it, with its size; `None` where none is there. Blocking.
fn find_helper_rollout(sessions: &Path, helper: &CodexListedThread) -> Option<(PathBuf, u64)> {
    let made_on = jiff::Timestamp::from_second(helper.created_at)
        .ok()?
        .to_zoned(jiff::tz::TimeZone::system())
        .date();
    let folder = sessions
        .join(format!("{:04}", made_on.year()))
        .join(format!("{:02}", made_on.month()))
        .join(format!("{:02}", made_on.day()));
    read_entries(&folder)
        .into_iter()
        .find(|(_name, path)| is_rollout_of(path, &helper.id))
        .and_then(|(_name, path)| {
            let size = std::fs::metadata(&path).ok()?.len();
            Some((path, size))
        })
}

// Each entry of `folder` by its name; a folder that is absent reads empty, and one that cannot be
// read is logged and reads empty.
fn read_entries(folder: &Path) -> Vec<(String, PathBuf)> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if is_missing_entry(&error) => return Vec::new(),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                folder = %folder.display(),
                "a codex rollout folder could not be read"
            );
            return Vec::new();
        }
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            Some((name, entry.path()))
        })
        .collect()
}

#[cfg(test)]
mod tests;
