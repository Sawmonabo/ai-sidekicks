//! A session's routing band: its frame router, usage accountant and terminal gate, kept together on
//! the session's task so no frame routes to an unmetered conversation. The session's conversation
//! is bound at each establishment; each notification is then routed, its usage metered, its
//! context window read, a compaction wait settled on its boundary, a helper's child run started
//! and ended, a tool server's startup on the session's own conversation reported to its status
//! sink, and every frame the router keeps handed to the frame delivery.

use std::collections::{HashMap, HashSet};

use futures::future::join_all;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::context_window::ContextWindowSource;
use sidekicks_contracts::mcp::server::{McpServerName, McpServerStatus};
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use tokio::time::Instant;

use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::compaction::read_codex_compaction_boundary_position;
use crate::driver::codex::delivery::children::{CodexHelperStart, read_codex_helper_thread};
use crate::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::driver::codex::delivery::frames::{CodexFrameDelivery, CodexFrameDispatch};
use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_MCP_SERVER_STARTUP_STATUS_UPDATED_METHOD,
    CODEX_THREAD_COMPACTED_METHOD, CODEX_THREAD_TOKEN_USAGE_METHOD, CODEX_TURN_COMPLETED_METHOD,
    classify_codex_frame_family_for_routing,
};
use crate::driver::codex::mcp::status_list::list_codex_mcp_server_statuses;
use crate::driver::codex::service::supervisor::routing::{
    CodexFrameThreads, CodexSpawnedHelper, read_codex_frame_threads,
};
use crate::driver::codex::session::state::{CODEX_THREAD_FRAME_ROUTER_CONFIG, CodexSessionRecord};
use crate::driver::codex::telemetry::streamed_responses::CodexStreamedResponses;
use crate::driver::codex::thread::view::CodexThreadReading;
use crate::driver::codex::token_usage::read_codex_token_usage;
use crate::driver::codex::tools::normalize_codex_mcp_server_status_notification;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::mcp_server::status::{McpServerReading, McpServerStatusProducer};
use crate::terminal_emission_gate::TerminalEmissionGate;
use crate::thread_frame_router::{
    ChildRegistrationResult, ChildSpendAttribution, ChildThreadAnnouncement, RoutableProviderFrame,
    ThreadFrameFamilyClass, ThreadFrameRoute, ThreadFrameRouter,
};
use crate::usage_delta_accountant::{
    CumulativeUsageReading, MeteredUsageDelta, ThreadBaseEstablishment, UsageAxisCounts,
    UsageDeltaAccountant, WindowTelemetry, derive_window_telemetry,
};

/// What the tool servers' startups on a session's conversation said: the round that is starting,
/// armed by its first `starting` and listed once every server it saw start has settled, and each
/// server's newest startup reading, which a list leaves as it is.
#[derive(Default)]
pub(crate) struct CodexMcpServerStartups {
    // The servers of the open round still starting; `None` between rounds.
    round: Option<HashSet<McpServerName>>,
    // Each server's newest startup reading and its text.
    readings: HashMap<McpServerName, (McpServerReading, Option<String>)>,
}

impl CodexMcpServerStartups {
    /// The servers a startup was heard for since the conversation was bound.
    pub(crate) fn server_names(&self) -> impl Iterator<Item = &McpServerName> {
        self.readings.keys()
    }

    /// Whether no startup was heard since the conversation was bound.
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.round.is_none() && self.readings.is_empty()
    }
}

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
    // The frame, with the helpers its spawn item names, read in one parse.
    fn read(method: String, params: Box<RawValue>) -> (Self, Vec<CodexSpawnedHelper>) {
        let CodexFrameThreads {
            thread_id,
            spawned_helpers,
        } = read_codex_frame_threads(&method, &params);
        let frame = Self {
            family_class: classify_codex_frame_family_for_routing(&method),
            thread_id,
            method,
            params,
        };
        (frame, spawned_helpers)
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
    /// Whether the last request is the conversation's first, its whole total being that
    /// request's; a resumed or forked conversation's total holds its history's too.
    pub(crate) is_conversation_start: bool,
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

impl CodexRoutedFrames {
    /// Appends what routing later frames produced, after what this holds.
    pub(crate) fn extend(&mut self, later: Self) {
        self.dispatches.extend(later.dispatches);
        self.metered_usage.extend(later.metered_usage);
        self.context_windows.extend(later.context_windows);
    }
}

// A helper a spawn item registered, with what its conversation's `thread/read` gave.
struct CodexRegisteredHelper {
    child_thread_id: String,
    attribution: ChildSpendAttribution,
    helper: CodexSpawnedHelper,
    reading: Option<CodexThreadReading>,
}

/// One session's frame router, usage accountant and terminal gate, kept on its task beside its
/// record, with the model each spawned or restored helper runs on; the gate outlives each record,
/// since a close covers whichever run is in flight.
pub(crate) struct CodexSessionRouting {
    router: ThreadFrameRouter<CodexRoutableFrame>,
    accountant: UsageDeltaAccountant,
    gate: TerminalEmissionGate,
    pending_compactions: PendingCompactionRegistry,
    // Each live spawned or restored helper's model by its conversation, which its usage readings
    // name.
    helper_models: HashMap<String, String>,
    // Each response the stream metered, until the export's twin claims it.
    streamed: CodexStreamedResponses,
}

impl CodexSessionRouting {
    /// An empty band for one session, settling compaction waits through `pending_compactions`.
    pub(crate) fn new(pending_compactions: PendingCompactionRegistry) -> Self {
        Self {
            router: ThreadFrameRouter::new(
                DESCRIPTOR.provider_id(),
                CODEX_THREAD_FRAME_ROUTER_CONFIG,
            ),
            accountant: UsageDeltaAccountant::new(DESCRIPTOR.provider_id()),
            gate: TerminalEmissionGate::new(),
            pending_compactions,
            helper_models: HashMap::new(),
            streamed: CodexStreamedResponses::default(),
        }
    }

    /// The session's terminal gate, which its close signals before Codex is asked to stop.
    pub(crate) fn gate(&mut self) -> &mut TerminalEmissionGate {
        &mut self.gate
    }

    /// The responses the session's stream stated, which an exported response is claimed from.
    pub(crate) fn streamed_responses(&mut self) -> &mut CodexStreamedResponses {
        &mut self.streamed
    }

    /// Binds the session's conversation `thread_id` at an establishment, its usage based as
    /// `establishment` says, and delivers the frames that waited for it. Bases come first, since a
    /// released usage frame meters at once; binding replaces the session's conversation, which is
    /// how a rewind retires the old one.
    pub(crate) async fn bind_session_thread(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        thread_id: String,
        establishment: ThreadBaseEstablishment,
    ) -> CodexRoutedFrames {
        self.accountant
            .establish_thread(thread_id.clone(), establishment);
        // A new or resumed conversation reports its servers' startups afresh.
        record.mcp_server_startups = CodexMcpServerStartups::default();
        let released = self.router.register_session_thread(thread_id);
        let mut routed = CodexRoutedFrames::default();
        for frame in released {
            self.route_frame(delivery, record, &frame, &mut routed)
                .await;
        }
        routed
    }

    /// Binds the session's conversation `thread_id` again after a resume in place, its usage based
    /// on what was already metered on it, since the provider's counter survives a resume, and
    /// delivers the frames that waited for it.
    pub(crate) async fn rebind_session_thread(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        thread_id: String,
    ) -> CodexRoutedFrames {
        let prior_emitted_cumulative = self
            .accountant
            .base_registers(&thread_id)
            .unwrap_or_default();
        self.bind_session_thread(
            delivery,
            record,
            thread_id,
            ThreadBaseEstablishment::Resume {
                prior_emitted_cumulative,
            },
        )
        .await
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

    /// Registers again a helper of the session's conversation that an adoption restored, running
    /// or with its newest turn over, beneath the conversation, its usage based on
    /// `prior_emitted_cumulative`, what was already metered on it, and its model kept before the
    /// frames that waited for it are delivered: `model`, the one its reopen or its node named,
    /// else the one its conversation's `thread/read` gives. Starts no child run: the helper's run
    /// is the one it already holds.
    pub(crate) async fn restore_helper_thread(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        helper_thread_id: String,
        prior_emitted_cumulative: UsageAxisCounts,
        model: Option<String>,
    ) -> CodexRoutedFrames {
        let mut routed = CodexRoutedFrames::default();
        let registered = self.router.register_child_thread(helper_announcement(
            helper_thread_id.clone(),
            &record.thread_id,
        ));
        if let ChildRegistrationResult::Registered {
            released_frames, ..
        } = registered
        {
            // Kept only for a helper the router took, and before its held frames are released,
            // so each usage reading among them is metered and names its model.
            self.accountant.establish_thread(
                helper_thread_id.clone(),
                ThreadBaseEstablishment::Resume {
                    prior_emitted_cumulative,
                },
            );
            // Read only for a helper the router took, so a refused one costs no read.
            let model = match model {
                Some(model) => Some(model),
                None => read_codex_helper_thread(record, &helper_thread_id)
                    .await
                    .and_then(|reading| reading.model),
            };
            if let Some(model) = model {
                self.helper_models.insert(helper_thread_id, model);
            }
            for frame in released_frames {
                self.route_frame(delivery, record, &frame, &mut routed)
                    .await;
            }
        }
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

    /// Admits a conversation the session moved off as the session's own while a command of it
    /// still runs, or stops admitting it once it is let go.
    pub(crate) fn hold_thread(&mut self, thread_id: String, is_held: bool) {
        if is_held {
            self.router.admit_held_thread(thread_id);
        } else {
            self.router.release_held_thread(&thread_id);
        }
    }

    /// Routes one notification of the session and delivers what it releases, each helper an
    /// `item/completed` spawn item names registering beneath the frame's conversation before the
    /// frame itself is routed. Never fails: each delivery reports its own failure.
    pub(crate) async fn route_notification(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        method: String,
        params: Box<RawValue>,
    ) -> CodexRoutedFrames {
        let mut routed = CodexRoutedFrames::default();
        let (frame, spawned_helpers) = CodexRoutableFrame::read(method, params);
        // A spawn item rides its parent's turn, so the frame's own conversation is the parent.
        // `item/started` registers nothing: the router holds the helper's frames until the item
        // completes.
        if frame.method == CODEX_ITEM_COMPLETED_METHOD
            && let Some(parent_thread_id) = &frame.thread_id
        {
            let mut registered = Vec::new();
            for helper in spawned_helpers {
                if let ChildRegistrationResult::Registered {
                    child_thread_id,
                    attribution,
                    released_frames,
                } = self.router.register_child_thread(helper_announcement(
                    helper.thread_id.clone(),
                    parent_thread_id,
                )) {
                    registered.push((child_thread_id, attribution, released_frames, helper));
                }
            }
            // Read together, so a spawn naming several helpers waits one read's bound, not one per
            // helper; a helper already metered or not a subagent starts nothing, so is not read.
            let shared_record: &CodexSessionRecord = record;
            let readings = join_all(registered.iter().map(
                |(child_thread_id, attribution, _, _)| {
                    let is_read = matches!(attribution, ChildSpendAttribution::Subagent { .. })
                        && !self.accountant.has_thread(child_thread_id);
                    async move {
                        if is_read {
                            read_codex_helper_thread(shared_record, child_thread_id).await
                        } else {
                            None
                        }
                    }
                },
            ))
            .await;
            for ((child_thread_id, attribution, released_frames, helper), reading) in
                registered.into_iter().zip(readings)
            {
                let spawned = CodexRegisteredHelper {
                    child_thread_id,
                    attribution,
                    helper,
                    reading,
                };
                self.start_registered_child(delivery, record, parent_thread_id, spawned)
                    .await;
                for released in released_frames {
                    self.route_frame(delivery, record, &released, &mut routed)
                        .await;
                }
            }
        }
        report_mcp_server_startup(record, &frame).await;
        self.route_frame(delivery, record, &frame, &mut routed)
            .await;
        routed
    }

    // A helper registered once: its usage based at zero and, for a subagent, its model kept and its
    // child run started with the path, model and effort its spawn item gives, its names and, where
    // the item names no model, its model from its conversation's `reading`. A repeated announcement
    // keeps the base, since re-basing would meter reported spend again, and starts nothing, since a
    // second start would show the helper twice.
    async fn start_registered_child(
        &mut self,
        delivery: &CodexFrameDelivery,
        record: &mut CodexSessionRecord,
        parent_thread_id: &str,
        spawned: CodexRegisteredHelper,
    ) {
        let CodexRegisteredHelper {
            child_thread_id,
            attribution,
            helper,
            reading,
        } = spawned;
        let child_thread_id = child_thread_id.as_str();
        if self.accountant.has_thread(child_thread_id) {
            report(
                record,
                DriverDiagnosticKind::ThreadDuplicateChildAnnouncement,
                Some(CODEX_ITEM_COMPLETED_METHOD),
                "duplicate child-thread announcement for an already-registered child; usage base \
                 retained and no second started emission",
                [("childThreadId", Value::from(child_thread_id))],
            );
            return;
        }
        self.accountant
            .establish_thread(child_thread_id.to_owned(), ThreadBaseEstablishment::Fresh);
        let ChildSpendAttribution::Subagent { subagent_id } = &attribution else {
            return;
        };
        let reading = reading.as_ref();
        let model = helper
            .model
            .or_else(|| reading.and_then(|reading| reading.model.clone()));
        if let Some(model) = &model {
            self.helper_models
                .insert(child_thread_id.to_owned(), model.clone());
        }
        let helper_start = CodexHelperStart::new(
            reading.and_then(|reading| reading.agent_nickname.clone()),
            reading.and_then(|reading| reading.agent_role.clone()),
            helper.provider_path,
            helper.ask,
            model,
            helper.reasoning_effort,
        );
        delivery
            .start_child(
                record,
                child_thread_id,
                parent_thread_id,
                subagent_id,
                helper.call_id.as_deref(),
                helper_start,
            )
            .await;
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
                let usage = self.meter_usage_frame(record, frame, &route, routed);
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
                self.meter_usage_frame(record, frame, &route, routed);
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
    // reading that cannot be read is reported, since a silent drop is spend no receipt shows. A
    // helper's reading runs at the thread's tier and names the model its spawn or its
    // conversation's read named; any other runs at its turn's sent tier and model, else the
    // thread's, as for a turn the daemon started, which keeps none.
    fn meter_usage_frame(
        &mut self,
        record: &CodexSessionRecord,
        frame: &CodexRoutableFrame,
        route: &ThreadFrameRoute,
        routed: &mut CodexRoutedFrames,
    ) -> Option<CumulativeUsageReading> {
        if frame.method != CODEX_THREAD_TOKEN_USAGE_METHOD {
            return None;
        }
        let Some(mut reading) = read_codex_token_usage(&frame.params) else {
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
        let is_helper = matches!(route, ThreadFrameRoute::CarveOutUsage { .. });
        let input = reading
            .named_turn_id
            .as_ref()
            .filter(|_| !is_helper)
            .and_then(|turn_id| record.turn_input_by_turn_id.get(turn_id));
        let thread_speed = record
            .declared_output_speed
            .as_ref()
            .map(|speed| speed.declared.as_str());
        let speed = input
            .and_then(|input| input.sent_output_speed_for_turn.as_deref())
            .or(thread_speed);
        reading.request.speed = speed.and_then(|speed| BoundedText::new(speed.to_owned()));
        reading.request.thread_speed =
            thread_speed.and_then(|speed| BoundedText::new(speed.to_owned()));
        let model = if is_helper {
            self.helper_models.get(&reading.thread_id)
        } else {
            Some(input.map_or(&record.thread_settings.model, |input| &input.model))
        };
        reading.request.model_id = model.and_then(|model| FreeFormText::new(model.clone()).ok());
        // Only a metered delta enters the ledger, so a stale `last`, a replay or a full window's
        // synthetic reading leaves nothing an export could wrongly claim; the late twin of an
        // exported response already priced is matched to it and counts nothing.
        if let Some(delta) = self.accountant.meter_reading(reading.clone())
            && self.streamed.record(&delta.thread_id, delta.axis_deltas)
        {
            routed.metered_usage.push(delta);
        }
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
    // its child run. A held helper's turn ends as the daemon's instead, the helper kept here and
    // its run left waiting on the person.
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
        // Params that do not read as an object name no turn, which ends nothing held.
        let turn_members: Map<String, Value> =
            serde_json::from_str(frame.params.get()).unwrap_or_default();
        if delivery
            .end_held_helper_turn(record, thread_id, &turn_members)
            .await
        {
            return;
        }
        let is_subagent = matches!(
            self.router.child_attribution_for(thread_id),
            Some(ChildSpendAttribution::Subagent { .. })
        );
        if !self.router.complete_child_thread(thread_id) {
            return;
        }
        self.accountant.release_thread(thread_id);
        self.helper_models.remove(thread_id);
        if is_subagent {
            delivery
                .complete_child(record, thread_id, &frame.params, &turn_members)
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

// Hands a tool server's startup on the session's own conversation to the status sink of the leg
// it runs on, a row that breaks the reader's bound reported. A helper's conversation has no sink
// of its own and one the session moved off is no longer its leg's, so their startups go nowhere.
// Once the last server of a startup round settles, the leg lists its servers with their tools,
// which a startup never names, on the session's task, so no list lands after a later startup.
async fn report_mcp_server_startup(record: &mut CodexSessionRecord, frame: &CodexRoutableFrame) {
    if frame.method != CODEX_MCP_SERVER_STARTUP_STATUS_UPDATED_METHOD
        || frame.thread_id.as_deref() != Some(record.thread_id.as_str())
    {
        return;
    }
    let Some(producer) = record.on_mcp_server_status.clone() else {
        return;
    };
    // Params that are not JSON read as none, which the reader refuses as not an object.
    let notification: Value = serde_json::from_str(frame.params.get()).unwrap_or_default();
    let read = normalize_codex_mcp_server_status_notification(&notification);
    let startups = &mut record.mcp_server_startups;
    let mut has_round_settled = false;
    for emission in read.emissions {
        let name = &emission.server_name;
        if emission.reading == McpServerReading::Observed(McpServerStatus::Starting) {
            startups
                .round
                .get_or_insert_with(HashSet::new)
                .insert(name.clone());
        } else if let Some(round) = &mut startups.round
            && round.remove(name)
        {
            has_round_settled = round.is_empty();
        }
        startups.readings.insert(
            name.clone(),
            (emission.reading, emission.failure_text.clone()),
        );
        producer.report_status(emission);
    }
    for rejection in read.rejections {
        report(
            record,
            DriverDiagnosticKind::McpServerStatusRejected,
            Some(CODEX_MCP_SERVER_STARTUP_STATUS_UPDATED_METHOD),
            &rejection.reason,
            [],
        );
    }
    if has_round_settled && record.mcp_server_startups.round.take().is_some() {
        list_settled_mcp_servers(record, &producer).await;
    }
}

// Lists the servers of the session's conversation with their tools on its service and hands each
// to `producer` with the status and text its newest startup reported, so the list adds only the
// tools; a list that fails is logged, the leg keeping what its startups reported.
async fn list_settled_mcp_servers(record: &CodexSessionRecord, producer: &McpServerStatusProducer) {
    let listed = match record.service.connection() {
        Ok(connection) => {
            list_codex_mcp_server_statuses(&connection, &record.thread_id, None).await
        }
        Err(error) => Err(error),
    };
    match listed {
        Ok(emissions) => {
            for mut emission in emissions {
                if let Some((reading, failure_text)) = record
                    .mcp_server_startups
                    .readings
                    .get(&emission.server_name)
                {
                    emission.reading = *reading;
                    emission.failure_text.clone_from(failure_text);
                }
                producer.report_status(emission);
            }
        }
        Err(error) => tracing::warn!(
            session_id = %record.session_id,
            error = &error as &(dyn std::error::Error + 'static),
            "codex's mcp server list failed; the session's servers keep their startups, no tools"
        ),
    }
}

// The router's announcement of a helper beneath `parent_thread_id`; a helper's own id is its
// conversation's.
fn helper_announcement(
    helper_thread_id: String,
    parent_thread_id: &str,
) -> ChildThreadAnnouncement {
    ChildThreadAnnouncement {
        subagent_id: Some(helper_thread_id.clone()),
        child_thread_id: helper_thread_id,
        declared_parent_thread_id: Some(parent_thread_id.to_owned()),
        waiting_call_id: None,
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
        is_conversation_start: usage.cumulative.total == Some(window_used_tokens),
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
        provider_account_id: Some(record.provider_account_id.clone()),
        kind,
        raw_wire_type: raw_wire_type.map(str::to_owned),
        disposition_reason: disposition_reason.to_owned(),
        details,
    });
}

#[cfg(test)]
mod tests;
