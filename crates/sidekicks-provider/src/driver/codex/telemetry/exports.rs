//! The driver's register of its Codex launches' exports: the tag each launch carries, its export
//! status, and the reader that hands the receiver each export.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, ready};
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use tokio::time::Instant;

use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::pricing::export_status::ExportStatusTracker;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader};

#[cfg(test)]
mod tests;

/// Codex's log batch interval: the SDK's default `OTEL_BLRP_SCHEDULE_DELAY`, which the launch's
/// withhold keeps the person's own value from changing.
pub(crate) const CODEX_EXPORT_INTERVAL: Duration = Duration::from_secs(1);

/// The resource attribute a launch's tag is carried under.
const SERVICE_TAG_KEY: &str = "sidekicks.codex.service";

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
/// status, which the session's settled turns and the launch's exports feed.
pub(crate) struct CodexExports {
    scheduler: Arc<Scheduler>,
    // Held only to read or change the map, never across an await or a call outside the register.
    launches: Mutex<CodexLaunchExports>,
}

// Each live launch by its tag, and the next tag to mint.
struct CodexLaunchExports {
    next_tag: u64,
    by_tag: HashMap<u64, CodexLaunchExport>,
}

// One launch: the service it started, which a later launch of the same service replaces, and its
// export status.
struct CodexLaunchExport {
    service_id: CodexServiceId,
    service: Weak<CodexService>,
    tracker: Arc<ExportStatusTracker>,
}

impl CodexExports {
    /// A register whose launches' export checks run on `scheduler`.
    pub(crate) fn new(scheduler: Arc<Scheduler>) -> Self {
        Self {
            scheduler,
            launches: Mutex::new(CodexLaunchExports {
                next_tag: 0,
                by_tag: HashMap::new(),
            }),
        }
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

    // Marks the launch whose tag `resource_logs` carries as exporting; a resource with no tag, an
    // unreadable one or one no live launch holds is logged with its text.
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
        let tracker = text
            .and_then(|text| text.parse::<u64>().ok())
            .and_then(|tag| {
                lock(&self.launches)
                    .by_tag
                    .get(&tag)
                    .map(|launch| Arc::clone(&launch.tracker))
            });
        let Some(tracker) = tracker else {
            tracing::info!(tag = ?text, "a codex export names no launch the daemon holds");
            return;
        };
        tracker.export_arrived();
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
