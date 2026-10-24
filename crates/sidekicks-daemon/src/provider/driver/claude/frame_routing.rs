//! Each Claude Code frame through its session's routing band, on the reader under the band's
//! lock: the thread router decides whether it projects, the usage accountant meters it, a helper's
//! `task_started` and `task_notification` register and complete its child thread, and the session
//! thread's own handshake and compaction boundary are tapped.

use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;
use tokio::time::Instant;

use crate::error_description::describe_error;
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::event_normalizer::{
    ClaudeSubagentSignal, classify_claude_frame_family_for_routing,
    normalize_claude_subagent_lifecycle,
};
use crate::provider::driver::claude::handshake_register::{
    ClaudeHandshakeRegister, ClaudeSettledOutputSpeed,
};
use crate::provider::driver::claude::session::state::{
    ClaudeRoutableFrame, ClaudeSessionRoutingBand, ClaudeUsageEstablishment,
};
use crate::provider::driver::claude::session::transport::declarations;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::usage_sink::UsageSink;
use crate::provider::thread_frame_router::{
    ChildRegistrationResult, ChildSpendAttribution, SubagentLifecycleEmission,
    SubagentLifecycleEventType, ThreadFrameRoute,
};
use crate::provider::usage_delta_accountant::{
    CumulativeUsageReading, ThreadBaseEstablishment, UsageAxisCounts,
};

/// What the routing band read off one frame: its route, the helper starts and ends it reports,
/// in order, and the output speed its handshake settled for the armed run.
#[derive(Debug)]
pub(crate) struct ClaudeRoutedObservation {
    /// The router's decision.
    pub(crate) route: ThreadFrameRoute,
    /// Each helper that started or ended, a start ahead of the frame's own rows.
    pub(crate) helper_lifecycle: Vec<SubagentLifecycleEmission>,
    /// The output speed the session thread's handshake settled, for the run engine.
    pub(crate) settled_output_speed: Option<ClaudeSettledOutputSpeed>,
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
    pub(crate) fn bind_session_thread(
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
                    .read_prior_emitted(session_id, prior_emitted_thread_id),
            },
        };
        band.accountant
            .establish_thread(provider_session_id.to_owned(), base);
        let released = band
            .router
            .register_session_thread(provider_session_id.to_owned());
        self.route_released(band, session_id, released);
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
            settled_output_speed: None,
        };
        // Only the session's own thread counts; a helper's handshake or compaction says nothing
        // about the session's process.
        if observation.subagent_id.is_none() {
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
        self.apply_route(band, session_id, &frame, &route, &mut routed);
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
        self.route_released(band, session_id, released_frames);
    }

    // Routes again each frame a registration released, metering what it carried; its rows were
    // a helper's own, which the session's transcript never shows.
    fn route_released(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        released: Vec<ClaudeRoutableFrame>,
    ) {
        for frame in released {
            let route = band.router.route_frame(&frame, Instant::now());
            let mut ignored = ClaudeRoutedObservation {
                route: ThreadFrameRoute::Quarantined,
                helper_lifecycle: Vec::new(),
                settled_output_speed: None,
            };
            self.apply_route(band, session_id, &frame, &route, &mut ignored);
        }
    }

    // Usage is metered ahead of suppression, so a helper's spend counts though its rows do not;
    // a helper's end completes its child thread.
    fn apply_route(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        frame: &ClaudeRoutableFrame,
        route: &ThreadFrameRoute,
        routed: &mut ClaudeRoutedObservation,
    ) {
        match route {
            ThreadFrameRoute::Project
            | ThreadFrameRoute::RouteConnectionScoped
            | ThreadFrameRoute::CarveOutUsage { .. } => {
                self.meter(band, session_id, frame);
                complete_helper(band, frame, routed);
            }
            ThreadFrameRoute::ChildTranscript { .. } => complete_helper(band, frame, routed),
            // The router records a held or quarantined frame itself; an ask travels as a request.
            ThreadFrameRoute::CarveOutInteractiveRequest { .. }
            | ThreadFrameRoute::HeldPendingRegistration
            | ThreadFrameRoute::Quarantined => {}
        }
    }

    fn meter(
        &self,
        band: &mut ClaudeSessionRoutingBand,
        session_id: SessionId,
        frame: &ClaudeRoutableFrame,
    ) {
        let Some(usage) = &frame.observation.cumulative_usage else {
            return;
        };
        let Some(metered) = band.accountant.meter_reading(CumulativeUsageReading {
            thread_id: frame.thread_id.clone(),
            named_turn_id: usage.named_turn_id.clone(),
            cumulative: usage.cumulative,
            declared_per_turn: usage.declared_per_turn,
        }) else {
            return;
        };
        if let Some(sink) = self.usage.port() {
            sink.record_metered(session_id, metered);
        }
    }

    // The daemon's own sum for a resumed thread; an unregistered usage record or a failed read is
    // recorded, the base then zero, so the first reading meters what came before again.
    fn read_prior_emitted(&self, session_id: SessionId, thread_id: &str) -> UsageAxisCounts {
        let failure = match self.usage.require_port() {
            Ok(sink) => match sink.read_prior_emitted(session_id, thread_id) {
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

// Completes a helper's child thread on its end, its only close signal, and reports the end once
// for a helper the router held.
fn complete_helper(
    band: &mut ClaudeSessionRoutingBand,
    frame: &ClaudeRoutableFrame,
    routed: &mut ClaudeRoutedObservation,
) {
    let Some(signal) = &frame.observation.subagent_lifecycle else {
        return;
    };
    if signal.signal == ClaudeSubagentSignal::SubagentStart {
        return;
    }
    let attribution = band
        .router
        .child_attribution_for(&signal.subagent_id)
        .cloned();
    if !band.router.complete_child_thread(&signal.subagent_id) {
        return;
    }
    band.accountant.release_thread(&signal.subagent_id);
    if let Some(ChildSpendAttribution::Subagent { subagent_id }) = attribution {
        routed.helper_lifecycle.push(SubagentLifecycleEmission {
            event_type: SubagentLifecycleEventType::Completed,
            subagent_id,
            parent_tool_call_id: signal.parent_tool_use_id.clone(),
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
