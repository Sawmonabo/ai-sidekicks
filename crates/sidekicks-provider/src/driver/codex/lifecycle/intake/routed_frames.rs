//! Applying what a session's frame delivery reported, in delivery order, its spend attributed to
//! the binding it files on.

use std::sync::Arc;

use sidekicks_contracts::event::usage::UsageContextWindowUpdatedPayload;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::{ProviderTurnId, TurnUsageUpdate};
use sidekicks_contracts::wire::integer::SafeInt;

use crate::driver::codex::delivery::frames::{CodexFrameDelivery, find_turn_run_id};
use crate::driver::codex::event_normalizer::CODEX_THREAD_TOKEN_USAGE_METHOD;
use crate::driver::codex::notification_routing::{CodexContextWindowReading, CodexRoutedFrames};
use crate::driver::codex::run::control::CodexRunControl;
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::run::steer::{remember_codex_prompt_hook_run, take_blocked_codex_steers};
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::peer_delivery::CodexPeerMessages;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::ports::DriverPorts;
use crate::port::run_host::RunHost;
use crate::port::session_message_reading_publisher::SessionMessageReading;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner};
use crate::run::delivery::{DeliveryBinding, InboundDelivery, LateAppendableRow};
use crate::run::turn_end::ProviderTurnEnd;
use crate::usage_delta_accountant::{MeteredUsageDelta, WindowTelemetry};

/// What applying a delivery's report acts through, borrowed from the driver's parts.
pub(crate) struct CodexRoutedFramesIntake<'parts> {
    /// The queue's intake of taken, refused and given-back messages, and the usage record.
    pub(crate) ports: &'parts DriverPorts,
    /// The run engine an ended turn's end is recorded in.
    pub(crate) engine: &'parts Arc<dyn RunHost>,
    /// The run routes an ended turn's route is retired from.
    pub(crate) run_routes: &'parts CodexRunRoutes,
    /// The run control an ended turn's pause or continue is acted on through.
    pub(crate) run_control: &'parts Arc<CodexRunControl>,
    /// The config forks an ended turn lets an owed fork go on.
    pub(crate) config_forks: &'parts Arc<CodexConfigForks>,
    /// The frame delivery a context-window reading's row goes out through.
    pub(crate) delivery: &'parts CodexFrameDelivery,
    /// The daemon's own messages each session was handed, whose readings go to the session
    /// message readings instead of the queue.
    pub(crate) peer_messages: &'parts CodexPeerMessages,
}

/// Applies what a delivery reported on `record`'s session, in delivery order: each context-window
/// reading filed on its run and each metered delta attributed to its binding before any turn's end
/// retires the route, each live turn's tokens received published, the queue told of each steer
/// Codex echoed, which its frame already landed, each prompt's hook runs remembered, each turn's
/// task list published, and for each ended turn its blocked steers refused and those a pause or a
/// retry dropped given back, its end recorded where no run moved, its route retired, its pause or
/// continue acted on and its owed fork let go. A message of the daemon's own, echoed as a steer or
/// as its turn's opening, refused or given back, reads so on the session message readings and
/// never reaches the queue. Answers the spend it metered, for the session's task to record.
pub(crate) async fn apply_codex_routed_frames(
    intake: &CodexRoutedFramesIntake<'_>,
    record: &mut CodexSessionRecord,
    routed: CodexRoutedFrames,
) -> Vec<MeteredUsage> {
    let session_id = record.session_id;
    // Each reading's run is read before a turn's end in the same batch retires its route.
    for reading in routed.context_windows {
        file_context_window(intake, record, reading).await;
    }
    let mut metered_usage = Vec::with_capacity(routed.metered_usage.len());
    for delta in routed.metered_usage {
        publish_turn_usage(intake, record, &delta);
        let owner_thread = delta.thread_id.clone();
        // The stream's reading ran on the account the record carries at its place in the frames.
        let ran_on = Some(record.provider_account_id.clone());
        metered_usage.extend(attribute_codex_usage(
            intake,
            record,
            &owner_thread,
            delta,
            ran_on,
        ));
    }
    for dispatch in routed.dispatches {
        if let Some(publisher) = intake.ports.turn_readings.port() {
            for tasks in dispatch.turn_tasks {
                publisher.publish_turn_tasks(session_id, tasks);
            }
        }
        for taken in dispatch.taken_messages {
            // The daemon's own message is delivered once echoed, and never reaches the queue.
            if settle_echoed(intake, session_id, taken.message_id) {
                continue;
            }
            let run_id = record
                .active_turn_run(&taken.turn_id)
                .or_else(|| record.interrupted_turn_run(&taken.turn_id));
            // Before the queue registers its intake there is no queue to tell.
            if let (Some(run_id), Some(listener)) = (run_id, intake.ports.message_taken.port()) {
                listener.message_taken(session_id, &taken.message_id.to_string(), run_id);
            }
        }
        for echoed in dispatch.unsteered_echoes {
            settle_echoed(intake, session_id, echoed);
        }
        for hook_run in dispatch.prompt_hook_runs {
            remember_codex_prompt_hook_run(record, hook_run);
        }
        for ended in dispatch.turns_ended {
            // Before the queue registers its intake there is no queue to tell.
            let steers = take_blocked_codex_steers(record, &ended.turn_id, ended.ending);
            let refusals = intake.ports.message_refused.port();
            for (message_id, words) in steers.refused {
                if intake.peer_messages.settle(session_id, message_id) {
                    publish_reading(
                        intake,
                        SessionMessageReading::Refused {
                            message_id: message_id.to_string(),
                            reason: Some(words.into_string()),
                            drop_reason: None,
                        },
                    );
                } else if let Some(listener) = refusals {
                    listener.message_refused(
                        session_id,
                        &message_id.to_string(),
                        QueueItemNotDeliveredReason::RefusedByHook { words },
                    );
                }
            }
            let give_backs = intake.ports.message_given_back.port();
            for message_id in steers.dropped {
                // The daemon's own message goes back for the paused session's queue, never lost.
                if intake.peer_messages.settle(session_id, message_id) {
                    publish_reading(
                        intake,
                        SessionMessageReading::GivenBack {
                            message_id: message_id.to_string(),
                        },
                    );
                } else if let Some(listener) = give_backs {
                    listener.message_given_back(session_id, &message_id.to_string());
                }
            }
            if let Some(listener) = intake.ports.continue_given_back.port() {
                for lead_run_id in dispatch.continues_given_back.iter().copied() {
                    listener.continue_given_back(session_id, lead_run_id);
                }
            }
            if let Some(turn_end) = ended.turn_end {
                record_turn_end(intake.engine.as_ref(), ended.run_id, turn_end).await;
            }
            // By turn id, never run id, so a stale end cannot retire a newer turn.
            intake.run_routes.retire_turn_route(record, &ended.turn_id);
            record.forget_interrupted_run(&ended.turn_id);
            // A pause's stopped turn is let go first, so an owed fork starts here, ahead of its
            // continue.
            intake
                .run_control
                .observe_turn_ended(record, &ended.turn_id)
                .await;
            intake.config_forks.note_turn_settled(record);
        }
    }
    metered_usage
}

// Settles an echoed message the daemon handed `session_id` as delivered, answering whether it was
// one; a message the daemon never handed is left to the queue.
fn settle_echoed(
    intake: &CodexRoutedFramesIntake<'_>,
    session_id: SessionId,
    message_id: QueueItemId,
) -> bool {
    if !intake.peer_messages.settle(session_id, message_id) {
        return false;
    }
    publish_reading(
        intake,
        SessionMessageReading::Delivered {
            message_id: message_id.to_string(),
        },
    );
    true
}

// Publishes one reading of a message of the daemon's own; one made before the readings are
// registered is dropped.
fn publish_reading(intake: &CodexRoutedFramesIntake<'_>, reading: SessionMessageReading) {
    if let Some(publisher) = intake.ports.session_message_readings.port() {
        publisher.publish(reading);
    }
}

// Adds a delta of the session's own conversation to its live turn's tokens received and publishes
// the turn's figure; a delta that adds nothing publishes nothing, and a turn already ended keeps
// no reading.
fn publish_turn_usage(
    intake: &CodexRoutedFramesIntake<'_>,
    record: &mut CodexSessionRecord,
    delta: &MeteredUsageDelta,
) {
    if delta.thread_id != record.thread_id {
        return;
    }
    let Some(turn_id) = delta.attributed_turn_id.as_deref() else {
        return;
    };
    let Some(output_tokens) = delta.axis_deltas.output.filter(|tokens| *tokens > 0) else {
        return;
    };
    if record.is_turn_settled(turn_id) {
        return;
    }
    let Some((run_id, _ending)) = find_turn_run_id(record, turn_id) else {
        return;
    };
    let tokens_received = record
        .delivery
        .turn_readings
        .add_output_tokens(turn_id, output_tokens);
    let (Some(publisher), Ok(turn_id), Some(tokens_received)) = (
        intake.ports.turn_readings.port(),
        ProviderTurnId::new(turn_id.to_owned()),
        SafeInt::new(tokens_received),
    ) else {
        return;
    };
    publisher.publish_turn_usage(
        record.session_id,
        TurnUsageUpdate {
            run_id,
            turn_id,
            tokens_received,
        },
    );
}

/// The usage record's entry for a metered delta spent on `owner_thread` under
/// `provider_account_id`, the account its turn ran on: a helper's conversation's on its child
/// run's binding as that helper's own, any other on the binding of the run its turn belongs to,
/// else the session's. One with no binding to file on is logged and left unrecorded.
pub(super) fn attribute_codex_usage(
    intake: &CodexRoutedFramesIntake<'_>,
    record: &CodexSessionRecord,
    owner_thread: &str,
    delta: MeteredUsageDelta,
    provider_account_id: Option<ProviderAccountId>,
) -> Option<MeteredUsage> {
    if let Some(child) = record.delivery.child_run_by_thread_id.get(owner_thread) {
        return Some(MeteredUsage {
            session_id: record.session_id,
            binding_id: child.binding_id.clone(),
            owner: MeteredUsageOwner::Helper(child.subagent_id.clone()),
            delta,
            provider_account_id,
        });
    }
    let (_run_id, binding_id) =
        find_filing_binding(intake, record, delta.attributed_turn_id.as_deref());
    let Some(binding_id) = binding_id else {
        tracing::warn!("a codex usage reading has no binding to file on");
        return None;
    };
    Some(MeteredUsage {
        session_id: record.session_id,
        binding_id,
        owner: MeteredUsageOwner::Run,
        delta,
        provider_account_id,
    })
}

// The run a frame of the session's own conversation naming `turn_id` belongs to, and the binding
// it files on: that run's, else the session's, which a run's turn start adopts.
fn find_filing_binding(
    intake: &CodexRoutedFramesIntake<'_>,
    record: &CodexSessionRecord,
    turn_id: Option<&str>,
) -> (Option<RunId>, Option<RuntimeBindingId>) {
    let run_id = turn_id
        .and_then(|turn_id| find_turn_run_id(record, turn_id))
        .map(|(run_id, _ending)| run_id);
    let binding_id = run_id
        .and_then(|run_id| intake.run_routes.binding_for(run_id))
        .map(|binding| binding.binding_id)
        .or_else(|| record.binding_id.clone());
    (run_id, binding_id)
}

// Writes the end of a turn that moved no run; a failed write is logged, the turn already gone.
async fn record_turn_end(engine: &dyn RunHost, run_id: RunId, turn_end: ProviderTurnEnd) {
    if let Err(error) = engine.record_turn_end(run_id, turn_end).await {
        tracing::warn!(
            error = &*error as &(dyn std::error::Error + 'static),
            %run_id,
            "the end of a codex turn that moved no run could not be recorded"
        );
    }
}

// Files a context-window reading of the session's conversation on the run holding its turn, on
// that run's binding, else on the session's, which a run's turn start adopts, since the delivery
// of a turn's end in the same batch already let the run's binding go; a reading no run holds
// files with no run. One with no binding to file on is dropped, logged.
async fn file_context_window(
    intake: &CodexRoutedFramesIntake<'_>,
    record: &CodexSessionRecord,
    reading: CodexContextWindowReading,
) {
    let (run_id, binding_id) = find_filing_binding(intake, record, reading.turn_id.as_deref());
    let Some(binding_id) = binding_id else {
        tracing::debug!("a codex context-window reading has no binding to file on");
        return;
    };
    let (window_source, exceeded, counts) = match reading.window {
        WindowTelemetry::Counted {
            window_source,
            exceeded,
            window_used_tokens,
            window_max_tokens,
        } => (
            window_source,
            exceeded,
            SafeInt::new(window_used_tokens).zip(SafeInt::new(window_max_tokens)),
        ),
        WindowTelemetry::CountsAbsent {
            window_source,
            exceeded,
        } => (window_source, exceeded, None),
    };
    let row = LateAppendableRow::UsageContextWindowUpdated(UsageContextWindowUpdatedPayload {
        session_id: record.session_id,
        run_id,
        window_used_tokens: counts.map(|(used, _max)| used),
        window_max_tokens: counts.map(|(_used, max)| max),
        window_source,
        exceeded,
        model_id: None,
        subagent_id: None,
        source_epoch: None,
        source_position: None,
    });
    let delivery = InboundDelivery::SessionRow {
        binding: DeliveryBinding {
            binding_id,
            operation: None,
        },
        row,
        content: None,
    };
    // A refused row is reported by the send.
    let _filed = intake
        .delivery
        .send(record, delivery, CODEX_THREAD_TOKEN_USAGE_METHOD)
        .await;
}
