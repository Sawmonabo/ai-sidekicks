//! The reader the receiver hands each Codex export: the launch its token was minted for checked
//! against the tag its resource carries, and each completed response its records state stamped
//! with the account it ran on and handed off to the drain.

use futures::future::{BoxFuture, ready};
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use tokio::time::Instant;

use crate::driver::codex::telemetry::completed_response::{
    RecordRefusal, find_attribute, read_codex_completed_responses,
};
use crate::driver::codex::telemetry::drain::CodexExportItem;
use crate::driver::codex::telemetry::exports::{CodexExports, CodexLaunchLookup, SERVICE_TAG_KEY};
use crate::driver::codex::telemetry::placement::refuse_unplaced;
use crate::driver::codex::telemetry::read_unix_time_ms;
use crate::pricing::receiver::bearers::TelemetryHolderId;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader};
use crate::record_readers::is_digits;

impl CodexExports {
    // Hands each completed response `resource_logs` states to the drain, when the resource
    // carries the tag of `holder`'s launch, whose token the export presented, and marks that
    // launch exporting. A resource whose tag is absent, unreadable or another launch's is refused
    // once under the launch's account; the responses of a launch whose service is gone are each
    // refused, naming their thread.
    fn read_resource_logs(&self, holder: TelemetryHolderId, resource_logs: &ResourceLogs) {
        let tag = resource_logs
            .resource
            .as_ref()
            .and_then(|resource| find_attribute(&resource.attributes, SERVICE_TAG_KEY))
            .and_then(|value| {
                if let Value::StringValue(text) = value
                    && is_digits(text)
                {
                    text.parse::<u64>().ok()
                } else {
                    None
                }
            });
        let (read, tracker) = match self.export_read(holder, tag) {
            CodexLaunchLookup::Read(read, tracker) => (read, tracker),
            CodexLaunchLookup::OtherTag(service) => {
                let provider_account_id = service
                    .upgrade()
                    .and_then(|service| service.provider_account_id());
                RecordRefusal {
                    field: SERVICE_TAG_KEY,
                    reason: "its resource names no launch its token was minted for",
                }
                .report(provider_account_id.as_ref());
                return;
            }
            CodexLaunchLookup::Gone => {
                refuse_each(resource_logs, "the launch that sent it has ended");
                return;
            }
        };
        tracker.export_arrived();
        let Some(service) = read.service.upgrade() else {
            refuse_each(resource_logs, "the service that sent it has ended");
            return;
        };
        let arrived_at = Instant::now();
        let arrived_at_ms = read_unix_time_ms();
        let current_account = service.provider_account_id();
        for mut response in read_codex_completed_responses(resource_logs, current_account.as_ref())
        {
            // The account its turn ran on, read by the time Codex observed it; one carrying no
            // time is read at its export's arrival.
            let ran_at_ms = match response.observed_at_ms {
                0 => arrived_at_ms,
                observed_at_ms => observed_at_ms,
            };
            response.provider_account_id = service.account_at(ran_at_ms);
            self.offer(CodexExportItem::Response {
                service: read.service.clone(),
                launch: read.placement.clone(),
                response: Box::new(response),
                arrived_at,
                export_number: read.export_number,
            });
        }
        self.offer(CodexExportItem::Retry {
            service: read.service,
            launch: read.placement,
            export_number: read.export_number,
        });
    }
}

// Refuses each completed response `resource_logs` states, naming its thread and `reason`, with no
// account, since no live service of the export's launch reads one.
fn refuse_each(resource_logs: &ResourceLogs, reason: &str) {
    for response in read_codex_completed_responses(resource_logs, None) {
        refuse_unplaced(&response.conversation_id, None, reason);
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
