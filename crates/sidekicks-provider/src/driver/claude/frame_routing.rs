//! Each Claude Code frame through its session's routing band, on the reader under the band's lock:
//! the thread router decides whether it projects, the usage accountant meters it, a helper's
//! `task_started` registers its child thread and its `task_notification`, or for a foreground
//! helper its helper-tool call's result, completes it, and the session thread's own handshake,
//! whole `/` list and compaction boundary are tapped. A thread's usage is the sum of its assistant
//! messages, each message's last reading counted once, and a lead turn's `result` confirms the
//! thread's sum: the turn's own `usage` raises it where the messages read short of it. Each change
//! names the message whose request it belongs to and what prices that request; a `result`'s names
//! the turn's last message.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_std::port_registration::PortRegistration;
use tokio::time::Instant;

use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::event_normalizer::{
    ClaudeSubagentSignal, classify_claude_frame_family_for_routing,
    normalize_claude_subagent_lifecycle,
};
use crate::driver::claude::handshake_register::{
    ClaudeHandshakeRegister, ClaudeSettledOutputSpeed,
};
use crate::driver::claude::session::process::ClaudeStreamFrame;
use crate::driver::claude::session::state::{
    ClaudeRoutableFrame, ClaudeSessionRoutingBand, ClaudeToolCallThread, ClaudeUsageEstablishment,
};
use crate::driver::claude::session::transport::declarations::{
    self, ClaudeMessageRequestFacts, ClaudeMessageUsageObservation,
};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::prior_usage::read_prior_emitted;
use crate::port::usage_sink::UsageSink;
use crate::thread_frame_router::{
    ChildRegistrationResult, ChildSpendAttribution, SubagentLifecycleEmission,
    SubagentLifecycleEventType, ThreadFrameRoute,
};
use crate::usage_delta_accountant::{
    CumulativeUsageReading, MeteredUsageDelta, ThreadBaseEstablishment, UsageAxisCounts,
    UsageRequestFacts,
};

/// What the routing band read off one frame: its route, the helper starts and ends it reports,
/// in order, the usage it and any frame its registration released metered, and the output speed
/// its handshake settled for the armed run.
#[derive(Debug)]
pub(crate) struct ClaudeRoutedObservation {
    /// The router's decision.
    pub(crate) route: ThreadFrameRoute,
    /// Each helper that started or ended, a start ahead of the frame's own rows.
    pub(crate) helper_lifecycle: Vec<SubagentLifecycleEmission>,
    /// The usage metered, in stream order, for the stream to record on its run.
    pub(crate) metered: Vec<ClaudeMeteredReading>,
    /// The output speed the session thread's handshake settled, for the run engine.
    pub(crate) settled_output_speed: Option<ClaudeSettledOutputSpeed>,
}

/// One frame handed back by the routing band with what it read off it, and each helper frame the
/// frame's start of that helper released from its hold, with what was read off that frame, in
/// arrival order, so the stream reads it as it would have been read unheld.
pub(crate) struct ClaudeRoutedFrames {
    /// The frame.
    pub(crate) frame: ClaudeStreamFrame,
    /// What the band read off it.
    pub(crate) routed: ClaudeRoutedObservation,
    /// The helper frames it released, each routed as its helper's.
    pub(crate) released_helper_frames: Vec<(ClaudeStreamFrame, ClaudeRoutedObservation)>,
}

/// One metered change of a thread's usage, by the helper it came from.
#[derive(Debug)]
pub(crate) struct ClaudeMeteredReading {
    /// The helper whose thread spent it, its `agent_id`; `None` for the session's own thread.
    pub(crate) subagent_id: Option<String>,
    /// The change.
    pub(crate) delta: MeteredUsageDelta,
}

/// Each thread's usage as its messages sum it, held in a session's routing band beside the
/// accountant, and the readings metered off frames no route was waiting on.
#[derive(Debug, Default)]
pub(crate) struct ClaudeThreadUsageTally {
    threads: HashMap<String, ClaudeThreadMessages>,
    unrouted: Vec<ClaudeMeteredReading>,
}

// One thread's sum: the messages before the open one, the open one, and the sum as the thread's
// last `result` confirmed it.
#[derive(Debug)]
struct ClaudeThreadMessages {
    finished: UsageAxisCounts,
    open: Option<ClaudeOpenMessage>,
    confirmed: UsageAxisCounts,
}

// The message a thread is reading: its id, its last counts, and what prices its request so far.
#[derive(Debug)]
struct ClaudeOpenMessage {
    message_id: String,
    counts: UsageAxisCounts,
    request: ClaudeMessageRequestFacts,
}

impl ClaudeThreadMessages {
    // A thread whose sum starts at `base`, the accountant's base for it.
    fn starting_at(base: UsageAxisCounts) -> Self {
        Self {
            finished: base,
            open: None,
            confirmed: base,
        }
    }

    fn total(&self) -> UsageAxisCounts {
        self.open
            .as_ref()
            .map_or(self.finished, |open| add_counts(self.finished, open.counts))
    }

    // A message's reading, with the thread's sum and what prices the change: the same message's
    // counts only grow, and another message closes the one before it. The change carries the
    // growth of the longer-lifetime cache write and of the searches since the same message's last
    // reading, the whole figure for a new message.
    fn observe_message(
        &mut self,
        message: &ClaudeMessageUsageObservation,
    ) -> (UsageAxisCounts, UsageRequestFacts) {
        if self
            .open
            .as_ref()
            .is_none_or(|open| open.message_id != message.message_id)
            && let Some(closed) = self.open.take()
        {
            self.finished = add_counts(self.finished, closed.counts);
        }
        let open = self.open.get_or_insert_with(|| ClaudeOpenMessage {
            message_id: message.message_id.clone(),
            counts: UsageAxisCounts::default(),
            request: ClaudeMessageRequestFacts::default(),
        });
        let read = &message.request;
        let so_far = &open.request;
        let request = UsageRequestFacts {
            cache_write_extended_tokens: growth(
                so_far.cache_write_extended_tokens,
                read.cache_write_extended_tokens,
            ),
            web_search_requests: growth(so_far.web_search_requests, read.web_search_requests),
            ..request_selectors(&message.message_id, read)
        };
        open.counts = larger_counts(open.counts, message.counts);
        open.request = ClaudeMessageRequestFacts {
            cache_write_extended_tokens: combine_count(
                so_far.cache_write_extended_tokens,
                read.cache_write_extended_tokens,
                u64::max,
            ),
            web_search_requests: combine_count(
                so_far.web_search_requests,
                read.web_search_requests,
                u64::max,
            ),
            ..read.clone()
        };
        (self.total(), request)
    }

    // A turn's own usage, which the thread's sum reaches at least, with the turn's last message's
    // key and selectors, or none where no message is open.
    fn confirm_turn(&mut self, turn: UsageAxisCounts) -> (UsageAxisCounts, UsageRequestFacts) {
        let total = larger_counts(self.total(), add_counts(self.confirmed, turn));
        let request = self
            .open
            .take()
            .map_or_else(UsageRequestFacts::default, |open| {
                request_selectors(&open.message_id, &open.request)
            });
        self.finished = total;
        self.confirmed = total;
        (total, request)
    }
}

/// Routes and meters every session's frames through the routing band each session holds.
pub(crate) struct ClaudeFrameRouting {
    handshakes: Arc<ClaudeHandshakeRegister>,
    pending_compactions: PendingCompactionRegistry,
    usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
}

impl ClaudeFrameRouting {
    /// Routing that taps handshakes into `handshakes` and compaction boundaries into
    /// `pending_compactions`, and hands metered usage to `usage` once it is registered.
    pub(crate) fn new(
        handshakes: Arc<ClaudeHandshakeRegister>,
        pending_compactions: PendingCompactionRegistry,
        usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    ) -> Self {
        Self {
            handshakes,
            pending_compactions,
            usage,
        }
    }

    /// Binds a session's own thread into `band`: its base registers first, since a released usage
    /// frame meters at once and an unestablished thread refuses it, then the frames held for it
    /// routed again. A resumed thread's base is the daemon's prior-emitted sum; one that cannot be
    /// read is recorded and starts at zero, since failing here would orphan a live process.
    pub(crate) async fn bind_session_thread(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        provider_session_id: &str,
        establishment: &ClaudeUsageEstablishment,
    ) {
        let base = match establishment {
            ClaudeUsageEstablishment::Fresh => ThreadBaseEstablishment::Fresh,
            ClaudeUsageEstablishment::Resume {
                prior_emitted_thread_id,
            } => ThreadBaseEstablishment::Resume {
                prior_emitted_cumulative: read_prior_emitted(
                    &self.usage,
                    DESCRIPTOR.provider_id(),
                    session_id,
                    prior_emitted_thread_id,
                )
                .await,
            },
        };
        band.accountant
            .establish_thread(provider_session_id.to_owned(), base);
        let released = band
            .router
            .register_session_thread(provider_session_id.to_owned());
        // The frames held for the session's own thread route as its own, so none is a helper's.
        Self::route_released(band, released);
    }

    /// Routes one `frame` of `session_id`'s process and hands it back with what the band read off
    /// it and the helper frames it released. A helper's start registers its child before the
    /// frame routes, or the frame would be held for its own registration; a helper's end completes
    /// it after, so the end is still kept out of the session's transcript.
    pub(crate) fn route_frame(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        provider_session_id: &str,
        frame: ClaudeStreamFrame,
    ) -> ClaudeRoutedFrames {
        let observation = &frame.observation;
        let mut released_helper_frames = Vec::new();
        let mut routed = ClaudeRoutedObservation {
            route: ThreadFrameRoute::Quarantined,
            helper_lifecycle: Vec::new(),
            metered: std::mem::take(&mut band.usage_tally.unrouted),
            settled_output_speed: None,
        };
        // Only the session's own thread counts; a helper's handshake or compaction says nothing
        // about the session's process.
        if observation.subagent_id.is_none() {
            if let Some(commands) = &observation.commands_changed {
                self.handshakes
                    .replace_commands(session_id, provider_session_id, commands);
            }
            if let Some(handshake) = &observation.handshake {
                routed.settled_output_speed = self.handshakes.observe_handshake_declaration(
                    session_id,
                    provider_session_id,
                    handshake.clone(),
                );
            }
            if let Some(boundary) = observation.compaction_boundary {
                self.pending_compactions
                    .observe_boundary(&session_id.to_string(), boundary.boundary_position);
            }
        }
        // A helper a `SendMessage` call wakes runs on past the call's result, whether its start
        // came before the call or comes after it.
        for call_id in &observation.message_call_ids {
            let waiting_helper_id = band
                .router
                .child_waiting_on_call(call_id)
                .map(str::to_owned);
            if let Some(helper_id) = waiting_helper_id {
                band.router.stop_waiting_on_child(&helper_id);
            }
            band.message_call_ids.insert(call_id.clone());
        }
        // Read before the frame routes, so a held helper frame's call is known when the call
        // reaches the daemon's tool server right after it.
        for call_id in &observation.daemon_tool_call_ids {
            let thread = observation
                .subagent_id
                .clone()
                .map_or(ClaudeToolCallThread::Session, ClaudeToolCallThread::Helper);
            band.daemon_tool_calls.insert(call_id.clone(), thread);
        }
        for call_id in &observation.answered_call_ids {
            band.daemon_tool_calls.remove(call_id);
        }
        // A start naming a call answered earlier in the turn waits on nothing, so the ids are kept
        // until the lead's turn ends.
        if observation.subagent_id.is_none() && observation.frame_kind == "result" {
            band.message_call_ids.clear();
        }
        if let Some(signal) = &observation.subagent_lifecycle
            && signal.signal == ClaudeSubagentSignal::SubagentStart
        {
            released_helper_frames = Self::register_helper(
                band,
                session_id,
                provider_session_id,
                observation,
                &mut routed,
            );
        }
        // A helper moved to the background runs on past its call's result.
        if let Some(helper_id) = &observation.backgrounded_helper_id {
            band.router.stop_waiting_on_child(helper_id);
        }
        let frame = ClaudeRoutableFrame {
            // Claude Code's frames carry no thread id: a helper's own id, else the session's.
            thread_id: observation
                .subagent_id
                .clone()
                .unwrap_or_else(|| provider_session_id.to_owned()),
            family_class: classify_claude_frame_family_for_routing(
                &observation.frame_kind,
                observation.cumulative_usage.is_some(),
            ),
            frame,
        };
        let route = band.router.route_frame(&frame, Instant::now());
        apply_route(band, &frame, &route, &mut routed);
        routed.route = route;
        ClaudeRoutedFrames {
            frame: frame.frame,
            routed,
            released_helper_frames,
        }
    }

    // Registers a started helper's child thread at a zero usage base and reports its start once,
    // answering the helper's frames its registration released; a repeat announcement is recorded
    // and starts nothing.
    fn register_helper(
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        provider_session_id: &str,
        observation: &declarations::ClaudeInboundFrameObservation,
        routed: &mut ClaudeRoutedObservation,
    ) -> Vec<(ClaudeStreamFrame, ClaudeRoutedObservation)> {
        let Some(signal) = observation.subagent_lifecycle.clone() else {
            return Vec::new();
        };
        let normalized = normalize_claude_subagent_lifecycle(signal, provider_session_id, |id| {
            band.router.child_attribution_for(id).is_some()
        });
        let Some(mut announcement) = normalized.announcement else {
            return Vec::new();
        };
        if announcement
            .waiting_call_id
            .as_ref()
            .is_some_and(|call_id| band.message_call_ids.contains(call_id))
        {
            announcement.waiting_call_id = None;
        }
        let ChildRegistrationResult::Registered {
            child_thread_id,
            released_frames,
            ..
        } = band.router.register_child_thread(announcement)
        else {
            return Vec::new();
        };
        if band.accountant.has_thread(&child_thread_id) {
            // Establishing again would zero its register and count its spend twice.
            report(
                session_id,
                DriverDiagnosticKind::ThreadDuplicateChildAnnouncement,
                Some(&observation.frame_kind),
                "a helper announced again while registered keeps its usage base and starts no \
                 second time",
                [("childThreadId", Value::from(child_thread_id))],
            );
        } else {
            band.accountant
                .establish_thread(child_thread_id, ThreadBaseEstablishment::Fresh);
            routed.helper_lifecycle.push(SubagentLifecycleEmission {
                event_type: SubagentLifecycleEventType::Started,
                subagent_id: normalized.subagent_id,
                parent_tool_call_id: normalized.parent_tool_use_id,
            });
        }
        Self::route_released(band, released_frames)
    }

    // Routes again each frame a registration released, answering each that routes as a helper's
    // own with what was read off it; what it metered waits for the next frame's routing to carry
    // it.
    fn route_released(
        band: &mut ClaudeSessionRoutingBand,
        released: Vec<ClaudeRoutableFrame>,
    ) -> Vec<(ClaudeStreamFrame, ClaudeRoutedObservation)> {
        let mut helper_frames = Vec::new();
        for frame in released {
            let route = band.router.route_frame(&frame, Instant::now());
            let mut released_routed = ClaudeRoutedObservation {
                route: ThreadFrameRoute::Quarantined,
                helper_lifecycle: Vec::new(),
                metered: Vec::new(),
                settled_output_speed: None,
            };
            apply_route(band, &frame, &route, &mut released_routed);
            band.usage_tally
                .unrouted
                .extend(std::mem::take(&mut released_routed.metered));
            if matches!(route, ThreadFrameRoute::ChildTranscript { .. }) {
                released_routed.route = route;
                helper_frames.push((frame.frame, released_routed));
            }
        }
        helper_frames
    }
}

// Usage is metered ahead of suppression, so a helper's spend counts though its rows do not; the
// helpers a frame ends complete their child threads.
fn apply_route(
    band: &mut ClaudeSessionRoutingBand,
    frame: &ClaudeRoutableFrame,
    route: &ThreadFrameRoute,
    routed: &mut ClaudeRoutedObservation,
) {
    match route {
        ThreadFrameRoute::Project
        | ThreadFrameRoute::RouteConnectionScoped
        | ThreadFrameRoute::CarveOutUsage { .. }
        | ThreadFrameRoute::ChildTranscript { .. } => {
            routed.metered.extend(meter(band, frame));
            complete_ended_helpers(band, frame, routed);
        }
        // The router records a held or quarantined frame itself; an ask travels as a request.
        ThreadFrameRoute::CarveOutInteractiveRequest { .. }
        | ThreadFrameRoute::HeldPendingRegistration
        | ThreadFrameRoute::Quarantined => {}
    }
}

// The change one frame's usage makes to its thread's sum, with what prices its request; `None` for
// a frame that carries none, a thread with no base, or a reading that changes nothing.
fn meter(
    band: &mut ClaudeSessionRoutingBand,
    frame: &ClaudeRoutableFrame,
) -> Option<ClaudeMeteredReading> {
    let observation = &frame.frame.observation;
    let base = band.accountant.base_registers(&frame.thread_id)?;
    let messages = band
        .usage_tally
        .threads
        .entry(frame.thread_id.clone())
        .or_insert_with(|| ClaudeThreadMessages::starting_at(base));
    let (cumulative, request) = match (&observation.message_usage, &observation.cumulative_usage) {
        (Some(message), _) => messages.observe_message(message),
        (None, Some(turn)) => messages.confirm_turn(turn.cumulative),
        (None, None) => return None,
    };
    let delta = band.accountant.meter_reading(CumulativeUsageReading {
        thread_id: frame.thread_id.clone(),
        named_turn_id: None,
        cumulative,
        declared_per_turn: None,
        request,
    })?;
    let axes = &delta.axis_deltas;
    // A frame whose only change is a search or a longer-lifetime cache write is still metered.
    let is_unchanged = [
        axes.input,
        axes.cached_input,
        axes.cache_write_input,
        axes.output,
        axes.reasoning_output,
        axes.total,
        delta.request.cache_write_extended_tokens,
        delta.request.web_search_requests,
    ]
    .into_iter()
    .all(|count| count.unwrap_or(0) == 0);
    (!is_unchanged).then(|| ClaudeMeteredReading {
        subagent_id: observation.subagent_id.clone(),
        delta,
    })
}

// Each axis summed, present where either side carries it.
fn add_counts(left: UsageAxisCounts, right: UsageAxisCounts) -> UsageAxisCounts {
    combine_counts(left, right, u64::saturating_add)
}

// Each axis's larger count, present where either side carries it.
fn larger_counts(left: UsageAxisCounts, right: UsageAxisCounts) -> UsageAxisCounts {
    combine_counts(left, right, u64::max)
}

fn combine_counts(
    left: UsageAxisCounts,
    right: UsageAxisCounts,
    combine: fn(u64, u64) -> u64,
) -> UsageAxisCounts {
    let axis = |left, right| combine_count(left, right, combine);
    UsageAxisCounts {
        input: axis(left.input, right.input),
        cached_input: axis(left.cached_input, right.cached_input),
        cache_write_input: axis(left.cache_write_input, right.cache_write_input),
        output: axis(left.output, right.output),
        reasoning_output: axis(left.reasoning_output, right.reasoning_output),
        total: axis(left.total, right.total),
    }
}

// One count combined, present where either side carries it.
fn combine_count(
    left: Option<u64>,
    right: Option<u64>,
    combine: fn(u64, u64) -> u64,
) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(combine(left, right)),
        (left, right) => left.or(right),
    }
}

// How far a message's figure so far grew at this reading, the whole figure where none was read
// before; absent where this reading carries none.
fn growth(so_far: Option<u64>, read: Option<u64>) -> Option<u64> {
    read.map(|read| read.saturating_sub(so_far.unwrap_or(0)))
}

// The message `message_id`'s request key and selectors, with no count.
fn request_selectors(message_id: &str, request: &ClaudeMessageRequestFacts) -> UsageRequestFacts {
    UsageRequestFacts {
        model_id: request.model_id.clone(),
        request_key: BoundedText::new(message_id.to_owned()),
        speed: request.speed.clone(),
        processing_region: request.processing_region.clone(),
        ..UsageRequestFacts::default()
    }
}

// Completes the child thread of each helper the frame ends: a `task_notification`'s, and a
// foreground helper's whose helper-tool call a tool result answers, since Claude Code answers that
// call only once the helper finished, whether or not its `task_notification` comes.
fn complete_ended_helpers(
    band: &mut ClaudeSessionRoutingBand,
    frame: &ClaudeRoutableFrame,
    routed: &mut ClaudeRoutedObservation,
) {
    let observation = &frame.frame.observation;
    if let Some(signal) = &observation.subagent_lifecycle
        && signal.signal == ClaudeSubagentSignal::SubagentStop
    {
        complete_helper(
            band,
            &signal.subagent_id,
            signal.parent_tool_use_id.clone(),
            routed,
        );
    }
    for call_id in &observation.answered_call_ids {
        if let Some(helper_id) = band
            .router
            .child_waiting_on_call(call_id)
            .map(str::to_owned)
        {
            complete_helper(band, &helper_id, Some(call_id.clone()), routed);
        }
    }
}

// Completes a helper's child thread and reports its end once, for a helper the router held.
fn complete_helper(
    band: &mut ClaudeSessionRoutingBand,
    helper_id: &str,
    parent_tool_call_id: Option<String>,
    routed: &mut ClaudeRoutedObservation,
) {
    let attribution = band.router.child_attribution_for(helper_id).cloned();
    if !band.router.complete_child_thread(helper_id) {
        return;
    }
    band.accountant.release_thread(helper_id);
    band.usage_tally.threads.remove(helper_id);
    if let Some(ChildSpendAttribution::Subagent { subagent_id }) = attribution {
        routed.helper_lifecycle.push(SubagentLifecycleEmission {
            event_type: SubagentLifecycleEventType::Completed,
            subagent_id,
            parent_tool_call_id,
        });
    }
}

fn report<const FIELDS: usize>(
    session_id: SessionId,
    kind: DriverDiagnosticKind,
    raw_wire_type: Option<&str>,
    disposition_reason: &str,
    details: [(&str, Value); FIELDS],
) {
    let mut fields = Map::from_iter(
        details
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value)),
    );
    fields.insert("sessionId".to_owned(), Value::from(session_id.to_string()));
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: None,
        kind,
        raw_wire_type: raw_wire_type.map(str::to_owned),
        disposition_reason: disposition_reason.to_owned(),
        details: fields,
    });
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
    use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

    use crate::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
    };
    use crate::usage_delta_accountant::UsageRequestFacts;

    // An assistant message's frame: `usage` holds its token counts and request selectors.
    fn message(message_id: &str, model: Option<&str>, usage: &Value) -> Value {
        let mut message = json!({
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "text", "text": "working"}],
            "usage": usage,
        });
        if let (Some(message), Some(model)) = (message.as_object_mut(), model) {
            message.insert("model".to_owned(), Value::from(model));
        }
        json!({
            "type": "assistant",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "message": message,
        })
    }

    fn text(value: &str) -> Option<BoundedText<1, EVENT_FIELD_MAX_LEN>> {
        BoundedText::new(value.to_owned())
    }

    // Fails when a row carries the cumulative longer-lifetime cache write or search count of its
    // message instead of the growth since that message's last reading, when a `result`'s row names
    // no request though a message was metered before it, when `global` is stored as a region, or
    // when the model keeps its larger-window mark. Mutations: `growth` returning the figure read;
    // `confirm_turn` answering no request; the `global` filter dropped; the mark left on the model.
    #[tokio::test(start_paused = true)]
    async fn each_row_names_its_message_request_and_the_growth_of_its_priced_counts() {
        let session = ScriptedSession::new().await;
        session.hold_lead_turn("lead");

        let first_usage = |extended_tokens: u64, searches: u64| {
            json!({
                "input_tokens": 10,
                "output_tokens": 1,
                "speed": "fast",
                "inference_geo": "us",
                "cache_creation": {"ephemeral_1h_input_tokens": extended_tokens},
                "server_tool_use": {"web_search_requests": searches},
            })
        };
        session.frame(&message(
            "m1",
            Some("claude-opus-5-5[1m]"),
            &first_usage(100, 1),
        ));
        session.frame(&message(
            "m1",
            Some("claude-opus-5-5[1m]"),
            &first_usage(300, 2),
        ));
        session.frame(&message(
            "m2",
            None,
            &json!({
                "input_tokens": 20,
                "output_tokens": 2,
                "speed": null,
                "inference_geo": "global",
            }),
        ));
        session.frame(&json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "usage": {"input_tokens": 100, "output_tokens": 50},
        }));
        settle().await;

        let first = UsageRequestFacts {
            model_id: FreeFormText::new("claude-opus-5-5".to_owned()).ok(),
            request_key: text("m1"),
            speed: text("fast"),
            processing_region: text("us"),
            ..UsageRequestFacts::default()
        };
        let requests: Vec<UsageRequestFacts> = session
            .usage
            .metered()
            .into_iter()
            .map(|metered| metered.delta.request)
            .collect();
        assert_eq!(
            requests,
            [
                UsageRequestFacts {
                    cache_write_extended_tokens: Some(100),
                    web_search_requests: Some(1),
                    ..first.clone()
                },
                UsageRequestFacts {
                    cache_write_extended_tokens: Some(200),
                    web_search_requests: Some(1),
                    ..first
                },
                UsageRequestFacts {
                    request_key: text("m2"),
                    ..UsageRequestFacts::default()
                },
                UsageRequestFacts {
                    request_key: text("m2"),
                    ..UsageRequestFacts::default()
                },
            ]
        );
    }
}
