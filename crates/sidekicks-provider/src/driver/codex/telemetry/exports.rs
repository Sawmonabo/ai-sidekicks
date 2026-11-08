//! The driver's register of its Codex launches' exports: the tag each launch carries, its export
//! status, placement state and copies' threads, and the reader that hands the receiver each
//! export, whose completed responses it hands off to the drain.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, ready};
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::side_questions::copy_turn::SessionUsageFiling;
use crate::driver::codex::telemetry::completed_response::{
    RecordRefusal, read_codex_completed_responses,
};
use crate::driver::codex::telemetry::copy_threads::CodexEndedCopy;
use crate::driver::codex::telemetry::drain::{CodexExportDrain, CodexExportItem};
use crate::driver::codex::telemetry::placement::{CodexLaunchPlacement, CodexReviewWindow};
use crate::pricing::export_status::ExportStatusTracker;
use crate::pricing::receiver::bearers::TelemetryHolderId;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader};
use crate::usage_delta_accountant::UsageAxisCounts;

#[cfg(test)]
pub(crate) mod tests;

/// Codex's log batch interval: the SDK's default `OTEL_BLRP_SCHEDULE_DELAY`, which the launch's
/// withhold keeps the person's own value from changing.
pub(crate) const CODEX_EXPORT_INTERVAL: Duration = Duration::from_secs(1);

/// The resource attribute a launch's tag is carried under.
const SERVICE_TAG_KEY: &str = "sidekicks.codex.service";

/// How many completed responses the reader's hand-off holds for the drain; a response past it is
/// dropped and logged, as a full OpenTelemetry Collector exporter queue rejects new data.
const CODEX_EXPORT_HAND_OFF_DEPTH: usize = 1_024;

/// One launch's tag, minted by the register and never repeated within a daemon.
#[derive(Debug)]
pub(crate) struct CodexExportTag(u64);

impl CodexExportTag {
    /// The tag as the launch's resource attributes carry it, `sidekicks.codex.service=<n>`: the
    /// SDK splits the variable on `,` and each pair at its first `=`, and a number holds neither.
    pub(crate) fn resource_attributes(&self) -> String {
        format!("{SERVICE_TAG_KEY}={}", self.0)
    }

    /// The holder the launch's telemetry token is minted for, named by the tag's number.
    pub(crate) fn holder(&self) -> TelemetryHolderId {
        TelemetryHolderId::new(self.0)
    }
}

/// The driver's register of its Codex launches: the tag each launch carries and its export
/// status, which the session's settled turns and the launch's exports feed, and the hand-off of
/// each completed response the exports state to the register's one drain.
pub(crate) struct CodexExports {
    scheduler: Arc<Scheduler>,
    // Held only to read or change the map, never across an await or a call outside the register.
    launches: Mutex<CodexLaunchExports>,
    hand_off: mpsc::Sender<CodexExportItem>,
    // The hand-off's far end, until the driver takes the drain to run.
    drain_items: Mutex<Option<mpsc::Receiver<CodexExportItem>>>,
    // Wakes the drain when a copy's read ends, so it files that copy when due.
    copies_ended: Arc<Notify>,
    stop: CancellationToken,
}

// Each live launch by its tag, and the next tag to mint.
struct CodexLaunchExports {
    next_tag: u64,
    by_tag: HashMap<u64, CodexLaunchExport>,
}

// One launch: the service it started, which a later launch of the same service replaces, its
// export status, how many of its exports were read, and where its off-stream threads were placed
// and the responses it keeps, which go with it.
struct CodexLaunchExport {
    service_id: CodexServiceId,
    service: Weak<CodexService>,
    tracker: Arc<ExportStatusTracker>,
    exports_read: u64,
    placement: Arc<Mutex<CodexLaunchPlacement>>,
}

impl CodexExports {
    /// A register whose launches' export checks run on `scheduler`.
    pub(crate) fn new(scheduler: Arc<Scheduler>) -> Self {
        let (hand_off, items) = mpsc::channel(CODEX_EXPORT_HAND_OFF_DEPTH);
        let stop = CancellationToken::new();
        Self {
            scheduler,
            launches: Mutex::new(CodexLaunchExports {
                next_tag: 0,
                by_tag: HashMap::new(),
            }),
            hand_off,
            drain_items: Mutex::new(Some(items)),
            copies_ended: Arc::default(),
            stop,
        }
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
            copies_ended: Arc::clone(&self.copies_ended),
            stop: self.stop.clone(),
        })
    }

    /// Stops the drain, which drops and logs the responses left in the hand-off.
    pub(crate) fn stop(&self) {
        self.stop.cancel();
    }

    /// Registers a launch of `service` under a new tag with a fresh export status, dropping every
    /// launch whose service is gone and the service's own earlier launch, whose armed check the
    /// drop cancels.
    pub(crate) fn launched(&self, service: &Arc<CodexService>) -> CodexExportTag {
        let service_id = service.id();
        let tracker = Arc::new(ExportStatusTracker::new(
            Arc::clone(&self.scheduler),
            CODEX_EXPORT_INTERVAL,
        ));
        let mut launches = lock(&self.launches);
        let replaced: Vec<CodexLaunchExport> = launches
            .by_tag
            .extract_if(|_, launch| {
                launch.service_id == service_id || launch.service.strong_count() == 0
            })
            .map(|(_, launch)| launch)
            .collect();
        let tag = launches.next_tag;
        launches.next_tag += 1;
        launches.by_tag.insert(
            tag,
            CodexLaunchExport {
                service_id,
                service: Arc::downgrade(service),
                tracker,
                exports_read: 0,
                placement: Arc::default(),
            },
        );
        drop(launches);
        // Dropped past the lock, since each drop cancels its check on the scheduler.
        drop(replaced);
        CodexExportTag(tag)
    }

    /// A turn of `service_id`'s service that began at `started_at` settled, having made a model
    /// request or not: its current launch's export status takes it. A service with no launch
    /// changes nothing.
    pub(crate) fn turn_settled(
        &self,
        service_id: CodexServiceId,
        made_request: bool,
        started_at: Instant,
    ) {
        let tracker = lock(&self.launches)
            .by_tag
            .values()
            .find(|launch| launch.service_id == service_id)
            .map(|launch| Arc::clone(&launch.tracker));
        let Some(tracker) = tracker else {
            return;
        };
        if let Err(error) = tracker.turn_settled(made_request, started_at) {
            // Only a stopped scheduler refuses, and the daemon is stopping with it.
            tracing::debug!(
                error = &error as &(dyn Error + 'static),
                "a codex launch's export check could not be armed"
            );
        }
    }

    /// Opens `window`, a review on a session of `service_id`'s current launch, which that launch's
    /// unplaced reviewer requests are joined to. A service with no launch changes nothing.
    pub(crate) fn review_window(&self, service_id: CodexServiceId, window: CodexReviewWindow) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement).open_review_window(window);
        }
    }

    /// `session_id`'s own turn `turn_id` on `service_id`'s current launch began at
    /// `started_at_ms`, in Unix milliseconds. A service with no launch changes nothing.
    pub(crate) fn turn_started(
        &self,
        service_id: CodexServiceId,
        session_id: SessionId,
        turn_id: &str,
        started_at_ms: u64,
    ) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement).turn_started(session_id, turn_id, started_at_ms);
        }
    }

    /// `session_id`'s turn `turn_id` on `service_id`'s current launch settled or went.
    pub(crate) fn turn_ended(
        &self,
        service_id: CodexServiceId,
        session_id: SessionId,
        turn_id: &str,
    ) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement).turn_ended(session_id, turn_id);
        }
    }

    /// Registers the copy on `thread_id` of `service_id`'s current launch, a clone of `filing`
    /// filing for `folder` what the copy's stream never stated; the answer marks the copy's read
    /// ended as it drops, so it is held for as long as the read runs.
    pub(crate) fn copy_thread(
        self: &Arc<Self>,
        service_id: CodexServiceId,
        thread_id: &str,
        filing: &SessionUsageFiling,
        folder: &Path,
    ) -> CodexCopyThreadRead {
        if let Some(placement) = self.launch_placement(service_id) {
            let filing = filing.clone();
            lock(&placement)
                .copies()
                .register(thread_id.to_owned(), filing, folder.to_owned());
        }
        CodexCopyThreadRead {
            register: Arc::downgrade(self),
            service_id,
            thread_id: thread_id.to_owned(),
        }
    }

    /// The copy on `thread_id` of `service_id`'s current launch filed a request of `counts` from
    /// its own stream; a thread no copy holds changes nothing.
    pub(crate) fn copy_filed(
        &self,
        service_id: CodexServiceId,
        thread_id: &str,
        counts: UsageAxisCounts,
    ) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement).copies().filed(thread_id, counts);
        }
    }

    // The copy on `thread_id`'s read ended now; the drain files what it never stated when due.
    fn copy_ended(&self, service_id: CodexServiceId, thread_id: &str) {
        if let Some(placement) = self.launch_placement(service_id) {
            lock(&placement).copies().ended(thread_id, Instant::now());
            self.copies_ended.notify_one();
        }
    }

    /// When the earliest ended copy of any launch is due.
    pub(super) fn next_copy_due(&self) -> Option<Instant> {
        self.placements()
            .into_iter()
            .filter_map(|(_service, placement)| lock(&placement).copies().next_due())
            .min()
    }

    /// Takes every copy of every launch due at `now`, each with its launch's service.
    pub(super) fn take_due_copies(
        &self,
        now: Instant,
    ) -> Vec<(Weak<CodexService>, CodexEndedCopy)> {
        self.placements()
            .into_iter()
            .flat_map(|(service, placement)| {
                let due = lock(&placement).copies().take_due(now);
                due.into_iter()
                    .map(move |copy| (Weak::clone(&service), copy))
            })
            .collect()
    }

    /// Every launch's service and placement state, taken out of the register's lock.
    pub(super) fn placements(&self) -> Vec<(Weak<CodexService>, Arc<Mutex<CodexLaunchPlacement>>)> {
        lock(&self.launches)
            .by_tag
            .values()
            .map(|launch| (Weak::clone(&launch.service), Arc::clone(&launch.placement)))
            .collect()
    }

    // The placement state of `service_id`'s current launch, taken out of the register's lock.
    fn launch_placement(
        &self,
        service_id: CodexServiceId,
    ) -> Option<Arc<Mutex<CodexLaunchPlacement>>> {
        lock(&self.launches)
            .by_tag
            .values()
            .find(|launch| launch.service_id == service_id)
            .map(|launch| Arc::clone(&launch.placement))
    }

    // Marks `holder`'s launch, whose token the export presented, as exporting and hands each
    // completed response `resource_logs` states to the drain. A resource whose tag is absent,
    // unreadable or names another launch is dropped and counted once under the holder's account;
    // a holder whose launch was replaced is logged, and one whose service is gone with its count.
    fn read_resource_logs(&self, holder: TelemetryHolderId, resource_logs: &ResourceLogs) {
        let tag = resource_logs
            .resource
            .iter()
            .flat_map(|resource| &resource.attributes)
            .find(|attribute| attribute.key == SERVICE_TAG_KEY)
            .and_then(|attribute| attribute.value.as_ref())
            .and_then(|value| {
                if let Some(Value::StringValue(text)) = &value.value {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .and_then(|text| text.parse::<u64>().ok());
        if tag != Some(holder.number()) {
            let service = lock(&self.launches)
                .by_tag
                .get(&holder.number())
                .map(|launch| Weak::clone(&launch.service));
            let provider_account_id = service
                .and_then(|service| service.upgrade())
                .and_then(|service| service.provider_account_id());
            RecordRefusal {
                field: SERVICE_TAG_KEY,
                reason: "its resource names no launch its token was minted for",
            }
            .report(provider_account_id.as_ref());
            return;
        }
        let launch = lock(&self.launches)
            .by_tag
            .get_mut(&holder.number())
            .map(|launch| {
                launch.exports_read += 1;
                (
                    Arc::clone(&launch.tracker),
                    Weak::clone(&launch.service),
                    Arc::downgrade(&launch.placement),
                    launch.exports_read,
                )
            });
        let Some((tracker, service, placement, export_number)) = launch else {
            tracing::info!(
                tag = holder.number(),
                "a codex export's launch was replaced; its records are dropped"
            );
            return;
        };
        tracker.export_arrived();
        let arrived_at = Instant::now();
        let Some(live_service) = service.upgrade() else {
            let records: usize = resource_logs
                .scope_logs
                .iter()
                .map(|scope_logs| scope_logs.log_records.len())
                .sum();
            tracing::info!(
                records,
                "a codex export's service is gone; its records are dropped"
            );
            return;
        };
        let provider_account_id = live_service.provider_account_id();
        for response in read_codex_completed_responses(resource_logs, provider_account_id.as_ref())
        {
            self.offer(CodexExportItem::Response {
                service: Weak::clone(&service),
                launch: Weak::clone(&placement),
                response,
                arrived_at,
                export_number,
            });
        }
        self.offer(CodexExportItem::Retry {
            service,
            launch: placement,
            export_number,
        });
    }

    // Hands `item` to the drain without waiting; a full or closed hand-off drops it, logged. A
    // dropped retry loses nothing, since the launch's next export retries what it keeps.
    fn offer(&self, item: CodexExportItem) {
        match self.hand_off.try_send(item) {
            Ok(()) => {}
            Err(TrySendError::Full(CodexExportItem::Response { response, .. })) => {
                tracing::warn!(
                    conversation_id = response.conversation_id.as_str(),
                    tokens = ?response.counts,
                    "the codex export hand-off is full; a completed response is dropped"
                );
            }
            Err(TrySendError::Closed(CodexExportItem::Response { response, .. })) => {
                tracing::info!(
                    conversation_id = response.conversation_id.as_str(),
                    tokens = ?response.counts,
                    "the codex export drain has stopped; a completed response is dropped"
                );
            }
            Err(
                TrySendError::Full(CodexExportItem::Retry { .. })
                | TrySendError::Closed(CodexExportItem::Retry { .. }),
            ) => {
                tracing::debug!("a codex launch's retry of its kept responses was not handed off");
            }
        }
    }
}

/// A copy's read on its thread, which marks the copy's read ended as it drops, so the drain files
/// what the copy's stream never stated two export intervals later.
pub(crate) struct CodexCopyThreadRead {
    register: Weak<CodexExports>,
    service_id: CodexServiceId,
    thread_id: String,
}

impl Drop for CodexCopyThreadRead {
    fn drop(&mut self) {
        if let Some(register) = self.register.upgrade() {
            register.copy_ended(self.service_id, &self.thread_id);
        }
    }
}

impl TelemetryExportReader for CodexExports {
    fn read_telemetry_export(
        &self,
        holder: TelemetryHolderId,
        export: TelemetryExport,
    ) -> BoxFuture<'_, ()> {
        match export {
            TelemetryExport::Logs(request) => {
                for resource_logs in &request.resource_logs {
                    self.read_resource_logs(holder, resource_logs);
                }
            }
            // Every launch sets Codex's trace exporter off.
            TelemetryExport::Traces(_) => {}
        }
        Box::pin(ready(()))
    }
}
