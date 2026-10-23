//! A session's routing band: its frame router, usage accountant and terminal gate, kept together on
//! the session's task so no frame routes to an unmetered conversation. The session's conversation
//! is bound at each establishment; each notification is then routed, its usage metered, its
//! context window read, a compaction wait settled on its boundary, a helper's child run started
//! and ended, and every frame the router keeps handed to the frame delivery.

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::context_window::ContextWindowSource;
use tokio::time::Instant;

use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::compaction::read_codex_compaction_boundary_position;
use crate::provider::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::provider::driver::codex::delivery::frames::{CodexFrameDelivery, CodexFrameDispatch};
use crate::provider::driver::codex::event_normalizer::{
    CODEX_THREAD_COMPACTED_METHOD, CODEX_THREAD_STARTED_METHOD, CODEX_THREAD_TOKEN_USAGE_METHOD,
    CODEX_TURN_COMPLETED_METHOD, classify_codex_frame_family_for_routing,
};
use crate::provider::driver::codex::service::supervisor::routing::{
    read_codex_child_thread_announcement, read_codex_frame_thread_id,
};
use crate::provider::driver::codex::session::state::{
    CODEX_THREAD_FRAME_ROUTER_CONFIG, CodexSessionRecord,
};
use crate::provider::driver::codex::token_usage::read_codex_token_usage;
use crate::provider::driver::codex::transport::connection::read_codex_object;
use crate::provider::driver::codex::turn_evidence::CodexTurnStatus;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::terminal_emission_gate::TerminalEmissionGate;
use crate::provider::thread_frame_router::{
    ChildRegistrationResult, ChildSpendAttribution, RoutableProviderFrame, ThreadFrameFamilyClass,
    ThreadFrameRoute, ThreadFrameRouter,
};
use crate::provider::usage_delta_accountant::{
    CumulativeUsageReading, MeteredUsageDelta, ThreadBaseEstablishment, UsageAxisCounts,
    UsageDeltaAccountant, WindowTelemetry, derive_window_telemetry,
};

/// One notification as the frame router sees it, kept whole so a held frame can be delivered once
/// its conversation registers.
#[derive(Clone, Debug)]
pub(crate) struct CodexRoutableFrame {
    method: String,
    family_class: ThreadFrameFamilyClass,
    thread_id: Option<String>,
    params: Box<RawValue>,
}

impl CodexRoutableFrame {
    fn read(method: String, params: Box<RawValue>) -> Self {
        Self {
            family_class: classify_codex_frame_family_for_routing(&method),
            thread_id: read_codex_frame_thread_id(&method, &params),
            method,
            params,
        }
    }
}

impl RoutableProviderFrame for CodexRoutableFrame {
    fn raw_wire_type(&self) -> &str {
        &self.method
    }

    fn family_class(&self) -> ThreadFrameFamilyClass {
        self.family_class
    }

    fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }
}

/// What the session's own conversation fills of its context window, read off one usage frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexContextWindowReading {
    /// The conversation the reading is for.
    pub(crate) thread_id: String,
    /// The turn the frame names, if it names one.
    pub(crate) turn_id: Option<String>,
    /// The last request's total against the usable window Codex reports.
    pub(crate) window: WindowTelemetry,
    /// The last request's counts.
    pub(crate) breakdown: UsageAxisCounts,
}

/// What routing one notification produced for the session's task to apply: each delivered frame's
/// dispatch in delivery order, the spend it metered and the context window it read.
#[derive(Default)]
pub(crate) struct CodexRoutedFrames {
    /// The dispatch of each frame handed to the frame delivery, in the order it was delivered.
    pub(crate) dispatches: Vec<CodexFrameDispatch>,
    /// The usage deltas metered, each on its own conversation.
    pub(crate) metered_usage: Vec<MeteredUsageDelta>,
    /// The session conversation's context-window readings.
    pub(crate) context_windows: Vec<CodexContextWindowReading>,
}

/// One session's frame router, usage accountant and terminal gate, kept on its task beside its
/// record; the gate outlives each record, since a close covers whichever run is in flight.
pub(crate) struct CodexSessionRouting {
    router: ThreadFrameRouter<CodexRoutableFrame>,
    accountant: UsageDeltaAccountant,
    gate: TerminalEmissionGate,
    pending_compactions: PendingCompactionRegistry,
}

impl CodexSessionRouting {
    /// An empty band for one session, settling compaction waits through `pending_compactions`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's task makes its routing band as the session is created"
        )
    )]
    pub(crate) fn new(pending_compactions: PendingCompactionRegistry) -> Self {
        Self {
            router: ThreadFrameRouter::new(
                DESCRIPTOR.provider_id(),
                CODEX_THREAD_FRAME_ROUTER_CONFIG,
            ),
            accountant: UsageDeltaAccountant::new(DESCRIPTOR.provider_id()),
            gate: TerminalEmissionGate::new(),
            pending_compactions,
        }
    }

    /// The session's terminal gate, which its close signals before Codex is asked to stop.
    #[expect(
        dead_code,
        reason = "the Codex session's close signals its intended close on the gate"
    )]
    pub(crate) fn gate(&mut self) -> &mut TerminalEmissionGate {
        &mut self.gate
    }

    /// Binds the session's conversation `thread_id` at an establishment, its usage based as
    /// `establishment` says, and delivers the frames that waited for it. Bases come first, since a
    /// released usage frame meters at once; binding replaces the session's conversation, which is
    /// how a rewind retires the old one.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's create, resume and rewind bind their \
                conversation through it"
        )
    )]
    pub(crate) async fn bind_session_thread(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        thread_id: String,
        establishment: ThreadBaseEstablishment,
    ) -> CodexRoutedFrames {
        self.accountant
            .establish_thread(thread_id.clone(), establishment);
        let released = self.router.register_session_thread(thread_id);
        let mut routed = CodexRoutedFrames::default();
        for frame in released {
            self.route_frame(delivery, record, &frame, &mut routed)
                .await;
        }
        routed
    }

    /// Moves the session's conversation from `pre_fork_thread_id` onto its fork
    /// `forked_thread_id`, and delivers the frames that waited for the fork. The fork's usage is
    /// based on what was metered on the conversation it left, the only key that spend exists
    /// under, and that conversation's base is let go.
    pub(crate) async fn move_session_thread(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        forked_thread_id: String,
        pre_fork_thread_id: &str,
    ) -> CodexRoutedFrames {
        let prior_emitted_cumulative = self
            .accountant
            .base_registers(pre_fork_thread_id)
            .unwrap_or_default();
        let routed = self
            .bind_session_thread(
                delivery,
                record,
                forked_thread_id,
                ThreadBaseEstablishment::Resume {
                    prior_emitted_cumulative,
                },
            )
            .await;
        self.accountant.release_thread(pre_fork_thread_id);
        routed
    }

    /// Whether the session's routing meters `thread_id` already: its conversation's or a
    /// helper's, so a fork that names it started no new conversation.
    pub(crate) fn is_metered_thread(&self, thread_id: &str) -> bool {
        self.accountant.has_thread(thread_id)
    }

    /// Whether `thread_id` is one of the session's helpers.
    pub(crate) fn is_helper_thread(&self, thread_id: &str) -> bool {
        self.router.child_attribution_for(thread_id).is_some()
    }

    /// Routes one notification of the session and delivers what it releases, a helper's
    /// announcement registering the helper before the announcement itself is routed. Never fails:
    /// each delivery reports its own failure.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's task routes each frame of its queue through it"
        )
    )]
    pub(crate) async fn route_notification(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        method: String,
        params: Box<RawValue>,
    ) -> CodexRoutedFrames {
        let mut routed = CodexRoutedFrames::default();
        if method == CODEX_THREAD_STARTED_METHOD
            && let Some(announcement) = read_codex_child_thread_announcement(&params)
        {
            let parent_thread_id = announcement.declared_parent_thread_id.clone();
            if let ChildRegistrationResult::Registered {
                child_thread_id,
                attribution,
                released_frames,
            } = self.router.register_child_thread(announcement)
            {
                self.start_registered_child(
                    delivery,
                    record,
                    &child_thread_id,
                    parent_thread_id.as_deref(),
                    &attribution,
                )
                .await;
                for frame in released_frames {
                    self.route_frame(delivery, record, &frame, &mut routed)
                        .await;
                }
            }
        }
        let frame = CodexRoutableFrame::read(method, params);
        self.route_frame(delivery, record, &frame, &mut routed)
            .await;
        routed
    }

    // A helper registered once: its usage based at zero and, for a subagent, its child run
    // started. A repeated announcement keeps the base, since re-basing would meter reported spend
    // again, and starts nothing, since a second start would show the helper twice.
    async fn start_registered_child(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        child_thread_id: &str,
        parent_thread_id: Option<&str>,
        attribution: &ChildSpendAttribution,
    ) {
        if self.accountant.has_thread(child_thread_id) {
            report(
                record,
                DriverDiagnosticKind::ThreadDuplicateChildAnnouncement,
                Some(CODEX_THREAD_STARTED_METHOD),
                "duplicate child-thread announcement for an already-registered child; usage base \
                 retained and no second started emission",
                [("childThreadId", Value::from(child_thread_id))],
            );
            return;
        }
        self.accountant
            .establish_thread(child_thread_id.to_owned(), ThreadBaseEstablishment::Fresh);
        // An internal helper, a compaction conversation, has no subagent of its own.
        if let (ChildSpendAttribution::Subagent { subagent_id }, Some(parent_thread_id)) =
            (attribution, parent_thread_id)
        {
            delivery
                .start_child(record, child_thread_id, parent_thread_id, subagent_id)
                .await;
        }
    }

    // Applies the router's decision to one frame: the session's own and connection-wide frames
    // meter, settle a compaction and deliver; a helper's usage only meters; a helper's ask and
    // rows deliver on its own identity; a held or quarantined frame the router already reported.
    async fn route_frame(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        frame: &CodexRoutableFrame,
        routed: &mut CodexRoutedFrames,
    ) {
        let route = self.router.route_frame(frame, Instant::now());
        match route {
            ThreadFrameRoute::Project | ThreadFrameRoute::RouteConnectionScoped => {
                // Metered first, so no cumulative counter is passed on as a turn's own.
                let usage = self.meter_usage_frame(record, frame, routed);
                // Only the session's own conversation fills its meter.
                if let Some(usage) = usage
                    && route == ThreadFrameRoute::Project
                {
                    routed
                        .context_windows
                        .extend(read_context_window(&usage, &frame.params));
                }
                self.observe_compaction_boundary(record, frame);
                self.complete_child_on_terminal(delivery, record, frame)
                    .await;
                self.deliver(delivery, record, frame, route, routed).await;
            }
            ThreadFrameRoute::CarveOutUsage { .. } => {
                self.meter_usage_frame(record, frame, routed);
            }
            ThreadFrameRoute::CarveOutInteractiveRequest { .. } => {
                // The parent's pipeline on the helper's own identity; dropping it would hang the
                // helper.
                self.deliver(delivery, record, frame, route, routed).await;
            }
            ThreadFrameRoute::ChildTranscript { .. } => {
                // A helper's rows go on its child run, which its last turn's end then closes.
                self.deliver(delivery, record, frame, route, routed).await;
                self.complete_child_on_terminal(delivery, record, frame)
                    .await;
            }
            ThreadFrameRoute::HeldPendingRegistration | ThreadFrameRoute::Quarantined => {}
        }
    }

    // Meters a usage frame and answers its reading; `None` for any other frame or no reading. A
    // reading that cannot be read is reported, since a silent drop is spend no receipt shows.
    fn meter_usage_frame(
        &mut self,
        record: &CodexSessionRecord,
        frame: &CodexRoutableFrame,
        routed: &mut CodexRoutedFrames,
    ) -> Option<CumulativeUsageReading> {
        if frame.method != CODEX_THREAD_TOKEN_USAGE_METHOD {
            return None;
        }
        let Some(reading) = read_codex_token_usage(&frame.params) else {
            report(
                record,
                DriverDiagnosticKind::UsageAxisReadingRejected,
                Some(CODEX_THREAD_TOKEN_USAGE_METHOD),
                "the provider's token-usage notification carried no readable cumulative \
                 breakdown; nothing was metered for this reading",
                [("threadId", Value::from(frame.thread_id.clone()))],
            );
            return None;
        };
        routed
            .metered_usage
            .extend(self.accountant.meter_reading(reading.clone()));
        Some(reading)
    }

    // Settles a compaction wait on `thread/compacted`, keyed on the frame's own conversation,
    // since the record's has moved on at a rewind; an unarmed key settles nothing.
    fn observe_compaction_boundary(&self, record: &CodexSessionRecord, frame: &CodexRoutableFrame) {
        if frame.method != CODEX_THREAD_COMPACTED_METHOD {
            return;
        }
        let Some(thread_id) = &frame.thread_id else {
            return;
        };
        self.pending_compactions.observe_boundary(
            &codex_compaction_wait_key(record, thread_id),
            read_codex_compaction_boundary_position(&frame.params),
        );
    }

    // Lets go of a helper whose turn ended: its router entry and usage base, and for a subagent
    // its child run.
    async fn complete_child_on_terminal(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        frame: &CodexRoutableFrame,
    ) {
        if frame.method != CODEX_TURN_COMPLETED_METHOD || !is_terminal_turn(&frame.params) {
            return;
        }
        let Some(thread_id) = &frame.thread_id else {
            return;
        };
        let is_subagent = matches!(
            self.router.child_attribution_for(thread_id),
            Some(ChildSpendAttribution::Subagent { .. })
        );
        if !self.router.complete_child_thread(thread_id) {
            return;
        }
        self.accountant.release_thread(thread_id);
        if is_subagent {
            delivery
                .complete_child(record, thread_id, &frame.params)
                .await;
        }
    }

    async fn deliver(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        frame: &CodexRoutableFrame,
        route: ThreadFrameRoute,
        routed: &mut CodexRoutedFrames,
    ) {
        let dispatch = delivery
            .deliver(record, &mut self.gate, &frame.method, &frame.params, route)
            .await;
        routed.dispatches.push(dispatch);
    }
}

/// The members of a usage frame the window reading takes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextWindowFrame {
    token_usage: Option<ContextWindowUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextWindowUsage {
    model_context_window: Option<u64>,
}

// The last request's total against the usable window the frame reports; a frame missing either
// count gives no reading, never a guessed figure.
fn read_context_window(
    usage: &CumulativeUsageReading,
    params: &RawValue,
) -> Option<CodexContextWindowReading> {
    let window_max_tokens = read_codex_object::<ContextWindowFrame>(params.get())?
        .token_usage?
        .model_context_window
        .filter(|window| *window > 0)?;
    let breakdown = usage.declared_per_turn?;
    let window_used_tokens = breakdown.total?;
    Some(CodexContextWindowReading {
        thread_id: usage.thread_id.clone(),
        turn_id: usage.named_turn_id.clone(),
        window: derive_window_telemetry(
            ContextWindowSource::ProviderReported,
            Some(window_used_tokens),
            Some(window_max_tokens),
            false,
        ),
        breakdown,
    })
}

/// The members of `turn/completed` the terminal check reads.
#[derive(Deserialize)]
struct CompletedTurnFrame {
    turn: Option<CompletedTurnStatus>,
}

#[derive(Deserialize)]
struct CompletedTurnStatus {
    status: Option<String>,
}

// Whether a `turn/completed` carries a status that ends its turn; a word Codex does not send does
// not.
fn is_terminal_turn(params: &RawValue) -> bool {
    read_codex_object::<CompletedTurnFrame>(params.get())
        .and_then(|frame| frame.turn?.status)
        .and_then(|status| CodexTurnStatus::read(&status))
        .is_some_and(CodexTurnStatus::is_terminal)
}

// Reports one routing diagnostic about the session.
fn report<const FIELDS: usize>(
    record: &CodexSessionRecord,
    kind: DriverDiagnosticKind,
    raw_wire_type: Option<&str>,
    disposition_reason: &str,
    details: [(&str, Value); FIELDS],
) {
    let mut details: Map<String, Value> = details
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
    details.insert(
        "sessionId".to_owned(),
        Value::from(record.session_id.to_string()),
    );
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: record.provider_account_id.clone(),
        kind,
        raw_wire_type: raw_wire_type.map(str::to_owned),
        disposition_reason: disposition_reason.to_owned(),
        details,
    });
}
