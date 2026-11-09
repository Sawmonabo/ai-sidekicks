//! Each Codex launch's rollout fallback: while the launch's export status reads stopped, the
//! rollout files in its service's home are read for the requests no export carried, stamped after
//! the newest record the launch's last export carried: one pass as the status turns stopped and
//! one at each request turn the launch settles, each file resumed from the offset its last read
//! stopped at and opened only once it grew. A file of a thread a session streams is read too, each
//! record checked against the stream's own; any other is read once the walk from the thread it
//! came from reaches a thread a session holds. When an export arrives again, nothing stamped from
//! its oldest record on is priced, and the offsets go.

use std::collections::HashMap;
use std::io;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::drain::push_exported_response;
use crate::driver::codex::telemetry::held_responses::{
    CodexExportedResponse, CodexOffStreamPlacement, CodexRolloutFacts,
};
use crate::driver::codex::telemetry::rollouts::file::{
    CodexPricedWindow, CodexRolloutFile, CodexRolloutRequest, CodexRolloutThread, CodexRolloutTier,
};
use crate::driver::codex::thread::ancestry::{
    CodexListedThread, CodexThreadPlacement, CodexUnplacedThread, list_recent_helper_threads,
    place_codex_thread,
};
use crate::pricing::export_status::{ExportStatus, ExportStatusTracker, PublishedExportStatus};
use crate::pricing::usage_files::read_usage_file_lines;

/// The folder of a Codex home its rollout files are written under, by day.
const SESSIONS_FOLDER: &str = "sessions";

/// How many rollout files one launch's fallback follows; past it a new file is passed over,
/// logged.
const ROLLOUTS_KEPT: usize = 256;

/// How many walks a file's thread gets while the listing lacks it before it is given up.
const WALKS_KEPT: u8 = 3;

/// The handles a launch's fallback reads and publishes through: the launch's export status, which
/// takes the rollout files it cannot read, and the stamps its exports' records carried.
#[derive(Clone)]
pub(crate) struct CodexLaunchRollouts {
    tracker: Weak<ExportStatusTracker>,
    status: watch::Receiver<PublishedExportStatus>,
    times: Arc<Mutex<CodexExportTimes>>,
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
                is_reading: false,
                resumed_at_ms: None,
            })),
        }
    }

    /// An export of the launch was read whose records Codex stamped from `oldest_ms` to
    /// `newest_ms`, in Unix milliseconds: the first while the fallback reads ends what it prices
    /// at its oldest record. An export with no stamped record moves neither bound.
    pub(crate) fn export_stamped(&self, oldest_ms: u64, newest_ms: u64) {
        let mut times = lock(&self.times);
        if times.is_reading && times.resumed_at_ms.is_none() {
            times.resumed_at_ms = Some(oldest_ms);
        }
        times.newest_export_stamp_ms = times.newest_export_stamp_ms.max(Some(newest_ms));
    }
}

// The stamps of a launch's exported records, which bound the stretch its fallback prices.
struct CodexExportTimes {
    registered_at_ms: u64,
    newest_export_stamp_ms: Option<u64>,
    is_reading: bool,
    // The oldest stamp of the first export since the fallback began reading.
    resumed_at_ms: Option<u64>,
}

/// What the launch's export status turned to.
pub(crate) enum CodexStatusTurn {
    /// Stopped: the fallback reads.
    Stopped,
    /// Arriving again, or not yet read: the fallback stops.
    Arriving,
    /// The launch's tracker is gone.
    Gone,
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

/// One launch's rollout fallback, run by the launch's own work task, which owns it: the files it
/// follows while the status reads stopped, and where the stretch it prices starts.
pub(crate) struct CodexRolloutFallback {
    rollouts: CodexLaunchRollouts,
    status: Option<ExportStatus>,
    // The first stamp priced, in Unix milliseconds, while the fallback reads.
    since_ms: Option<u64>,
    files: HashMap<PathBuf, CodexFollowedRollout>,
}

impl CodexRolloutFallback {
    /// A fallback over `rollouts`, reading at once where the status already reads stopped.
    pub(crate) fn new(mut rollouts: CodexLaunchRollouts) -> Self {
        let status = rollouts.status.borrow_and_update().status;
        let mut fallback = Self {
            rollouts,
            status,
            since_ms: None,
            files: HashMap::new(),
        };
        if status == Some(ExportStatus::Stopped) {
            fallback.start_reading();
        }
        fallback
    }

    /// Whether the fallback reads, its status stopped.
    pub(crate) fn is_reading(&self) -> bool {
        self.since_ms.is_some()
    }

    /// Waits for the launch's export status to change, the files it names aside, and answers
    /// what it turned to.
    pub(crate) async fn status_turned(&mut self) -> CodexStatusTurn {
        loop {
            if self.rollouts.status.changed().await.is_err() {
                return CodexStatusTurn::Gone;
            }
            let status = self.rollouts.status.borrow_and_update().status;
            if status == self.status {
                continue;
            }
            self.status = status;
            return match status {
                Some(ExportStatus::Stopped) => CodexStatusTurn::Stopped,
                Some(ExportStatus::Arriving) | None => CodexStatusTurn::Arriving,
            };
        }
    }

    /// Starts reading from the launch's last export, else its registration, unless it reads.
    pub(crate) fn start_reading(&mut self) {
        if self.since_ms.is_some() {
            return;
        }
        let mut times = lock(&self.rollouts.times);
        times.is_reading = true;
        times.resumed_at_ms = None;
        // A record stamped as the export's newest was in it.
        self.since_ms = Some(
            times
                .newest_export_stamp_ms
                .map_or(times.registered_at_ms, |newest_ms| newest_ms + 1),
        );
    }

    /// Stops reading: the offsets and the files it names go.
    pub(crate) fn stop_reading(&mut self) {
        self.since_ms = None;
        self.files.clear();
        let mut times = lock(&self.rollouts.times);
        times.is_reading = false;
        times.resumed_at_ms = None;
        drop(times);
        self.publish_unreadable();
    }

    /// One pass over `service`'s rollout files: new ones in its home found, a recent helper's in
    /// the day folder of its thread's making where the scan missed it, each followed file that
    /// grew read on from its offset once its thread is placed, each request it states pushed to
    /// the session holding the thread it came from, and the files it cannot read published.
    pub(crate) async fn pass(&mut self, service: &Arc<CodexService>) {
        let Some(since_ms) = self.since_ms else {
            return;
        };
        let sessions = service.home().codex_home.join(SESSIONS_FOLDER);
        let helpers = self.list_unfollowed_helpers(service, since_ms).await;
        let found = tokio::task::spawn_blocking(move || {
            let mut found = find_rollouts(&sessions, since_ms);
            for helper in helpers {
                found.extend(find_helper_rollout(&sessions, &helper));
            }
            found
        })
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "a codex launch's rollout files could not be listed");
            Vec::new()
        });
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
            self.files.insert(
                path,
                CodexFollowedRollout {
                    file: CodexRolloutFile::default(),
                    offset: 0,
                    size,
                    placement: CodexRolloutPlacement::Unplaced { walks: 0 },
                    is_read_failed: false,
                },
            );
        }
        let times = Arc::clone(&self.rollouts.times);
        for (path, followed) in &mut self.files {
            follow(service, path, followed, since_ms, &times).await;
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
// `since_ms` on pushed to the session its placement names; one stamped from the oldest record of
// an export read since reading began on, as `times` holds it at the read, is the export's.
async fn follow(
    service: &Arc<CodexService>,
    path: &Path,
    followed: &mut CodexFollowedRollout,
    since_ms: u64,
    times: &Mutex<CodexExportTimes>,
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
        // Read at each read, since an export can return while the pass waits on Codex.
        let window = CodexPricedWindow {
            since_ms,
            until_ms: lock(times).resumed_at_ms,
        };
        let read =
            tokio::task::spawn_blocking(move || read_on(&read_path, offset, file, window)).await;
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
            Ok((offset, requests)) => {
                followed.offset = offset;
                followed.is_read_failed = false;
                let target = match &followed.placement {
                    CodexRolloutPlacement::Below {
                        session_id,
                        session_thread,
                        child_thread,
                    } => Some((
                        *session_id,
                        Some(CodexOffStreamPlacement::BelowThread {
                            session_thread: session_thread.clone(),
                            child_thread: child_thread.clone(),
                        }),
                    )),
                    CodexRolloutPlacement::Streamed { session_id } => Some((*session_id, None)),
                    CodexRolloutPlacement::Unplaced { .. } | CodexRolloutPlacement::Passed => None,
                };
                if let Some((session_id, placed)) = target
                    && let Some(thread) = followed.file.thread()
                {
                    for request in requests {
                        push_request(service, session_id, thread, placed.as_ref(), request);
                    }
                }
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
// where it is not known yet; answers the file, and the offset the next read starts at with the
// requests read, or the failure. Blocking.
fn read_on(
    path: &Path,
    offset: u64,
    mut file: CodexRolloutFile,
    window: CodexPricedWindow,
) -> (
    CodexRolloutFile,
    io::Result<(u64, Vec<CodexRolloutRequest>)>,
) {
    let is_thread_unknown = file.thread().is_none();
    let mut requests = Vec::new();
    let read = read_usage_file_lines(path, offset, |line| {
        requests.extend(file.read_line(line, window));
        if is_thread_unknown && file.thread().is_some() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    (file, read.map(|offset| (offset, requests)))
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
    let unplaced = CodexRolloutPlacement::Unplaced { walks: walks + 1 };
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
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed))
            if walks < WALKS_KEPT =>
        {
            unplaced
        }
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed)) => {
            tracing::warn!(
                conversation_id = thread.thread_id.as_str(),
                "a codex rollout's thread is still not listed; its file is passed over"
            );
            CodexRolloutPlacement::Passed
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                conversation_id = thread.thread_id.as_str(),
                "a codex rollout's thread could not be walked; it is walked again next pass"
            );
            unplaced
        }
    }
}

// Pushes `request`, one of `thread`'s, to `session_id` on `service`, placed at `placed`, `None`
// on the thread the session streams, under the account its record's time ran on; one whose model
// or key the wire cannot carry is refused.
fn push_request(
    service: &CodexService,
    session_id: SessionId,
    thread: &CodexRolloutThread,
    placed: Option<&CodexOffStreamPlacement>,
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
            conversation_id = thread.thread_id.as_str(),
            "a codex rollout record's model or response id does not fit the wire; it is refused"
        );
        return;
    };
    let exported = CodexExportedResponse {
        response: CodexCompletedResponse {
            conversation_id: thread.thread_id.clone(),
            model_id,
            service_tier,
            counts: request.counts,
            observed_at_ms: request.at_ms,
            provider_account_id: service.account_at(request.at_ms),
        },
        arrived_at: Instant::now(),
        placed: placed.cloned(),
        rollout: Some(CodexRolloutFacts {
            request_key,
            is_root_tier,
            filing_run: None,
        }),
    };
    push_exported_response(service, session_id, exported);
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
