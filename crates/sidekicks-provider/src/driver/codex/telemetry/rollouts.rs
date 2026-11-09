//! Each Codex launch's rollout fallback: while the launch's export status reads stopped, the
//! rollout files in its service's home are read for the requests no export carried, stamped from
//! the launch's last export on: one pass as the status turns stopped and one at each request turn
//! the launch settles, each file resumed from the offset its last read stopped at. A file is read
//! for price only once the walk from the thread it came from reaches a thread a session holds.
//! When an export arrives again, nothing stamped from its time on is priced, and the offsets go.

use std::collections::HashMap;
use std::io;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::driver::codex::rollout_usage::{
    CodexPricedWindow, CodexRolloutFile, CodexRolloutRequest, CodexRolloutThread, CodexRolloutTier,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::drain::push_exported_response;
use crate::driver::codex::telemetry::held_responses::{
    CodexExportedResponse, CodexOffStreamPlacement, CodexRolloutFacts,
};
use crate::driver::codex::thread::ancestry::{
    CodexThreadPlacement, CodexUnplacedThread, place_codex_thread,
};
use crate::pricing::export_status::ExportStatus;
use crate::pricing::usage_files::read_usage_file_lines;

/// The folder of a Codex home its rollout files are written under, by day.
const SESSIONS_FOLDER: &str = "sessions";

/// How many rollout files one launch's fallback follows; past it a new file is passed over,
/// logged.
const ROLLOUTS_KEPT: usize = 256;

/// How many walks a file's thread gets while the listing lacks it before it is given up.
const WALKS_KEPT: u8 = 3;

/// The handles a launch's fallback reads and publishes through: the launch's export status, when
/// its exports arrived, and the rollout files it cannot read, which the export status line reads.
#[derive(Clone)]
pub(super) struct CodexLaunchRollouts {
    status: watch::Receiver<Option<ExportStatus>>,
    times: Arc<Mutex<CodexExportTimes>>,
    /// The rollout files the launch's fallback cannot read, which the export status line names.
    pub(super) unreadable: Arc<watch::Sender<Vec<PathBuf>>>,
}

impl CodexLaunchRollouts {
    /// The handles of a launch registered at `registered_at_ms`, in Unix milliseconds, whose
    /// export status reads on `status`.
    pub(super) fn new(
        status: watch::Receiver<Option<ExportStatus>>,
        registered_at_ms: u64,
    ) -> Self {
        Self {
            status,
            times: Arc::new(Mutex::new(CodexExportTimes {
                registered_at_ms,
                last_export_at_ms: None,
                is_reading: false,
                resumed_at_ms: None,
            })),
            unreadable: Arc::new(watch::channel(Vec::new()).0),
        }
    }

    /// An export of the launch was read at `at_ms`, in Unix milliseconds: the first while the
    /// fallback reads ends what it prices.
    pub(super) fn export_read(&self, at_ms: u64) {
        let mut times = lock(&self.times);
        if times.is_reading && times.resumed_at_ms.is_none() {
            times.resumed_at_ms = Some(at_ms);
        }
        times.last_export_at_ms = Some(at_ms);
    }
}

// When a launch's exports arrived, which bound the stretch its fallback prices.
struct CodexExportTimes {
    registered_at_ms: u64,
    last_export_at_ms: Option<u64>,
    is_reading: bool,
    // The first export since the fallback began reading.
    resumed_at_ms: Option<u64>,
}

/// What the launch's export status turned to.
pub(super) enum CodexStatusTurn {
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
    // Below `session_thread`, which `session_id` holds, filed as `child_thread`.
    Below {
        session_id: SessionId,
        session_thread: String,
        child_thread: String,
    },
    // A thread a session streams, or one reaching no held thread: never read for price.
    Passed,
}

// One followed rollout file: what its lines told, where its next read starts, where its requests
// go, and whether its last read failed.
struct CodexFollowedRollout {
    file: CodexRolloutFile,
    offset: u64,
    placement: CodexRolloutPlacement,
    is_read_failed: bool,
}

/// One launch's rollout fallback, run by the launch's own work task, which owns it: the files it
/// follows while the status reads stopped, and the stretch it prices.
pub(super) struct CodexRolloutFallback {
    rollouts: CodexLaunchRollouts,
    window: Option<CodexPricedWindow>,
    files: HashMap<PathBuf, CodexFollowedRollout>,
}

impl CodexRolloutFallback {
    /// A fallback over `rollouts`, reading at once where the status already reads stopped.
    pub(super) fn new(rollouts: CodexLaunchRollouts) -> Self {
        let mut fallback = Self {
            rollouts,
            window: None,
            files: HashMap::new(),
        };
        if *fallback.rollouts.status.borrow_and_update() == Some(ExportStatus::Stopped) {
            fallback.start_reading();
        }
        fallback
    }

    /// Whether the fallback reads, its status stopped.
    pub(super) fn is_reading(&self) -> bool {
        self.window.is_some()
    }

    /// Waits for the launch's export status to change, and answers what it turned to.
    pub(super) async fn status_turned(&mut self) -> CodexStatusTurn {
        if self.rollouts.status.changed().await.is_err() {
            return CodexStatusTurn::Gone;
        }
        match *self.rollouts.status.borrow_and_update() {
            Some(ExportStatus::Stopped) => CodexStatusTurn::Stopped,
            Some(ExportStatus::Arriving) | None => CodexStatusTurn::Arriving,
        }
    }

    /// Starts reading from the launch's last export, else its registration, unless it reads.
    pub(super) fn start_reading(&mut self) {
        if self.window.is_some() {
            return;
        }
        let mut times = lock(&self.rollouts.times);
        times.is_reading = true;
        times.resumed_at_ms = None;
        let since_ms = times.last_export_at_ms.unwrap_or(times.registered_at_ms);
        self.window = Some(CodexPricedWindow {
            since_ms,
            until_ms: None,
        });
    }

    /// Stops reading: the offsets and the files it names go.
    pub(super) fn stop_reading(&mut self) {
        self.window = None;
        self.files.clear();
        let mut times = lock(&self.rollouts.times);
        times.is_reading = false;
        times.resumed_at_ms = None;
        drop(times);
        self.publish_unreadable();
    }

    /// One pass over `service`'s rollout files: new ones in its home found, each followed file
    /// read on from its offset once its thread is placed, each request it states pushed to the
    /// session holding the thread it came from, and the files it cannot read published.
    pub(super) async fn pass(&mut self, service: &Arc<CodexService>) {
        let Some(mut window) = self.window else {
            return;
        };
        window.until_ms = lock(&self.rollouts.times).resumed_at_ms;
        self.window = Some(window);
        let sessions = service.home().codex_home.join(SESSIONS_FOLDER);
        let found = tokio::task::spawn_blocking(move || find_rollouts(&sessions, window.since_ms))
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "a codex launch's rollout files could not be listed");
                Vec::new()
            });
        for path in found {
            if self.files.contains_key(&path) {
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
                    placement: CodexRolloutPlacement::Unplaced { walks: 0 },
                    is_read_failed: false,
                },
            );
        }
        for (path, followed) in &mut self.files {
            follow(service, path, followed, window).await;
        }
        self.publish_unreadable();
    }

    // Publishes the files the fallback cannot read: one whose read failed, or whose settled turn
    // left no record.
    fn publish_unreadable(&self) {
        let mut names: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(_path, followed)| followed.is_read_failed || followed.file.is_unreadable())
            .map(|(path, _followed)| path.clone())
            .collect();
        names.sort();
        self.rollouts.unreadable.send_if_modified(|published| {
            let is_changed = *published != names;
            if is_changed {
                *published = names;
            }
            is_changed
        });
    }
}

// Reads `followed` on: up to its first `session_meta` while its thread is unknown, then, once
// the walk places the thread below a held one, to its end, each request pushed to that session.
async fn follow(
    service: &Arc<CodexService>,
    path: &Path,
    followed: &mut CodexFollowedRollout,
    window: CodexPricedWindow,
) {
    loop {
        if let CodexRolloutPlacement::Below { session_thread, .. } = &followed.placement
            && service.session_of_thread(session_thread).is_none()
        {
            followed.placement = CodexRolloutPlacement::Unplaced { walks: 0 };
        }
        let unplaced = match (&followed.placement, followed.file.thread()) {
            (CodexRolloutPlacement::Passed, _) => return,
            (CodexRolloutPlacement::Unplaced { walks }, Some(thread)) => {
                Some((*walks, thread.clone()))
            }
            (CodexRolloutPlacement::Unplaced { .. } | CodexRolloutPlacement::Below { .. }, _) => {
                None
            }
        };
        if let Some((walks, thread)) = unplaced {
            followed.placement = place(service, &thread, walks).await;
            if matches!(followed.placement, CodexRolloutPlacement::Unplaced { .. }) {
                return;
            }
            continue;
        }
        let is_thread_unknown = followed.file.thread().is_none();
        let file = std::mem::take(&mut followed.file);
        let read_path = path.to_owned();
        let offset = followed.offset;
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
                if let CodexRolloutPlacement::Below {
                    session_id,
                    session_thread,
                    child_thread,
                } = &followed.placement
                    && let Some(thread) = followed.file.thread()
                {
                    let placed = CodexOffStreamPlacement::BelowThread {
                        session_thread: session_thread.clone(),
                        child_thread: child_thread.clone(),
                    };
                    for request in requests {
                        push_request(service, *session_id, thread, &placed, request);
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

// Where `thread`'s requests go: below the first held thread up from the thread it came from, on
// that thread's session; a thread a session streams, or one with no held thread above it, is
// passed. A walk the listing lacks the thread for, or that fails, leaves it unplaced for the next
// pass, past `WALKS_KEPT` walks passed.
async fn place(
    service: &CodexService,
    thread: &CodexRolloutThread,
    walks: u8,
) -> CodexRolloutPlacement {
    if service.session_of_thread(&thread.thread_id).is_some() {
        return CodexRolloutPlacement::Passed;
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

// Pushes `request`, one of `thread`'s, to `session_id` on `service`, placed at `placed`, under the
// account its record's time ran on; one whose model or key the wire cannot carry is refused.
fn push_request(
    service: &CodexService,
    session_id: SessionId,
    thread: &CodexRolloutThread,
    placed: &CodexOffStreamPlacement,
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
        placed: Some(placed.clone()),
        rollout: Some(CodexRolloutFacts {
            request_key,
            is_root_tier,
        }),
    };
    push_exported_response(service, session_id, exported);
}

// The rollout files under `sessions` written in day folders from the day before `since_ms`'s,
// in UTC, on, and modified since it; a folder that cannot be read is logged and passed over.
// Blocking.
fn find_rollouts(sessions: &Path, since_ms: u64) -> Vec<PathBuf> {
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

// Each `rollout-*.jsonl` file in `folder` modified at or after `since`.
fn modified_rollouts(folder: &Path, since: SystemTime) -> Vec<PathBuf> {
    read_entries(folder)
        .into_iter()
        .filter(|(name, path)| {
            name.starts_with("rollout-")
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
                && std::fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .is_ok_and(|modified| modified >= since)
        })
        .map(|(_name, path)| path)
        .collect()
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
