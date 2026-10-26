//! The daemon diagnostic channel the provider drivers and the run engine route to: the closed set
//! of diagnostic kinds, the record each one carries, and the one emission that lands a record on
//! the service log with its counter's name. These are diagnostics for the person, never stored
//! session events; a frame that reaches this channel is never silently dropped.

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use strum::IntoStaticStr;

/// The closed set of diagnostic kinds; each names its counter, so a kind is never unmetered, and
/// converts to its lowerCamelCase name on the log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
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
    /// (that would re-meter the child's whole spend) and to emit a second `agent.subagent.started`.
    ThreadDuplicateChildAnnouncement,
    /// A capability re-declaration failed or missed its liveness deadline.
    CapabilityRefreshFailed,
    /// The provider's stored capability reading could not be rebuilt at the daemon's start, so
    /// its gated calls wait for the first refresh.
    StoredCapabilitiesUnreadable,
    /// A successful detection read withdrew a flag the matrix declares because this build lacks
    /// the surface; the failed-read kind does not cover a capability quietly lost between
    /// refreshes.
    CapabilityFlagWithdrawn,
    /// A Settings row's value could not be applied at the daemon's start, so the provider runs on
    /// what it had.
    SettingsRowApplyFailed,
    /// An invocation reached the host with no evaluation seam registered; answered refused, never
    /// completed without the policy check and never left unanswered.
    CallbackToolSeamAbsent,
    /// The registry was withheld at spawn because the daemon could not guarantee every invocation
    /// would be adjudicated.
    CallbackToolRegistryWithheld,
    /// An unregistered tool, arguments the route's check refused, or a superseded registry;
    /// answered `failed` without reaching the approval pipeline.
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
    /// An optional member of a model catalog row could not be read, so the row reads it as
    /// absent; the row and the rest of the catalog stand.
    ModelCatalogMemberUnreadable,
    /// A message's final text did not begin with the text already streamed as its pieces, which
    /// stand.
    StreamedTextDiverged,
    /// The provider cut a response short after some of its blocks were streamed: what still
    /// waited is dropped, and the pieces already stored stay.
    StreamedBlocksAbandoned,
}

impl DriverDiagnosticKind {
    /// The kind's counter name, dotted lowerCamelCase segments as a wire name is: under `driver`
    /// for a kind a driver records (`driver.reorderBuffer.pairingTimeout`), under `run` for one the
    /// run engine records (`run.lateEvent.absorbed`).
    pub(crate) const fn counter_name(self) -> &'static str {
        match self {
            Self::UnmappedWireKind => "driver.normalize.unmappedWireKind",
            Self::ReorderBufferOverflow => "driver.reorderBuffer.overflow",
            Self::ToolPairingTimeout => "driver.reorderBuffer.pairingTimeout",
            Self::ReorderSeenInitiationEvicted => "driver.reorderBuffer.seenInitiationEvicted",
            Self::UsageDeltaFloorHit => "driver.usageDelta.floorHit",
            Self::UsageAxisReadingRejected => "driver.usageDelta.axisReadingRejected",
            Self::UsageResumeBaseUnavailable => "driver.usageDelta.resumeBaseUnavailable",
            Self::UsageCrossCheckMismatch => "driver.usageDelta.crossCheckMismatch",
            Self::UsageContainmentIdentityUnconfirmed => "driver.usageDelta.containmentUnconfirmed",
            Self::ThreadFrameQuarantined => "driver.threadRouter.quarantined",
            Self::ThreadQuarantineShed => "driver.threadRouter.quarantineShed",
            Self::ThreadPendingHoldShed => "driver.threadRouter.pendingHoldShed",
            Self::ThreadRegistrationRefused => "driver.threadRouter.registrationRefused",
            Self::ThreadDuplicateChildAnnouncement => {
                "driver.threadRouter.duplicateChildAnnouncement"
            }
            Self::CapabilityRefreshFailed => "driver.capabilityRefresh.declarationFailed",
            Self::StoredCapabilitiesUnreadable => "driver.capabilityRefresh.storedUnreadable",
            Self::CapabilityFlagWithdrawn => "driver.capabilityRefresh.flagWithdrawn",
            Self::SettingsRowApplyFailed => "driver.settingsRow.applyFailed",
            Self::CallbackToolSeamAbsent => "driver.callbackTool.seamAbsent",
            Self::CallbackToolRegistryWithheld => "driver.callbackTool.registryWithheld",
            Self::CallbackToolInvocationRefused => "driver.callbackTool.invocationRefused",
            Self::CallbackToolRegistrySuperseded => "driver.callbackTool.registrySuperseded",
            Self::CallbackToolRegistryReleaseIgnored => {
                "driver.callbackTool.registryReleaseIgnored"
            }
            Self::CallbackToolActivityRecordFailed => "driver.callbackTool.activityRecordFailed",
            Self::SubagentDefinitionFieldWithheld => "driver.subagent.definitionFieldWithheld",
            Self::SupersededRunReportFailed => "driver.session.supersededRunReportFailed",
            Self::CompactionWaitTerminal => "driver.compaction.waitTerminal",
            Self::ProviderCommandEntryRejected => "driver.providerCommands.entryRejected",
            Self::OutputSpeedStateRejected => "driver.outputSpeed.stateRejected",
            Self::OutputSpeedApplyRefused => "driver.outputSpeed.applyRefused",
            Self::McpTaskHandleWriteRefused => "driver.mcpTaskHandle.writeRefused",
            Self::McpTaskHandleWriteFailed => "driver.mcpTaskHandle.writeFailed",
            Self::LateEventAbsorbed => "run.lateEvent.absorbed",
            Self::EpochAssociationEvicted => "run.epoch.associationEvicted",
            Self::ProviderRestarted => "driver.process.restarted",
            Self::ProviderCrashLoop => "driver.process.crashLoop",
            Self::ProcessReportFailed => "driver.process.reportFailed",
            Self::DeliveryDispatchFailed => "driver.delivery.dispatchFailed",
            Self::ControlFrameMalformed => "driver.control.frameMalformed",
            Self::ControlAnswerFailed => "driver.control.answerFailed",
            Self::ProviderFrameOversized => "driver.process.frameOversized",
            Self::ControlOnlyReadFailed => "driver.controlOnly.readFailed",
            Self::ModelWindowReadFailed => "driver.modelWindow.readFailed",
            Self::ModelCatalogMemberUnreadable => "driver.modelCatalog.memberUnreadable",
            Self::StreamedTextDiverged => "driver.streamedText.diverged",
            Self::StreamedBlocksAbandoned => "driver.streamedText.blocksAbandoned",
        }
    }
}

/// One daemon diagnostic the person sees. `raw_wire_type` is `None` when no single frame caused
/// it, else untrusted provider output that never reaches anything that executes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DriverDiagnosticRecord {
    /// The provider the record is about.
    pub(crate) provider: ProviderId,
    /// The account the record is about, which its counter is also counted by; `None` on the
    /// machine's default home.
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

/// How many distinct diagnostics one provider connection logs; their wire types are named by the
/// provider, so the set of those already logged is bounded.
const ONCE_REPORTED_DIAGNOSTICS_LIMIT: usize = 32;

/// The diagnostics one provider connection has logged, by kind and wire type, so one that keeps
/// arriving (an unmapped notification on every frame) is logged once, not once per frame. Past
/// the limit one last record says later ones go unlogged.
#[derive(Debug, Default)]
pub(crate) struct OnceReportedDiagnostics {
    /// The kind and wire type of each diagnostic logged on this connection.
    reported: HashSet<(DriverDiagnosticKind, String)>,
    /// Whether the record saying the limit was reached has been logged.
    is_limit_reported: bool,
}

impl OnceReportedDiagnostics {
    /// Logs `record` the first time its kind arrives with its `raw_wire_type` on this connection;
    /// one already logged is not logged again. The first new one past the limit logs one record
    /// saying so, and later ones log nothing. Answers whether `record` itself was logged.
    pub(crate) fn report(&mut self, record: &DriverDiagnosticRecord) -> bool {
        let key = (
            record.kind,
            record.raw_wire_type.clone().unwrap_or_default(),
        );
        if self.reported.contains(&key) {
            return false;
        }
        if self.reported.len() < ONCE_REPORTED_DIAGNOSTICS_LIMIT {
            self.reported.insert(key);
            emit_driver_diagnostic(record);
            return true;
        }
        if !self.is_limit_reported {
            self.is_limit_reported = true;
            let mut details = Map::new();
            details.insert(
                "reportedDiagnostics".to_owned(),
                json!(ONCE_REPORTED_DIAGNOSTICS_LIMIT),
            );
            emit_driver_diagnostic(&DriverDiagnosticRecord {
                disposition_reason: format!(
                    "{ONCE_REPORTED_DIAGNOSTICS_LIMIT} diagnostics already reported on this \
                     connection; later new ones on it are not reported"
                ),
                details,
                ..record.clone()
            });
        }
        false
    }
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
    use tracing::subscriber::DefaultGuard;
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

    /// The fields of every log event a test thread raises, each as text.
    #[derive(Clone, Default)]
    pub(crate) struct RecordedEvents(Arc<Mutex<Vec<HashMap<String, String>>>>);

    impl RecordedEvents {
        /// Runs `test` with this recorder as the thread's subscriber.
        pub(crate) fn record_during(&self, test: impl FnOnce()) {
            let _recording = self.record_until_dropped();
            test();
        }

        /// Makes this recorder the thread's subscriber until the guard drops, so the tasks of a
        /// current-thread runtime record across awaits.
        pub(crate) fn record_until_dropped(&self) -> DefaultGuard {
            tracing::subscriber::set_default(tracing_subscriber::registry().with(self.clone()))
        }

        /// The counter of each diagnostic recorded, in order.
        pub(crate) fn counters(&self) -> Vec<String> {
            self.fields_where(|_fields| true, "counter")
        }

        /// The message of each event recorded, in order.
        pub(crate) fn messages(&self) -> Vec<String> {
            self.fields_where(|_fields| true, "message")
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

#[cfg(test)]
mod tests {
    use serde_json::Map;
    use sidekicks_contracts::provider::id::ProviderId;

    use super::{
        DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics, RecordedEvents,
    };

    fn unmapped(wire_kind: &str) -> DriverDiagnosticRecord {
        DriverDiagnosticRecord {
            provider: ProviderId::new("codex".to_owned()).expect("a valid provider id"),
            provider_account_id: None,
            kind: DriverDiagnosticKind::UnmappedWireKind,
            raw_wire_type: Some(wire_kind.to_owned()),
            disposition_reason: "unmapped".to_owned(),
            details: Map::new(),
        }
    }

    // A kind that keeps arriving logs once; the 33rd distinct kind logs the one record saying the
    // limit was reached, and nothing after it logs.
    #[test]
    fn a_diagnostic_is_reported_once_per_kind_and_the_set_stops_at_its_limit() {
        let recorded = RecordedEvents::default();
        let mut reports = OnceReportedDiagnostics::default();
        let mut logged = Vec::new();
        recorded.record_during(|| {
            logged.push(reports.report(&unmapped("thread/new")));
            logged.push(reports.report(&unmapped("thread/new")));
            for index in 1..32 {
                logged.push(reports.report(&unmapped(&format!("kind/{index}"))));
            }
            logged.push(reports.report(&unmapped("kind/33")));
            logged.push(reports.report(&unmapped("kind/34")));
            logged.push(reports.report(&unmapped("thread/new")));
        });

        let expected: Vec<bool> = [true, false]
            .into_iter()
            .chain([true; 31])
            .chain([false, false, false])
            .collect();
        assert_eq!(logged, expected);
        let wire_kinds = recorded.field_on("driver.normalize.unmappedWireKind", "raw_wire_type");
        assert_eq!(wire_kinds.len(), 33);
        assert_eq!(wire_kinds.first().map(String::as_str), Some("thread/new"));
        assert_eq!(wire_kinds.last().map(String::as_str), Some("kind/33"));
        let reasons = recorded.field_on("driver.normalize.unmappedWireKind", "disposition_reason");
        assert!(
            reasons
                .last()
                .is_some_and(|reason| reason.contains("not reported")),
            "{reasons:?}"
        );
    }
}
