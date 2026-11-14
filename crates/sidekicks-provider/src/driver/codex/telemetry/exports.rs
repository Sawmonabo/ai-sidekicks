//! The driver's register of its Codex launches' exports: the tag each exporting launch carries,
//! its export status, placement state, copies' threads and rollout fallback, and the hand-off of
//! each completed response its exports state, and of each request turn it settles, to the drain;
//! each launch's charge of the responses no session holds, which its placement makes as it ends
//! and which outlives its service while its tag lives, so its last exports are charged, each under
//! the account its service ran on at its time; the driver's charge a session's unfiled responses
//! go through; and the
//! tag of each one-shot exec that exports, with the responses its exports state, collected for the
//! exec's caller.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::unix_time::read_unix_time_ms;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::side_questions::copy_turn::SessionUsageFiling;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::drain::{CodexExportDrain, CodexExportItem};
use crate::driver::codex::telemetry::placement::CodexLaunchPlacement;
use crate::driver::codex::telemetry::placement::join::CodexReviewWindow;
use crate::driver::codex::telemetry::rollouts::fallback::CodexLaunchRollouts;
use crate::driver::codex::telemetry::sessionless_spend::{
    CodexLaunchCharge, CodexSessionlessSpend,
};
use crate::driver::ports::RequestHeldListener;
use crate::pricing::export_status::{ExportStatus, ExportStatusTracker};
use crate::pricing::live::LivePricing;
use crate::pricing::receiver::bearers::TelemetryHolderId;

#[cfg(test)]
pub(crate) mod tests;

/// Codex's log batch interval, `OTEL_BLRP_SCHEDULE_DELAY`, which each service launch sets to the
/// SDK's default in place of the person's own value.
pub(crate) const CODEX_EXPORT_INTERVAL: Duration = Duration::from_secs(1);

/// The resource attribute a service launch's tag is carried under.
const SERVICE_TAG_KEY: &str = "sidekicks.codex.service";

/// The resource attribute a one-shot exec's tag is carried under.
const EXEC_TAG_KEY: &str = "sidekicks.codex.exec";

/// How many exports the reader's hand-off, how many completed responses each launch's work queue
/// and how many an exec's collection holds; a launch's response past it is charged as its
/// account's spend outside any session, and an exec's is refused and counted, as a full
/// OpenTelemetry Collector exporter queue rejects new data. One export's responses are bounded by
/// the receiver's body cap.
pub(super) const CODEX_EXPORT_HAND_OFF_DEPTH: usize = 1_024;

/// What a tag names: a service's launch or a one-shot `codex exec`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CodexTagKind {
    /// A service's launch, tagged under `sidekicks.codex.service`.
    Service,
    /// A one-shot exec, tagged under `sidekicks.codex.exec`.
    Exec,
}

impl CodexTagKind {
    /// The resource attribute a tag of this kind is carried under.
    pub(super) const fn key(self) -> &'static str {
        match self {
            Self::Service => SERVICE_TAG_KEY,
            Self::Exec => EXEC_TAG_KEY,
        }
    }
}

/// One exporting launch's or exec's place in the register: the holder number its token is minted
/// for, never repeated within a daemon, what it is, and the tag its resource carries, which a
/// joined service kept from the daemon that launched it. It stays registered while this lives
/// and, for a launch, its service does, so a draining launch's last exports are still placed.
#[derive(Debug)]
pub(crate) struct CodexExportTag {
    number: u64,
    kind: CodexTagKind,
    resource_tag: u64,
    registered: Arc<()>,
}

impl CodexExportTag {
    /// The tag as the process's resource attributes carry it, `sidekicks.codex.service=<n>` or
    /// `sidekicks.codex.exec=<n>`: the SDK splits the variable on `,` and each pair at its first
    /// `=`, and a number holds neither.
    pub(crate) fn resource_attributes(&self) -> String {
        format!("{}={}", self.kind.key(), self.resource_tag)
    }

    /// The holder the launch's telemetry token is minted for, named by the launch's number.
    pub(crate) fn holder(&self) -> TelemetryHolderId {
        TelemetryHolderId::new(self.number)
    }

    /// The tag the launch's resource carries, which its service's record keeps.
    pub(crate) fn resource_tag(&self) -> u64 {
        self.resource_tag
    }

    /// The tag's guard, which keeps the launch or exec registered while held, for the reads of
    /// exports already admitted under its token to hold.
    pub(crate) fn read_guard(&self) -> Arc<()> {
        Arc::clone(&self.registered)
    }
}

/// The driver's register of its exporting Codex launches: the tag each carries and its export
/// status, which the session's settled turns and the launch's exports feed, and the hand-off of
/// each completed response the exports state to the register's one drain.
pub(crate) struct CodexExports {
    scheduler: Arc<Scheduler>,
    // Held only to read or change the map, never across an await or a call outside the register.
    launches: Mutex<CodexLaunchExports>,
    hand_off: mpsc::Sender<CodexExportItem>,
    // The hand-off's far end, until the driver takes the drain to run.
    drain_items: Mutex<Option<mpsc::Receiver<CodexExportItem>>>,
    stop: CancellationToken,
    sessionless: Arc<CodexSessionlessSpend>,
}

/// The responses one exec's exports stated, which its caller takes once the exec ended.
pub(super) type CodexExecResponses = Arc<Mutex<Vec<CodexCompletedResponse>>>;

// Each registered launch and exec by its number, each launch whose service is gone while its tag
// lives, and the next number to mint, which all share.
struct CodexLaunchExports {
    next_number: u64,
    by_number: HashMap<u64, CodexLaunchExport>,
    ended: HashMap<u64, CodexEndedLaunch>,
    execs: HashMap<u64, CodexExecExportEntry>,
}

// A launch whose service is gone while its process still exports under its tag: the tag's guard,
// the tag its resource carries, its gone service, and the launch's charge, which charges its last
// exports under the account its service ran on at each one's time.
struct CodexEndedLaunch {
    registered: Weak<()>,
    resource_tag: u64,
    service: Weak<CodexService>,
    charge: CodexLaunchCharge,
}

// One running exec: the account it runs on, its tag's guard, and where its responses collect.
struct CodexExecExportEntry {
    provider_account_id: ProviderAccountId,
    registered: Weak<()>,
    responses: CodexExecResponses,
}

// One launch: the service it started, its tag's guard and resource tag, its export status, how
// many of its exports were read, where its off-stream threads were placed and the responses it
// keeps and holds, charged as it goes, its charge and its rollout fallback's handles.
struct CodexLaunchExport {
    service_id: CodexServiceId,
    service: Weak<CodexService>,
    registered: Weak<()>,
    resource_tag: u64,
    tracker: Arc<ExportStatusTracker>,
    exports_read: u64,
    placement: Arc<Mutex<CodexLaunchPlacement>>,
    charge: CodexLaunchCharge,
    rollouts: CodexLaunchRollouts,
}

impl CodexLaunchExport {
    // Whether the launch's tag and its service both still live.
    fn is_live(&self) -> bool {
        self.registered.strong_count() > 0 && self.service.strong_count() > 0
    }
}

/// What the reader reads an export of a registered launch with: its service, placement state and
/// charge, the export's number among the launch's, and its rollout fallback's handles, which take
/// the export's record stamps.
pub(super) struct CodexLaunchRead {
    pub(super) service: Weak<CodexService>,
    pub(super) placement: Weak<Mutex<CodexLaunchPlacement>>,
    pub(super) charge: CodexLaunchCharge,
    pub(super) export_number: u64,
    pub(super) rollouts: CodexLaunchRollouts,
}

/// What the register knows of the launch or exec an export's token was minted for.
pub(super) enum CodexLaunchLookup {
    /// The launch, its export counted, and its export status, which the reader marks exporting
    /// past the register's lock, since that cancels the launch's armed check.
    Read(CodexLaunchRead, Arc<ExportStatusTracker>),
    /// The launch lives, or its service is gone while its tag lives, but the export's resource
    /// names another tag or none.
    OtherTag(Weak<CodexService>),
    /// A running exec, under whose account its responses collect.
    Exec(ProviderAccountId, CodexExecResponses),
    /// A running exec on the account named, but the export's resource names another tag or none.
    ExecOtherTag(ProviderAccountId),
    /// The launch's service is gone while its tag lives, and the export's resource names its tag:
    /// its charge, which charges what the export states.
    Ended(CodexLaunchCharge),
    /// The launch's tag is gone, so no account is known for it.
    Gone,
}

impl CodexLaunchExports {
    // Takes out every launch whose tag or service is gone, for the caller to drop past the lock,
    // keeping the charge of each whose tag still lives, and forgets every ended launch and exec
    // whose tag is gone.
    fn take_gone(&mut self) -> Vec<CodexLaunchExport> {
        self.execs
            .retain(|_, exec| exec.registered.strong_count() > 0);
        self.ended
            .retain(|_, ended| ended.registered.strong_count() > 0);
        let gone: Vec<(u64, CodexLaunchExport)> = self
            .by_number
            .extract_if(|_, launch| !launch.is_live())
            .collect();
        for (number, launch) in &gone {
            if launch.registered.strong_count() > 0 {
                self.ended.insert(
                    *number,
                    CodexEndedLaunch {
                        registered: Weak::clone(&launch.registered),
                        resource_tag: launch.resource_tag,
                        service: Weak::clone(&launch.service),
                        charge: launch.charge.clone(),
                    },
                );
            }
        }
        gone.into_iter().map(|(_, launch)| launch).collect()
    }

    // The live launch of `service_id` registered last.
    fn newest_of(&self, service_id: CodexServiceId) -> Option<&CodexLaunchExport> {
        self.by_number
            .iter()
            .filter(|(_, launch)| launch.service_id == service_id && launch.is_live())
            .max_by_key(|(number, _)| **number)
            .map(|(_, launch)| launch)
    }
}

impl CodexExports {
    /// A register whose launches' export checks run on `scheduler`, and whose responses no
    /// session holds are handed to the repricing `request_held` registers, on a task of `tasks`,
    /// a search's account's sign-in kind read through `pricing`.
    pub(crate) fn new(
        scheduler: Arc<Scheduler>,
        request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
        pricing: Arc<LivePricing>,
        tasks: TaskTracker,
    ) -> Self {
        let (hand_off, items) = mpsc::channel(CODEX_EXPORT_HAND_OFF_DEPTH);
        let stop = CancellationToken::new();
        Self {
            sessionless: Arc::new(CodexSessionlessSpend::new(request_held, pricing, tasks)),
            scheduler,
            launches: Mutex::new(CodexLaunchExports {
                next_number: 0,
                by_number: HashMap::new(),
                ended: HashMap::new(),
                execs: HashMap::new(),
            }),
            hand_off,
            drain_items: Mutex::new(Some(items)),
            stop,
        }
    }

    // Runs `read` on the live launches under the register's lock, first taking out every launch
    // whose tag or service is gone, which is closed and dropped past the lock, since the close
    // charges what its placement kept and held and the drop cancels its check on the scheduler.
    fn with_live<R>(&self, read: impl FnOnce(&mut CodexLaunchExports) -> R) -> R {
        let mut launches = lock(&self.launches);
        let gone = launches.take_gone();
        let answer = read(&mut launches);
        drop(launches);
        for launch in gone {
            lock(&launch.placement).close();
        }
        answer
    }

    /// The scheduler the launches' export checks run on, which a test counts them on.
    #[cfg(test)]
    pub(crate) fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    /// The hand-off's drain, which the first call takes and every later one answers `None`.
    pub(crate) fn take_drain(self: &Arc<Self>) -> Option<CodexExportDrain> {
        let items = lock(&self.drain_items).take()?;
        Some(CodexExportDrain {
            register: Arc::downgrade(self),
            items,
            stop: self.stop.clone(),
        })
    }

    /// Stops the drain, which charges the responses left in the hand-off, and closes every
    /// launch's placement, which charges what it kept and held.
    pub(crate) fn stop(&self) {
        self.stop.cancel();
        let placements = self.with_live(|launches| {
            launches
                .by_number
                .values()
                .map(|launch| Arc::clone(&launch.placement))
                .collect::<Vec<_>>()
        });
        for placement in placements {
            lock(&placement).close();
        }
    }

    /// The driver's charge of the responses no session takes, which a session charges what it
    /// cannot file through at its own region.
    pub(crate) fn sessionless_spend(&self) -> &Arc<CodexSessionlessSpend> {
        &self.sessionless
    }

    /// Registers an exporting launch of `service` under a new number, which its resource carries
    /// as its tag, with a fresh export status.
    pub(crate) fn launched(&self, service: &Arc<CodexService>) -> CodexExportTag {
        self.register(service, None)
    }

    /// Registers `service`, a lasting service a former daemon launched and this one joined, under
    /// a new number, its resource carrying `resource_tag`, the tag its record kept.
    pub(crate) fn joined(&self, service: &Arc<CodexService>, resource_tag: u64) -> CodexExportTag {
        self.register(service, Some(resource_tag))
    }

    // Registers a launch of `service` whose resource carries `resource_tag`, else its number; a
    // launch still draining stays, so its last exports are placed, and the service's calls go to
    // its newest launch.
    fn register(&self, service: &Arc<CodexService>, resource_tag: Option<u64>) -> CodexExportTag {
        let tracker = Arc::new(ExportStatusTracker::new(
            Arc::clone(&self.scheduler),
            CODEX_EXPORT_INTERVAL,
        ));
        let registered = Arc::new(());
        let rollouts = CodexLaunchRollouts::new(&tracker, read_unix_time_ms());
        let charge = CodexLaunchCharge::new(&self.sessionless, service.account_timeline());
        let placement = Arc::new(Mutex::new(CodexLaunchPlacement::new(charge.clone())));
        // The launch's task follows its export status from its start, so its fallback reads as
        // the status turns stopped.
        let read_rollouts = CodexExportItem::ReadRollouts {
            service: Arc::downgrade(service),
            launch: Arc::downgrade(&placement),
            charge: charge.clone(),
            rollouts: rollouts.clone(),
        };
        let (number, resource_tag) = self.with_live(|launches| {
            let number = launches.next_number;
            launches.next_number += 1;
            let resource_tag = resource_tag.unwrap_or(number);
            launches.by_number.insert(
                number,
                CodexLaunchExport {
                    service_id: service.id(),
                    service: Arc::downgrade(service),
                    registered: Arc::downgrade(&registered),
                    resource_tag,
                    tracker,
                    exports_read: 0,
                    placement,
                    charge,
                    rollouts,
                },
            );
            (number, resource_tag)
        });
        self.offer(read_rollouts);
        CodexExportTag {
            number,
            kind: CodexTagKind::Service,
            resource_tag,
            registered,
        }
    }

    /// Registers a one-shot exec on `provider_account_id` under a new number, which its resource
    /// carries as its tag; the answer's responses collect what its exports state until the tag
    /// drops.
    pub(super) fn exec_started(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> (CodexExportTag, CodexExecResponses) {
        let registered = Arc::new(());
        let responses = CodexExecResponses::default();
        let number = self.with_live(|launches| {
            let number = launches.next_number;
            launches.next_number += 1;
            launches.execs.insert(
                number,
                CodexExecExportEntry {
                    provider_account_id: provider_account_id.clone(),
                    registered: Arc::downgrade(&registered),
                    responses: Arc::clone(&responses),
                },
            );
            number
        });
        let tag = CodexExportTag {
            number,
            kind: CodexTagKind::Exec,
            resource_tag: number,
            registered,
        };
        (tag, responses)
    }

    /// A turn of `session_id`'s thread on `service_id`'s service that began at `started_at`
    /// settled, having made a model request or not: its newest launch's export status takes it,
    /// and its rollout fallback reads the files placed on the session on. A service with no
    /// exporting launch changes nothing.
    pub(crate) fn turn_settled(
        &self,
        service_id: CodexServiceId,
        session_id: SessionId,
        made_request: bool,
        started_at: Instant,
    ) {
        let launch = self.with_live(|launches| {
            launches.newest_of(service_id).map(|launch| {
                let read_rollouts = CodexExportItem::ReadRollouts {
                    service: Weak::clone(&launch.service),
                    launch: Arc::downgrade(&launch.placement),
                    charge: launch.charge.clone(),
                    rollouts: launch.rollouts.clone(),
                };
                (
                    Arc::clone(&launch.tracker),
                    launch.rollouts.clone(),
                    read_rollouts,
                )
            })
        });
        let Some((tracker, rollouts, read_rollouts)) = launch else {
            return;
        };
        if made_request {
            rollouts.turn_settled(session_id);
        }
        if let Err(error) = tracker.turn_settled(made_request, started_at) {
            // Only a stopped scheduler refuses, and the daemon is stopping with it.
            tracing::debug!(
                error = &error as &(dyn Error + 'static),
                "a codex launch's export check could not be armed"
            );
        }
        // While the status reads stopped, the launch's rollout files hold the turn's requests.
        let is_stopped = tracker.status().borrow().status == Some(ExportStatus::Stopped);
        if made_request && is_stopped {
            self.offer(read_rollouts);
        }
    }

    /// Whether `service_id`'s service has an exporting launch; the read sweeps the launches whose
    /// tag or service is gone, as every read does.
    #[cfg(test)]
    pub(crate) fn is_exporting(&self, service_id: CodexServiceId) -> bool {
        self.with_live(|launches| launches.newest_of(service_id).is_some())
    }

    /// Opens or closes `window`, a review on a session of `service_id`'s newest launch, which
    /// that launch's unplaced reviewer requests are joined to. A service with no exporting launch
    /// changes nothing.
    pub(crate) fn review_window(&self, service_id: CodexServiceId, window: CodexReviewWindow) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement).joins().review_window(window);
        }
    }

    /// `session_id`'s own turn `turn_id` on `service_id`'s newest launch began at
    /// `started_at_ms`, in Unix milliseconds. A service with no exporting launch changes nothing.
    pub(crate) fn turn_started(
        &self,
        service_id: CodexServiceId,
        session_id: SessionId,
        turn_id: &str,
        started_at_ms: u64,
    ) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement)
                .joins()
                .turn_started(session_id, turn_id, started_at_ms);
        }
    }

    /// `session_id`'s turn `turn_id` on `service_id`'s newest launch settled or went at
    /// `ended_at_ms`, in Unix milliseconds.
    pub(crate) fn turn_ended(
        &self,
        service_id: CodexServiceId,
        session_id: SessionId,
        turn_id: &str,
        ended_at_ms: u64,
    ) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement)
                .joins()
                .turn_ended(session_id, turn_id, ended_at_ms);
        }
    }

    /// Registers the copy on `thread_id` of `service_id`'s newest launch, a clone of `filing`
    /// filing for `folder` each exported response on its thread. A service with no exporting
    /// launch changes nothing.
    pub(crate) fn copy_thread(
        &self,
        service_id: CodexServiceId,
        thread_id: &str,
        filing: &SessionUsageFiling,
        folder: &Path,
    ) {
        if let Some(placement) = self.launch_placement(service_id) {
            let filing = filing.clone();
            lock(&placement)
                .copies()
                .register(thread_id.to_owned(), filing, folder.to_owned());
        }
    }

    /// Every live launch's service and placement state, taken out of the register's lock.
    pub(super) fn placements(&self) -> Vec<(Weak<CodexService>, Arc<Mutex<CodexLaunchPlacement>>)> {
        self.with_live(|launches| {
            launches
                .by_number
                .values()
                .map(|launch| (Weak::clone(&launch.service), Arc::clone(&launch.placement)))
                .collect()
        })
    }

    // The placement state of `service_id`'s newest launch, taken out of the register's lock.
    fn launch_placement(
        &self,
        service_id: CodexServiceId,
    ) -> Option<Arc<Mutex<CodexLaunchPlacement>>> {
        self.with_live(|launches| {
            launches
                .newest_of(service_id)
                .map(|launch| Arc::clone(&launch.placement))
        })
    }

    /// Looks up `holder`'s launch or exec for an export whose resource carries `resource_tag`: a
    /// launch whose tag matches is marked as exporting and its export counted; an exec whose tag
    /// matches answers where its responses collect; one whose tag does not, whose service is gone
    /// while its tag lives, or whose tag is gone, is answered as such and left as it is.
    pub(super) fn export_read(
        &self,
        holder: TelemetryHolderId,
        resource_tag: Option<(CodexTagKind, u64)>,
    ) -> CodexLaunchLookup {
        self.with_live(|launches| {
            if let Some(exec) = launches.execs.get(&holder.number()) {
                let account = exec.provider_account_id.clone();
                return if resource_tag == Some((CodexTagKind::Exec, holder.number())) {
                    CodexLaunchLookup::Exec(account, Arc::clone(&exec.responses))
                } else {
                    CodexLaunchLookup::ExecOtherTag(account)
                };
            }
            match launches.by_number.get_mut(&holder.number()) {
                None => match launches.ended.get(&holder.number()) {
                    None => CodexLaunchLookup::Gone,
                    Some(ended)
                        if resource_tag != Some((CodexTagKind::Service, ended.resource_tag)) =>
                    {
                        CodexLaunchLookup::OtherTag(Weak::clone(&ended.service))
                    }
                    Some(ended) => CodexLaunchLookup::Ended(ended.charge.clone()),
                },
                Some(launch)
                    if resource_tag != Some((CodexTagKind::Service, launch.resource_tag)) =>
                {
                    CodexLaunchLookup::OtherTag(Weak::clone(&launch.service))
                }
                Some(launch) => {
                    launch.exports_read += 1;
                    CodexLaunchLookup::Read(
                        CodexLaunchRead {
                            service: Weak::clone(&launch.service),
                            placement: Arc::downgrade(&launch.placement),
                            charge: launch.charge.clone(),
                            export_number: launch.exports_read,
                            rollouts: launch.rollouts.clone(),
                        },
                        Arc::clone(&launch.tracker),
                    )
                }
            }
        })
    }

    /// Hands `item` to the drain without waiting; the responses a full or closed hand-off cannot
    /// take are charged as their accounts' spend outside any session. A refused retry loses
    /// nothing, since the launch's next export retries what it keeps.
    pub(super) fn offer(&self, item: CodexExportItem) {
        match self.hand_off.try_send(item) {
            Ok(()) => {}
            Err(
                TrySendError::Full(CodexExportItem::Responses {
                    charge, responses, ..
                })
                | TrySendError::Closed(CodexExportItem::Responses {
                    charge, responses, ..
                }),
            ) => {
                tracing::warn!(
                    "a codex launch's exported responses could not be handed to the drain; they \
                     are charged outside any session"
                );
                charge.charge(responses);
            }
            Err(
                TrySendError::Full(CodexExportItem::Retry { .. })
                | TrySendError::Closed(CodexExportItem::Retry { .. }),
            ) => {
                tracing::debug!("a codex launch's retry of its kept responses was not handed off");
            }
            Err(
                TrySendError::Full(CodexExportItem::ReadRollouts { .. })
                | TrySendError::Closed(CodexExportItem::ReadRollouts { .. }),
            ) => {
                // The launch's next settled request turn reads what this one wrote.
                tracing::debug!("a codex launch's read of its rollout files was not handed off");
            }
        }
    }
}
