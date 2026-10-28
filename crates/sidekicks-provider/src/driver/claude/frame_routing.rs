//! Each Claude Code frame through its session's routing band, on the reader under the band's lock:
//! the thread router decides whether it projects, the usage accountant meters it, a helper's
//! `task_started` registers its child thread and its `task_notification`, or for a foreground
//! helper its helper-tool call's result, completes it, and the session thread's own handshake,
//! whole `/` list and compaction boundary are tapped. A thread's usage is the sum of its assistant
//! messages, each message's last reading counted once, and a lead turn's `result` confirms the
//! thread's sum: the turn's own `usage` raises it where the messages read short of it.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::error_description::describe_error;
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
use crate::driver::claude::session::state::{
    ClaudeRoutableFrame, ClaudeSessionRoutingBand, ClaudeUsageEstablishment,
};
use crate::driver::claude::session::transport::declarations;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::port::usage_sink::UsageSink;
use crate::thread_frame_router::{
    ChildRegistrationResult, ChildSpendAttribution, SubagentLifecycleEmission,
    SubagentLifecycleEventType, ThreadFrameRoute,
};
use crate::usage_delta_accountant::{
    CumulativeUsageReading, MeteredUsageDelta, ThreadBaseEstablishment, UsageAxisCounts,
};
use sidekicks_std::port_registration::PortRegistration;

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

// One thread's sum: the messages before the open one, the open one's last reading, and the sum as
// the thread's last `result` confirmed it.
#[derive(Debug)]
struct ClaudeThreadMessages {
    finished: UsageAxisCounts,
    open: Option<(String, UsageAxisCounts)>,
    confirmed: UsageAxisCounts,
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
            .map_or(self.finished, |(_, open)| add_counts(self.finished, *open))
    }

    // A message's reading: the same message's counts only grow, and another message closes the
    // one before it.
    fn observe_message(&mut self, message_id: &str, counts: UsageAxisCounts) -> UsageAxisCounts {
        match &mut self.open {
            Some((open_id, open)) if open_id == message_id => *open = larger_counts(*open, counts),
            _ => {
                if let Some((_, open)) = self.open.take() {
                    self.finished = add_counts(self.finished, open);
                }
                self.open = Some((message_id.to_owned(), counts));
            }
        }
        self.total()
    }

    // A turn's own usage, which the thread's sum reaches at least.
    fn confirm_turn(&mut self, turn: UsageAxisCounts) -> UsageAxisCounts {
        let total = larger_counts(self.total(), add_counts(self.confirmed, turn));
        self.finished = total;
        self.open = None;
        self.confirmed = total;
        total
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
                prior_emitted_cumulative: self
                    .read_prior_emitted(session_id, prior_emitted_thread_id)
                    .await,
            },
        };
        band.accountant
            .establish_thread(provider_session_id.to_owned(), base);
        let released = band
            .router
            .register_session_thread(provider_session_id.to_owned());
        self.route_released(band, released);
    }

    /// Routes one frame of `session_id`'s process and answers what the band read off it. A
    /// helper's start registers its child before the frame routes, or the frame would be held for
    /// its own registration; a helper's end completes it after, so the end is still kept out of
    /// the session's transcript.
    pub(crate) fn route_frame(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        provider_session_id: &str,
        observation: &declarations::ClaudeInboundFrameObservation,
    ) -> ClaudeRoutedObservation {
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
        if let Some(signal) = &observation.subagent_lifecycle
            && signal.signal == ClaudeSubagentSignal::SubagentStart
        {
            self.register_helper(
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
            observation: observation.clone(),
        };
        let route = band.router.route_frame(&frame, Instant::now());
        apply_route(band, &frame, &route, &mut routed);
        routed.route = route;
        routed
    }

    // Registers a started helper's child thread at a zero usage base and reports its start once;
    // a repeat announcement is recorded and starts nothing.
    fn register_helper(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        provider_session_id: &str,
        observation: &declarations::ClaudeInboundFrameObservation,
        routed: &mut ClaudeRoutedObservation,
    ) {
        let Some(signal) = observation.subagent_lifecycle.clone() else {
            return;
        };
        let normalized = normalize_claude_subagent_lifecycle(signal, provider_session_id, |id| {
            band.router.child_attribution_for(id).is_some()
        });
        let Some(announcement) = normalized.announcement else {
            return;
        };
        let ChildRegistrationResult::Registered {
            child_thread_id,
            released_frames,
            ..
        } = band.router.register_child_thread(announcement)
        else {
            return;
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
        self.route_released(band, released_frames);
    }

    // Routes again each frame a registration released; what it metered waits for the next
    // frame's routing to carry it, and its rows were a helper's own, which the session's
    // transcript never shows.
    fn route_released(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        released: Vec<ClaudeRoutableFrame>,
    ) {
        for frame in released {
            let route = band.router.route_frame(&frame, Instant::now());
            let mut released_routed = ClaudeRoutedObservation {
                route: ThreadFrameRoute::Quarantined,
                helper_lifecycle: Vec::new(),
                metered: Vec::new(),
                settled_output_speed: None,
            };
            apply_route(band, &frame, &route, &mut released_routed);
            band.usage_tally.unrouted.extend(released_routed.metered);
        }
    }

    // The daemon's own sum for a resumed thread; an unregistered usage record or a failed read is
    // recorded, the base then zero, so the first reading meters what came before again.
    async fn read_prior_emitted(&self, session_id: SessionId, thread_id: &str) -> UsageAxisCounts {
        let failure = match self.usage.require_port() {
            Ok(sink) => match sink
                .read_prior_emitted(session_id, thread_id.to_owned())
                .await
            {
                Ok(counts) => return counts,
                Err(error) => describe_error(error.as_ref()),
            },
            Err(error) => describe_error(&error),
        };
        report(
            session_id,
            DriverDiagnosticKind::UsageResumeBaseUnavailable,
            None,
            "the daemon's own emitted usage sum could not be read, so the resumed thread meters \
             from zero and its first reading counts what came before again",
            [
                ("threadId", Value::from(thread_id)),
                ("failure", Value::from(failure)),
            ],
        );
        UsageAxisCounts::default()
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

// The change one frame's usage makes to its thread's sum; `None` for a frame that carries none, a
// thread with no base, or a reading that changes nothing.
fn meter(
    band: &mut ClaudeSessionRoutingBand,
    frame: &ClaudeRoutableFrame,
) -> Option<ClaudeMeteredReading> {
    let observation = &frame.observation;
    let base = band.accountant.base_registers(&frame.thread_id)?;
    let messages = band
        .usage_tally
        .threads
        .entry(frame.thread_id.clone())
        .or_insert_with(|| ClaudeThreadMessages::starting_at(base));
    let cumulative = match (&observation.message_usage, &observation.cumulative_usage) {
        (Some(message), _) => messages.observe_message(&message.message_id, message.counts),
        (None, Some(turn)) => messages.confirm_turn(turn.cumulative),
        (None, None) => return None,
    };
    let delta = band.accountant.meter_reading(CumulativeUsageReading {
        thread_id: frame.thread_id.clone(),
        named_turn_id: None,
        cumulative,
        declared_per_turn: None,
    })?;
    let axes = &delta.axis_deltas;
    let is_unchanged = [
        axes.input,
        axes.cached_input,
        axes.cache_write_input,
        axes.output,
        axes.reasoning_output,
        axes.total,
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
    let axis = |left: Option<u64>, right: Option<u64>| match (left, right) {
        (Some(left), Some(right)) => Some(combine(left, right)),
        (left, right) => left.or(right),
    };
    UsageAxisCounts {
        input: axis(left.input, right.input),
        cached_input: axis(left.cached_input, right.cached_input),
        cache_write_input: axis(left.cache_write_input, right.cache_write_input),
        output: axis(left.output, right.output),
        reasoning_output: axis(left.reasoning_output, right.reasoning_output),
        total: axis(left.total, right.total),
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
    let observation = &frame.observation;
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
