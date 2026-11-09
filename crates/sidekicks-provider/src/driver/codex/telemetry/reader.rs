//! The reader the receiver hands each Codex export: the launch or exec its token was minted for
//! checked against the tag its resource carries, and each completed response its records state
//! stamped with the account it ran on and handed off to the drain, or for an exec collected for
//! the exec's caller.

use futures::future::{BoxFuture, ready};
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use crate::driver::codex::telemetry::completed_response::{
    RecordRefusal, find_attribute, read_codex_completed_responses,
};
use crate::driver::codex::telemetry::drain::CodexExportItem;
use crate::driver::codex::telemetry::exports::{
    CODEX_EXPORT_HAND_OFF_DEPTH, CodexExecResponses, CodexExports, CodexLaunchLookup, CodexTagKind,
};
use crate::driver::codex::telemetry::placement::refuse_unplaced;
use crate::driver::codex::telemetry::read_unix_time_ms;
use crate::pricing::receiver::bearers::TelemetryHolderId;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader};
use crate::record_readers::is_digits;

impl CodexExports {
    // Hands each completed response `resource_logs` states to the drain, when the resource
    // carries the tag of `holder`'s launch, whose token the export presented, and marks that
    // launch exporting; or collects each for `holder`'s exec, when the resource carries its tag.
    // A resource whose tag is absent, unreadable or another's is refused once under the account;
    // the responses of a launch whose service is gone are each refused, naming their thread.
    fn read_resource_logs(&self, holder: TelemetryHolderId, resource_logs: &ResourceLogs) {
        let (read, tracker) = match self.export_read(holder, read_resource_tag(resource_logs)) {
            CodexLaunchLookup::Read(read, tracker) => (read, tracker),
            CodexLaunchLookup::OtherTag(service) => {
                let provider_account_id = service
                    .upgrade()
                    .and_then(|service| service.provider_account_id());
                RecordRefusal {
                    field: CodexTagKind::Service.key(),
                    reason: "its resource names no launch its token was minted for",
                }
                .report(provider_account_id.as_ref());
                return;
            }
            CodexLaunchLookup::Exec(provider_account_id, responses) => {
                collect_exec_responses(resource_logs, &provider_account_id, &responses);
                return;
            }
            CodexLaunchLookup::ExecOtherTag(provider_account_id) => {
                RecordRefusal {
                    field: CodexTagKind::Exec.key(),
                    reason: "its resource names no exec its token was minted for",
                }
                .report(Some(&provider_account_id));
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

// The tag `resource_logs`' resource carries, of either kind; `None` where it carries none a
// reader can read.
fn read_resource_tag(resource_logs: &ResourceLogs) -> Option<(CodexTagKind, u64)> {
    let attributes = &resource_logs.resource.as_ref()?.attributes;
    [CodexTagKind::Service, CodexTagKind::Exec]
        .into_iter()
        .find_map(|kind| match find_attribute(attributes, kind.key())? {
            Value::StringValue(text) if is_digits(text) => {
                text.parse::<u64>().ok().map(|number| (kind, number))
            }
            Value::StringValue(_)
            | Value::BoolValue(_)
            | Value::IntValue(_)
            | Value::DoubleValue(_)
            | Value::ArrayValue(_)
            | Value::KvlistValue(_)
            | Value::BytesValue(_)
            | Value::StringValueStrindex(_) => None,
        })
}

// Collects each completed response `resource_logs` states into `responses`, an exec's on
// `provider_account_id`, read synchronously so the exporter's answer, which the exec's clean exit
// waits for, comes only once they are collected. One past the hand-off's depth is refused.
fn collect_exec_responses(
    resource_logs: &ResourceLogs,
    provider_account_id: &ProviderAccountId,
    responses: &CodexExecResponses,
) {
    let read = read_codex_completed_responses(resource_logs, Some(provider_account_id));
    let mut collected = lock(responses);
    for mut response in read {
        if collected.len() >= CODEX_EXPORT_HAND_OFF_DEPTH {
            refuse_unplaced(
                &response.conversation_id,
                Some(provider_account_id.clone()),
                "the exec's collected responses are full",
            );
            continue;
        }
        response.provider_account_id = Some(provider_account_id.clone());
        collected.push(response);
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
