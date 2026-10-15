//! The daemon diagnostic channel the provider drivers and the run engine route to: the closed set
//! of diagnostic kinds, the record each one carries, and the one emission that lands a record on
//! the service log with its counter's name. These are diagnostics for the person, never stored
//! session events; a frame that reaches this channel is never silently dropped.

use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::name::ProviderName;
use strum::IntoStaticStr;

/// The closed set of diagnostic kinds; each names its counter, so a kind is never unmetered, and
/// converts to its snake-case name on the log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum DriverDiagnosticKind {
    /// A wire kind outside the pinned set, or one with no defined session event type.
    UnmappedWireKind,
    /// The reorder buffer passed its cap and flushed what it held.
    ReorderBufferOverflow,
    /// A tool call's start or completion waited past the pairing timeout for its partner.
    ToolPairingTimeout,
    /// The capped seen-initiation set evicted its oldest entry, which changes how a later
    /// completion for that call routes.
    ReorderSeenInitiationEvicted,
    /// A decrease on a cumulative axis is floored at zero, never emitted as negative spend.
    UsageDeltaFloorHit,
    /// A usage member that is not a non-negative integer was rejected where the driver read it,
    /// before it could reach a base register and poison every later delta.
    UsageAxisReadingRejected,
    /// The prior-emitted sum for a resume or rewind was unobtainable, so the base starts at zero
    /// and the first reading re-meters the pre-resume total. A reader answering with nothing is
    /// not this.
    UsageResumeBaseUnavailable,
    /// A wire-declared per-turn figure disagrees with the derived interval; recorded, never
    /// substituted.
    UsageCrossCheckMismatch,
    /// A token breakdown satisfying no containment identity is emitted unsubtracted, so the
    /// overstatement surfaces instead of a silent understatement.
    UsageContainmentIdentityUnconfirmed,
    /// The router refused a frame with an absent or unrecognized identity.
    ThreadFrameQuarantined,
    /// The bounded quarantine buffer shed its oldest frame.
    ThreadQuarantineShed,
    /// A present but unregistered identity whose registration missed the declared timeout.
    ThreadPendingHoldShed,
    /// A child announcement with no recognized parent linkage; recognition follows declared
    /// lineage, never arrival order.
    ThreadRegistrationRefused,
    /// A second announcement for a child whose usage base exists. The driver declines to re-base
    /// (that would re-meter the child's whole spend) and to emit a second `subagent.started`.
    ThreadDuplicateChildAnnouncement,
    /// A capability re-declaration failed or missed its liveness deadline.
    CapabilityRefreshFailed,
    /// A successful detection read withdrew a flag the matrix declares because this build lacks
    /// the surface; the failed-read kind does not cover a capability quietly lost between
    /// refreshes.
    CapabilityFlagWithdrawn,
    /// An invocation or provider ask reached the host with no evaluation seam registered; answered
    /// refused, never completed without the policy check and never left unanswered.
    CallbackToolSeamAbsent,
    /// The registry was withheld at spawn because the daemon could not guarantee every invocation
    /// would be adjudicated.
    CallbackToolRegistryWithheld,
    /// An unregistered tool, arguments the schema rejects, or a superseded registry; answered
    /// `failed` without reaching the approval pipeline.
    CallbackToolInvocationRefused,
    /// A resume or relaunch installed a second registry for the session; explains the superseded
    /// spawn's refusals.
    CallbackToolRegistrySuperseded,
    /// A superseded spawn's teardown ran after replacement; honoring it would tear down the live
    /// registry.
    CallbackToolRegistryReleaseIgnored,
    /// Recording an invocation that was already answered failed; the answer stands and only the
    /// activity row is missing.
    CallbackToolActivityRecordFailed,
    /// A subagent definition the daemon cannot boundary-mediate is disabled at spawn.
    SubagentDefinitionFieldWithheld,
    /// A rewind or resume superseded a run's turn and reporting the run's end failed; the
    /// supersession stands, but the failure the person sees may not have landed.
    SupersededRunReportFailed,
    /// The wait for the typed compaction frame ended without it, because the binding stopped
    /// being live. Never emitted when compaction applied.
    CompactionWaitTerminal,
    /// A provider command entry broke the contract's bounds; it is dropped and its siblings are
    /// unaffected.
    ProviderCommandEntryRejected,
    /// A declared output-speed state broke the bounds, so the binding reads as unobserved until
    /// the provider declares another. Details carry the field and lengths, never untrusted values.
    OutputSpeedStateRejected,
    /// The provider refused the output-speed level the driver applied, so the process runs on the
    /// level it held; the run's declared state reports which.
    OutputSpeedApplyRefused,
    /// A choice set with an unreadable option or no readable admissible one. The ask still
    /// reaches the person as free text; only the choice set is lost.
    InteractiveRequestOptionSetDropped,
    /// A receiver-generated task handle could not be stored on its receipt row (over a column
    /// bound, ill-formed Unicode, absent row, or a different handle; the disposition reason names
    /// which). The call stays halted after a restart, never run again, and the handle is never
    /// logged.
    McpTaskHandleWriteRefused,
    /// The database refused a storable handle: a local fault, kept apart from the remote-caused
    /// refusal. The disposition reason carries the SQLite result code.
    McpTaskHandleWriteFailed,
    /// A provider delivery the run engine absorbed instead of appending: a lifecycle event or ask
    /// from the execution before an undo's cut, or a lifecycle event for a run that had already
    /// ended.
    LateEventAbsorbed,
    /// A binding's capped set of operation associations evicted its oldest entry, so a late
    /// delivery of that operation is attributed to the execution before the last cut, never to
    /// the current one.
    EpochAssociationEvicted,
    /// A provider process or service that ended on its own was started again; names the account
    /// and each conversation it resumed, and counts per account, so one that keeps dying shows.
    ProviderRestarted,
    /// The crash that filled the crash window ended the automatic restarts; carries how it exited.
    ProviderCrashLoop,
    /// Reporting a process's exit, a restart or a build move, or pointing a binding back after a
    /// failed rewind, failed with no caller left to tell.
    ProcessReportFailed,
    /// A delivery the run engine or a registered port refused or failed to take.
    DeliveryDispatchFailed,
    /// A control frame from the provider with no request id or subtype, so nothing could take it.
    ControlFrameMalformed,
    /// Writing the daemon's answer to a provider's control request failed; the process is ended.
    ControlAnswerFailed,
    /// A provider output line passed the daemon's frame size ceiling; the process is ended.
    ProviderFrameOversized,
    /// A short control-only process's read (a command's choices, a model's reply reserve) failed;
    /// what needed it says why.
    ControlOnlyReadFailed,
    /// A provider's model catalog, or one row of it, could not be run or read; those picker rows
    /// carry no window.
    ModelWindowReadFailed,
    /// A message's final text did not begin with the text already streamed as its pieces, which
    /// stand.
    StreamedTextDiverged,
    /// The provider cut a response short after some of its blocks were streamed: what still
    /// waited is dropped, and the pieces already stored stay.
    StreamedBlocksAbandoned,
}

impl DriverDiagnosticKind {
    /// The kind's counter name, shaped `driver.<band>.<condition>`, or `run.<band>.<condition>`
    /// for a kind the run engine records.
    pub(crate) const fn counter_name(self) -> &'static str {
        match self {
            Self::UnmappedWireKind => "driver.normalize.unmapped_wire_kind",
            Self::ReorderBufferOverflow => "driver.reorder_buffer.overflow",
            Self::ToolPairingTimeout => "driver.reorder_buffer.pairing_timeout",
            Self::ReorderSeenInitiationEvicted => "driver.reorder_buffer.seen_initiation_evicted",
            Self::UsageDeltaFloorHit => "driver.usage_delta.floor_hit",
            Self::UsageAxisReadingRejected => "driver.usage_delta.axis_reading_rejected",
            Self::UsageResumeBaseUnavailable => "driver.usage_delta.resume_base_unavailable",
            Self::UsageCrossCheckMismatch => "driver.usage_delta.cross_check_mismatch",
            Self::UsageContainmentIdentityUnconfirmed => {
                "driver.usage_delta.containment_unconfirmed"
            }
            Self::ThreadFrameQuarantined => "driver.thread_router.quarantined",
            Self::ThreadQuarantineShed => "driver.thread_router.quarantine_shed",
            Self::ThreadPendingHoldShed => "driver.thread_router.pending_hold_shed",
            Self::ThreadRegistrationRefused => "driver.thread_router.registration_refused",
            Self::ThreadDuplicateChildAnnouncement => {
                "driver.thread_router.duplicate_child_announcement"
            }
            Self::CapabilityRefreshFailed => "driver.capability_refresh.declaration_failed",
            Self::CapabilityFlagWithdrawn => "driver.capability_refresh.flag_withdrawn",
            Self::CallbackToolSeamAbsent => "driver.callback_tool.seam_absent",
            Self::CallbackToolRegistryWithheld => "driver.callback_tool.registry_withheld",
            Self::CallbackToolInvocationRefused => "driver.callback_tool.invocation_refused",
            Self::CallbackToolRegistrySuperseded => "driver.callback_tool.registry_superseded",
            Self::CallbackToolRegistryReleaseIgnored => {
                "driver.callback_tool.registry_release_ignored"
            }
            Self::CallbackToolActivityRecordFailed => "driver.callback_tool.activity_record_failed",
            Self::SubagentDefinitionFieldWithheld => "driver.subagent.definition_field_withheld",
            Self::SupersededRunReportFailed => "driver.session.superseded_run_report_failed",
            Self::CompactionWaitTerminal => "driver.compaction.wait_terminal",
            Self::ProviderCommandEntryRejected => "driver.provider_commands.entry_rejected",
            Self::OutputSpeedStateRejected => "driver.output_speed.state_rejected",
            Self::OutputSpeedApplyRefused => "driver.output_speed.apply_refused",
            Self::InteractiveRequestOptionSetDropped => {
                "driver.interactive_request.option_set_dropped"
            }
            Self::McpTaskHandleWriteRefused => "driver.mcp_task_handle.write_refused",
            Self::McpTaskHandleWriteFailed => "driver.mcp_task_handle.write_failed",
            Self::LateEventAbsorbed => "run.late_event.absorbed",
            Self::EpochAssociationEvicted => "run.epoch.association_evicted",
            Self::ProviderRestarted => "driver.process.restarted",
            Self::ProviderCrashLoop => "driver.process.crash_loop",
            Self::ProcessReportFailed => "driver.process.report_failed",
            Self::DeliveryDispatchFailed => "driver.delivery.dispatch_failed",
            Self::ControlFrameMalformed => "driver.control.frame_malformed",
            Self::ControlAnswerFailed => "driver.control.answer_failed",
            Self::ProviderFrameOversized => "driver.process.frame_oversized",
            Self::ControlOnlyReadFailed => "driver.control_only.read_failed",
            Self::ModelWindowReadFailed => "driver.model_window.read_failed",
            Self::StreamedTextDiverged => "driver.streamed_text.diverged",
            Self::StreamedBlocksAbandoned => "driver.streamed_text.blocks_abandoned",
        }
    }
}

/// One daemon diagnostic the person sees. `raw_wire_type` is `None` when no single frame caused
/// it, else untrusted provider output that never reaches anything that executes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DriverDiagnosticRecord {
    /// The provider the record is about.
    pub(crate) provider: ProviderName,
    /// The account the record is about, which its counter is also counted by; `None` on the
    /// node's default home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// What happened.
    pub(crate) kind: DriverDiagnosticKind,
    /// The wire type of the frame that caused it, when one did.
    pub(crate) raw_wire_type: Option<String>,
    /// Why the frame or call was disposed of as it was.
    pub(crate) disposition_reason: String,
    /// The kind's own facts, as flat JSON values.
    pub(crate) details: Map<String, Value>,
}

/// Writes `record` to the service log as one warning, its counter name a field of its own and its
/// details one field of JSON text.
pub(crate) fn emit_driver_diagnostic(record: &DriverDiagnosticRecord) {
    let details = serde_json::to_string(&record.details)
        .expect("a map with string keys and JSON values always serializes");
    tracing::warn!(
        counter = record.kind.counter_name(),
        kind = <&str>::from(record.kind),
        provider = record.provider.as_str(),
        provider_account_id = record
            .provider_account_id
            .as_ref()
            .map(ProviderAccountId::as_str),
        raw_wire_type = record.raw_wire_type.as_deref(),
        disposition_reason = record.disposition_reason.as_str(),
        details = details.as_str(),
        "driver diagnostic"
    );
}

#[cfg(test)]
pub(crate) use recorded_events::RecordedEvents;

/// Test support: records the fields of every log event a test thread raises, so a test reads a
/// diagnostic's `counter` and other fields as the service log would carry them.
#[cfg(test)]
mod recorded_events {
    use std::collections::HashMap;
    use std::fmt::Debug;
    use std::sync::{Arc, Mutex};

    use tracing::field::{Field, Visit};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

    /// The fields of every log event a test thread raises, each as text.
    #[derive(Clone, Default)]
    pub(crate) struct RecordedEvents(Arc<Mutex<Vec<HashMap<String, String>>>>);

    impl RecordedEvents {
        /// Runs `test` with this recorder as the thread's subscriber.
        pub(crate) fn record_during(&self, test: impl FnOnce()) {
            let subscriber = tracing_subscriber::registry().with(self.clone());
            tracing::subscriber::with_default(subscriber, test);
        }

        /// The counter of each diagnostic recorded, in order.
        pub(crate) fn counters(&self) -> Vec<String> {
            self.fields_where(|_fields| true, "counter")
        }

        /// The value of `field` on each diagnostic recorded under `counter`, in order.
        pub(crate) fn field_on(&self, counter: &str, field: &str) -> Vec<String> {
            self.fields_where(
                |fields| {
                    fields
                        .get("counter")
                        .is_some_and(|recorded| recorded == counter)
                },
                field,
            )
        }

        fn fields_where(
            &self,
            is_picked: impl Fn(&HashMap<String, String>) -> bool,
            field: &str,
        ) -> Vec<String> {
            self.0
                .lock()
                .expect("no test thread panics holding the lock")
                .iter()
                .filter(|fields| is_picked(fields))
                .filter_map(|fields| fields.get(field).cloned())
                .collect()
        }
    }

    struct FieldRecorder(HashMap<String, String>);

    impl Visit for FieldRecorder {
        fn record_str(&mut self, field: &Field, value: &str) {
            self.0.insert(field.name().to_owned(), value.to_owned());
        }

        fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
            self.0.insert(field.name().to_owned(), format!("{value:?}"));
        }
    }

    impl<S: Subscriber> Layer<S> for RecordedEvents {
        fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
            let mut fields = FieldRecorder(HashMap::new());
            event.record(&mut fields);
            self.0
                .lock()
                .expect("no test thread panics holding the lock")
                .push(fields.0);
        }
    }
}
