//! The driver's register of its Codex launches' exports: the tag each launch carries, its export
//! status and placement state, the reader that hands the receiver each export, and the drain that
//! takes each completed response the reader handed off to the session it belongs to.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, ready};
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::telemetry::completed_response::{
    CodexCompletedResponse, read_codex_completed_responses,
};
use crate::driver::codex::telemetry::held_responses::CodexExportedResponse;
use crate::driver::codex::telemetry::placement::{CodexLaunchPlacement, place_off_stream};
use crate::pricing::export_status::ExportStatusTracker;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader};

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
}

/// The driver's register of its Codex launches: the tag each launch carries and its export
/// status, which the session's settled turns and the launch's exports feed, and the hand-off of
/// each completed response the exports state to the register's one drain.
pub(crate) struct CodexExports {
    scheduler: Arc<Scheduler>,
    // Held only to read or change the map, never across an await or a call outside the register.
    launches: Mutex<CodexLaunchExports>,
    hand_off: mpsc::Sender<CodexExportItem>,
    // The hand-off's drain, until the driver takes it to run.
    drain: Mutex<Option<CodexExportDrain>>,
    stop: CancellationToken,
}

// One completed response the reader handed off, with the service that ran it and its launch's
// placement state, since a relaunch drops the tag it was read under.
struct CodexExportItem {
    service: Weak<CodexService>,
    launch: Weak<Mutex<CodexLaunchPlacement>>,
    response: CodexCompletedResponse,
    arrived_at: Instant,
}

/// The drain of the register's hand-off, which takes each completed response to the session that
/// holds its thread, one at a time, until the register stops.
pub(crate) struct CodexExportDrain {
    items: mpsc::Receiver<CodexExportItem>,
    stop: CancellationToken,
}

// Each live launch by its tag, and the next tag to mint.
struct CodexLaunchExports {
    next_tag: u64,
    by_tag: HashMap<u64, CodexLaunchExport>,
}

// One launch: the service it started, which a later launch of the same service replaces, its
// export status and where its off-stream threads were placed, which go with it.
struct CodexLaunchExport {
    service_id: CodexServiceId,
    service: Weak<CodexService>,
    tracker: Arc<ExportStatusTracker>,
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
            drain: Mutex::new(Some(CodexExportDrain {
                items,
                stop: stop.clone(),
            })),
            stop,
        }
    }

    /// The scheduler the launches' export checks run on, which a test counts them on.
    #[cfg(test)]
    pub(crate) fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    /// The hand-off's drain, which the first call takes and every later one answers `None`.
    pub(crate) fn take_drain(&self) -> Option<CodexExportDrain> {
        lock(&self.drain).take()
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

    // Marks the launch whose tag `resource_logs` carries as exporting and hands each completed
    // response its records state to the drain; a resource with no tag, an unreadable one or one
    // no live launch holds is logged with its text, and one whose service is gone with its count.
    fn read_resource_logs(&self, resource_logs: &ResourceLogs) {
        let text = resource_logs
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
            });
        let launch = text
            .and_then(|text| text.parse::<u64>().ok())
            .and_then(|tag| {
                lock(&self.launches).by_tag.get(&tag).map(|launch| {
                    (
                        Arc::clone(&launch.tracker),
                        Weak::clone(&launch.service),
                        Arc::downgrade(&launch.placement),
                    )
                })
            });
        let Some((tracker, service, placement)) = launch else {
            tracing::info!(tag = ?text, "a codex export names no launch the daemon holds");
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
            self.offer(CodexExportItem {
                service: Weak::clone(&service),
                launch: Weak::clone(&placement),
                response,
                arrived_at,
            });
        }
    }

    // Hands `item` to the drain without waiting; a full or closed hand-off drops it, logged.
    fn offer(&self, item: CodexExportItem) {
        match self.hand_off.try_send(item) {
            Ok(()) => {}
            Err(TrySendError::Full(item)) => {
                let response = &item.response;
                tracing::warn!(
                    conversation_id = response.conversation_id.as_str(),
                    tokens = ?response.counts,
                    "the codex export hand-off is full; a completed response is dropped"
                );
            }
            Err(TrySendError::Closed(item)) => {
                let response = &item.response;
                tracing::info!(
                    conversation_id = response.conversation_id.as_str(),
                    tokens = ?response.counts,
                    "the codex export drain has stopped; a completed response is dropped"
                );
            }
        }
    }
}

impl CodexExportDrain {
    /// Takes each handed-off response to its session, one at a time, until the register stops,
    /// then logs how many it leaves in the hand-off.
    pub(crate) async fn run(mut self) {
        loop {
            let item = tokio::select! {
                biased;
                () = self.stop.cancelled() => {
                    tracing::info!(
                        left = self.items.len(),
                        "the codex export drain stopped; the responses left in its hand-off are \
                         dropped"
                    );
                    return;
                }
                item = self.items.recv() => item,
            };
            // The register holds the sender, so its drop ends the drain too.
            let Some(item) = item else {
                return;
            };
            deliver(item).await;
        }
    }
}

// Pushes `item`'s response onto the queue of the session holding its thread on its service, else
// places it off the stream on its launch; a response whose service or launch is gone is logged
// and dropped.
async fn deliver(item: CodexExportItem) {
    let CodexExportItem {
        service,
        launch,
        response,
        arrived_at,
    } = item;
    let Some(service) = service.upgrade() else {
        tracing::info!(
            conversation_id = response.conversation_id.as_str(),
            "a codex completed response's service is gone; it is dropped"
        );
        return;
    };
    if let Some(session_id) = service.session_of_thread(&response.conversation_id) {
        let exported = CodexExportedResponse {
            response,
            arrived_at,
            placed: None,
        };
        push_exported_response(&service, session_id, exported);
        return;
    }
    let Some(launch) = launch.upgrade() else {
        tracing::info!(
            conversation_id = response.conversation_id.as_str(),
            "a codex completed response's launch was replaced; it is dropped"
        );
        return;
    };
    place_off_stream(&service, &launch, response, arrived_at).await;
}

/// Pushes `exported` onto `session_id`'s queue on `service`; one no session took is logged and
/// dropped.
pub(crate) fn push_exported_response(
    service: &CodexService,
    session_id: SessionId,
    exported: CodexExportedResponse,
) {
    let conversation_id = exported.response.conversation_id.clone();
    if !service.push_session_item(&session_id, CodexSessionInbound::ExportedResponse(exported)) {
        tracing::info!(
            conversation_id = conversation_id.as_str(),
            %session_id,
            "no codex session took a completed response; it is dropped"
        );
    }
}

impl TelemetryExportReader for CodexExports {
    fn read_telemetry_export(&self, export: TelemetryExport) -> BoxFuture<'_, ()> {
        match export {
            TelemetryExport::Logs(request) => {
                for resource_logs in &request.resource_logs {
                    self.read_resource_logs(resource_logs);
                }
            }
            // Every launch sets Codex's trace exporter off.
            TelemetryExport::Traces(_) => {}
        }
        Box::pin(ready(()))
    }
}
