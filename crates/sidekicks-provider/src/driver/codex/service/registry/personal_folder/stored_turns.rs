//! The read of the stored turns waited on in a person's own Codex folder, on a short-lived service
//! of the daemon's own there: every wait open on a turn of the folder's terminal sessions is
//! registered while it waits, one read lists the turn of each of them on one service started on
//! the folder it holds and hands each wait its turn's reading, a second read on the folder starts
//! only once the first's service has stopped, and the folder's waits share one retry where no
//! event may follow a turn already stored.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use futures::future::join_all;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::retry::jitter::draw_jitter_sample;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder::PERSONAL_FOLDER_HOLDS;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::reconnect::reconnect_wait;
use crate::driver::codex::terminal_session::exchanges::{
    CodexTerminalTurnEnd, read_settled_turn_end,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;

/// The waits on stored turns, per folder, and how far their reads have come.
#[derive(Default)]
pub(in crate::driver::codex::service::registry) struct StoredTurnWaits {
    folders: HashMap<PathBuf, FolderTurnWaits>,
}

// The waits on one folder's stored turns.
#[derive(Default)]
struct FolderTurnWaits {
    waits: HashMap<u64, WaitedTurn>,
    next_wait: u64,
    // How many reads on the folder have asked for their turns so far.
    reads_listed: u64,
    // Whether a read is on its way that has not asked for its turns yet.
    is_read_coming: bool,
    retry: FolderRetry,
}

// The one retry a folder's waits share: how many tries it made in a row, and the try armed next,
// which the first wait to reach it makes.
#[derive(Default)]
struct FolderRetry {
    tries: u32,
    armed: Option<StoredTurnRetry>,
    next_place: u64,
}

/// One armed try of a folder's shared retry: its place among the folder's tries and when it is
/// due.
#[derive(Clone, Copy)]
pub(crate) struct StoredTurnRetry {
    place: u64,
    /// When the try is due.
    pub(crate) due: Instant,
}

// One wait's turn and where its readings go.
struct WaitedTurn {
    thread_id: String,
    turn_id: String,
    reading: watch::Sender<Option<StoredTurnReading>>,
}

// One read's finding on one turn.
struct StoredTurnReading {
    // The read's place among the folder's reads.
    read: u64,
    // Where a service was on the folder, its reports when the read asked for the turns.
    reports: Option<ServiceReports>,
    outcome: StoredTurnOutcome,
}

// A service and the count of its reports of answering nothing at one moment.
#[derive(Clone)]
struct ServiceReports {
    service: Weak<CodexService>,
    count: u64,
}

/// What a read of a stored turn on the daemon's own service found.
#[derive(Clone, Debug)]
pub(crate) enum StoredTurnOutcome {
    /// The turn completed, failed, or was interrupted with an end time.
    Settled(CodexTerminalTurnEnd),
    /// The turn has not settled: it still runs in the folder's own service, or the list does not
    /// hold it.
    Unsettled,
    /// The read's service could not start, or the read failed for a cause that may pass.
    Unread,
    /// Codex refused the read in a way asking again cannot change, such as a thread the folder's
    /// store does not hold.
    Refused,
    /// The folder is no longer the one terminal reach names, so the turn's session can no longer
    /// be reached through it.
    Unreachable,
}

/// Why a wait reads its stored turn, which says which read can answer it.
#[derive(Clone, Copy)]
pub(crate) enum StoredTurnCause<'cause> {
    /// `service`, one the daemon only joined, was reported answering nothing, its report count now
    /// `reports`: a read that asked for the turn once that report was in answers it.
    Report {
        /// The service on the folder.
        service: &'cause Arc<CodexService>,
        /// Its report count the wait read.
        reports: u64,
    },
    /// Anything else: only a read that asks for the turn after this one is asked for answers it.
    Asked,
}

/// One wait's place among the waits on its folder's stored turns, from its start to its end: each
/// read on the folder reads its turn, and dropping it takes the turn out.
pub(crate) struct StoredTurnWait {
    registry: Arc<CodexServiceRegistry>,
    folder: PathBuf,
    key: u64,
    reading: watch::Receiver<Option<StoredTurnReading>>,
}

impl CodexServiceRegistry {
    /// Registers a wait on the turn `turn_id` of `thread_id`, a conversation in the person's own
    /// Codex folder, among the waits every read of a stored turn there reads.
    pub(crate) fn wait_on_stored_turn(
        self: &Arc<Self>,
        thread_id: &str,
        turn_id: &str,
    ) -> StoredTurnWait {
        let folder = self.homes.terminal_reach_home().codex_home;
        let (reading, receiver) = watch::channel(None);
        let mut waits = lock(&self.stored_turn_waits);
        let folder_waits = waits.folders.entry(folder.clone()).or_default();
        let key = folder_waits.next_wait;
        folder_waits.next_wait += 1;
        folder_waits.waits.insert(
            key,
            WaitedTurn {
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
                reading,
            },
        );
        StoredTurnWait {
            registry: Arc::clone(self),
            folder,
            key,
            reading: receiver,
        }
    }

    // Asks for a read on `folder` that lists its turns from now on, joining one on its way that
    // has not listed them yet, else starting one on the driver's tracked tasks; answers how many
    // reads had listed them before.
    fn ask_for_stored_turn_read(self: &Arc<Self>, folder: &Path) -> u64 {
        let mut waits = lock(&self.stored_turn_waits);
        let folder_waits = waits.folders.entry(folder.to_path_buf()).or_default();
        let listed = folder_waits.reads_listed;
        if !folder_waits.is_read_coming {
            folder_waits.is_read_coming = true;
            let registry = Arc::clone(self);
            let folder = folder.to_path_buf();
            self.dependencies
                .tasks
                .spawn(async move { registry.read_stored_turns(folder).await });
        }
        listed
    }

    // Reads the turn of every wait on `folder` on one short-lived service of the daemon's own
    // started on it once the folder is held, after the last such service there has stopped, hands
    // each wait its turn's reading, and retires the service holding the folder until it has
    // stopped. A folder terminal reach no longer names starts no service, its turns unreachable.
    async fn read_stored_turns(self: Arc<Self>, folder: PathBuf) {
        let hold = PERSONAL_FOLDER_HOLDS.acquire(folder).await;
        let folder = hold.key().clone();
        let is_reached = folder == self.homes.terminal_reach_home().codex_home;
        let mut service = None;
        let mut connection = None;
        if is_reached {
            let started = match self.transient_service(&hold) {
                Ok(made) => {
                    let started = self.start_transient(&made).await;
                    let made_connection = started.and_then(|()| made.connection());
                    service = Some(made);
                    made_connection
                }
                Err(error) => Err(error),
            };
            connection = started
                .inspect_err(|error| {
                    tracing::warn!(
                        error = error as &(dyn std::error::Error + 'static),
                        "the daemon's own service for reading stored turns did not start"
                    );
                })
                .ok();
        }
        let (read, reports, turns) = self.list_stored_turns(&folder);
        let outcomes = join_all(turns.iter().map(|turn| async {
            if !is_reached {
                return StoredTurnOutcome::Unreachable;
            }
            read_stored_turn(connection.as_deref(), turn).await
        }))
        .await;
        for (turn, outcome) in turns.into_iter().zip(outcomes) {
            turn.reading.send_replace(Some(StoredTurnReading {
                read,
                reports: reports.clone(),
                outcome,
            }));
        }
        if let Some(service) = service {
            self.retire_transient(service, hold);
        }
    }

    // Starts the read that lists `folder`'s turns: its place among the folder's reads, the report
    // count of the service on the folder taken now, and every turn waited on there now.
    fn list_stored_turns(&self, folder: &Path) -> (u64, Option<ServiceReports>, Vec<WaitedTurn>) {
        let reports = self.terminal_home_service().map(|service| ServiceReports {
            service: Arc::downgrade(&service),
            count: service.unanswered_reports(),
        });
        let mut waits = lock(&self.stored_turn_waits);
        let Some(folder_waits) = waits.folders.get_mut(folder) else {
            return (0, reports, Vec::new());
        };
        folder_waits.is_read_coming = false;
        folder_waits.reads_listed += 1;
        let read = folder_waits.reads_listed;
        let turns = folder_waits
            .waits
            .values()
            .map(|waited| WaitedTurn {
                thread_id: waited.thread_id.clone(),
                turn_id: waited.turn_id.clone(),
                reading: waited.reading.clone(),
            })
            .collect();
        if folder_waits.waits.is_empty() {
            waits.folders.remove(folder);
        }
        (read, reports, turns)
    }
}

impl StoredTurnWait {
    /// The stored turn as a read on the daemon's own short-lived service finds it for `cause`: a
    /// reading already in hand where it answers a report, else the next read that asks for the
    /// turn after this call, started where none is on its way.
    pub(crate) async fn read(&mut self, cause: StoredTurnCause<'_>) -> StoredTurnOutcome {
        if let StoredTurnCause::Report { service, reports } = cause
            && let Some(reading) = self.reading.borrow_and_update().as_ref()
            && reading.reports.as_ref().is_some_and(|read_at| {
                read_at
                    .service
                    .upgrade()
                    .is_some_and(|read_on| Arc::ptr_eq(&read_on, service))
                    && read_at.count >= reports
            })
        {
            return reading.outcome.clone();
        }
        let listed = self.registry.ask_for_stored_turn_read(&self.folder);
        let reading = self
            .reading
            .wait_for(|reading| {
                reading
                    .as_ref()
                    .is_some_and(|reading| reading.read > listed)
            })
            .await
            .expect("the wait's own entry holds its readings while it waits");
        reading
            .as_ref()
            .expect("the reading waited for is in")
            .outcome
            .clone()
    }

    /// The next reading of the turn a read on the folder hands this wait, one the wait has not
    /// read yet: any wait's read lists every turn waited on in the folder.
    pub(crate) async fn next_reading(&mut self) -> StoredTurnOutcome {
        self.reading
            .changed()
            .await
            .expect("the wait's own entry holds its readings while it waits");
        self.reading
            .borrow_and_update()
            .as_ref()
            .expect("a reading sent is in")
            .outcome
            .clone()
    }

    /// The folder's next try of its shared retry, armed now where none is, due after the wait the
    /// service's own redial schedule gives the tries made in a row: from 1 second, each wait 1.6
    /// times the last, a fifth either way, never past 120 seconds.
    pub(crate) fn arm_retry(&self) -> StoredTurnRetry {
        let mut waits = lock(&self.registry.stored_turn_waits);
        let retry = &mut self.folder_waits(&mut waits).retry;
        if let Some(armed) = retry.armed {
            return armed;
        }
        let armed = StoredTurnRetry {
            place: retry.next_place,
            due: Instant::now() + reconnect_wait(retry.tries, draw_jitter_sample()),
        };
        retry.next_place += 1;
        retry.armed = Some(armed);
        armed
    }

    /// Takes `armed`, a try that came due, for this wait to make, and counts it; `false` where
    /// another wait on the folder took it, whose try wakes this one, or where the retries started
    /// again since.
    pub(crate) fn take_retry(&self, armed: StoredTurnRetry) -> bool {
        let mut waits = lock(&self.registry.stored_turn_waits);
        let retry = &mut self.folder_waits(&mut waits).retry;
        if retry
            .armed
            .is_none_or(|current| current.place != armed.place)
        {
            return false;
        }
        retry.armed = None;
        retry.tries = retry.tries.saturating_add(1);
        true
    }

    /// Starts the folder's retries again from the first wait, the state that needed them over.
    pub(crate) fn end_retries(&self) {
        let mut waits = lock(&self.registry.stored_turn_waits);
        let retry = &mut self.folder_waits(&mut waits).retry;
        retry.tries = 0;
        retry.armed = None;
    }

    // The waits on this wait's folder, which hold this one while it waits.
    fn folder_waits<'waits>(
        &self,
        waits: &'waits mut StoredTurnWaits,
    ) -> &'waits mut FolderTurnWaits {
        waits
            .folders
            .get_mut(&self.folder)
            .expect("a wait's folder is held while the wait is registered")
    }
}

impl Drop for StoredTurnWait {
    fn drop(&mut self) {
        let mut waits = lock(&self.registry.stored_turn_waits);
        let Some(folder_waits) = waits.folders.get_mut(&self.folder) else {
            return;
        };
        folder_waits.waits.remove(&self.key);
        if folder_waits.waits.is_empty() && !folder_waits.is_read_coming {
            waits.folders.remove(&self.folder);
        }
    }
}

// What one read finds of `turn` on `connection`, the short-lived service's, `None` where it did
// not start.
async fn read_stored_turn(
    connection: Option<&CodexAppServerConnection>,
    turn: &WaitedTurn,
) -> StoredTurnOutcome {
    let Some(connection) = connection else {
        return StoredTurnOutcome::Unread;
    };
    match read_settled_turn_end(connection, &turn.thread_id, &turn.turn_id).await {
        Ok(Some(end)) => StoredTurnOutcome::Settled(end),
        Ok(None) => StoredTurnOutcome::Unsettled,
        Err(error) => {
            tracing::warn!(
                thread_id = turn.thread_id.as_str(),
                error = &error as &(dyn std::error::Error + 'static),
                "a stored turn could not be read on the daemon's own service"
            );
            if error.is_standing_refusal() {
                StoredTurnOutcome::Refused
            } else {
                StoredTurnOutcome::Unread
            }
        }
    }
}
