//! A compaction the person asks for on Claude Code: its own `/compact` command, which Claude Code
//! runs as a turn of its own, so the command holds the session's turn until that turn settles. It
//! is applied only on the typed compaction frame that proves it ran.

use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::compaction::{
    AgentRunContextCompactResponse, CompactionFailure, CompactionRefusal,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::error_description::describe_error;
use crate::provider::compaction_wait::{CompactionWaitTerminal, PendingCompactionRegistry};
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::provider::driver::claude::run::routes::ClaudeRunRoutes;
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason,
};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, ClaudeWriteDelivery, compose_claude_user_frame,
};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::outbound_text::{OutboundText, OutboundTextOrigin};

// Bare, as `system/init` lists `slash_commands`.
const CLAUDE_COMPACTION_COMMAND_NAME: &str = "compact";

/// Sends `/compact` on a live session whose handshake lists it and answers `applied` only on the
/// typed compaction frame, recording every other end as a diagnostic.
pub(crate) async fn compact_claude_context(
    live: &LiveClaudeSession,
    handshakes: &ClaudeHandshakeRegister,
    routes: &ClaudeRunRoutes,
    pending_compactions: &PendingCompactionRegistry,
) -> Result<AgentRunContextCompactResponse, ClaudeSessionError> {
    let session_id = live.session_id;
    let is_listed = handshakes
        .held_handshake_for(session_id, &live.provider_session_id)
        .is_some_and(|held| {
            held.invocable_command_names
                .contains(CLAUDE_COMPACTION_COMMAND_NAME)
        });
    if !is_listed {
        return Ok(AgentRunContextCompactResponse::Refused {
            reason: CompactionRefusal::CommandAbsent,
        });
    }
    // Held before the write, so no run starts into the command's turn, whose `result` would end
    // it.
    if routes.is_turn_held(session_id) || routes.hold_turn_for_command(session_id).is_err() {
        return Err(ClaudeSessionError::Unavailable {
            reason: ClaudeSessionUnavailableReason::SessionTurnInFlight,
            detail: None,
            session_id: Some(session_id),
            run_id: None,
        });
    }
    // Armed before the write so a fast compaction is not lost; dropped, it is withdrawn.
    let wait = pending_compactions.arm(&session_id.to_string());
    let frame = compose_claude_user_frame(
        &OutboundText {
            text: format!("/{CLAUDE_COMPACTION_COMMAND_NAME}"),
            origin: OutboundTextOrigin::DriverCommand,
        },
        mint_uuid_v7().to_string(),
        Vec::new(),
    );
    if let ClaudeWriteAttempt::Failed { delivery, cause } =
        live.channel.write_user_frame(frame).await
    {
        // Text that never left starts no turn to release the hold; bytes that may have been taken
        // can still start one, whose end releases it.
        if delivery == ClaudeWriteDelivery::Unsent {
            routes.release_command_turn(session_id);
        }
        drop(wait);
        record_wait_end(
            live,
            describe_error(&cause),
            "providerError",
            Some(match delivery {
                ClaudeWriteDelivery::Unsent => "unsent",
                ClaudeWriteDelivery::Indeterminate => "indeterminate",
            }),
        );
        return Ok(AgentRunContextCompactResponse::Failed {
            reason: CompactionFailure::ProviderError,
        });
    }
    let settled = wait.settled().await;
    let reason = match settled.terminal {
        CompactionWaitTerminal::Observed => {
            return Ok(AgentRunContextCompactResponse::Applied {
                boundary_position: settled.boundary_position.and_then(SafeInt::new),
            });
        }
        CompactionWaitTerminal::NotCompacted => CompactionFailure::NotCompacted,
        CompactionWaitTerminal::BindingLost => CompactionFailure::BindingLost,
    };
    record_wait_end(
        live,
        settled
            .terminal
            .failure_detail()
            .unwrap_or_default()
            .to_owned(),
        match reason {
            CompactionFailure::NotCompacted => "notCompacted",
            CompactionFailure::BindingLost => "bindingLost",
            CompactionFailure::ProviderError => "providerError",
        },
        None,
    );
    Ok(AgentRunContextCompactResponse::Failed { reason })
}

// An applied compaction is ordinary success; every other end is recorded, a failed write with how
// far it got: `unsent` never reached Claude Code, `indeterminate` may have run with its answer lost.
fn record_wait_end(
    live: &LiveClaudeSession,
    reason: String,
    terminal: &str,
    delivery: Option<&str>,
) {
    let mut details = Map::from_iter([
        (
            "sessionId".to_owned(),
            Value::from(live.session_id.to_string()),
        ),
        ("terminal".to_owned(), Value::from(terminal)),
    ]);
    if let Some(delivery) = delivery {
        details.insert("delivery".to_owned(), Value::from(delivery));
    }
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: live.admitted_provider_account_id.clone(),
        kind: DriverDiagnosticKind::CompactionWaitTerminal,
        raw_wire_type: None,
        disposition_reason: reason,
        details,
    });
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::provider::driver::compaction::{
        AgentRunContextCompactResponse, CompactionFailure,
    };

    use super::compact_claude_context;
    use crate::provider::compaction_wait::PendingCompactionRegistry;
    use crate::provider::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession,
    };
    use crate::provider::driver::claude::session::transport::declarations::ClaudeHandshakeDeclaration;
    use crate::provider::driver::claude::session::transport::user_message::ClaudeWriteDelivery;

    // Killed by keeping the command's hold after a write that never left, which would refuse every
    // later run on the session, and by releasing it after one Claude Code may still run.
    #[tokio::test(start_paused = true)]
    async fn a_compaction_that_never_reached_claude_code_releases_the_session_turn() {
        for (delivery, is_held_after) in [
            (ClaudeWriteDelivery::Unsent, false),
            (ClaudeWriteDelivery::Indeterminate, true),
        ] {
            let session = ScriptedSession::new();
            session.start.handshakes.observe_handshake_declaration(
                session.session_id,
                SCRIPTED_PROVIDER_SESSION_ID,
                ClaudeHandshakeDeclaration {
                    slash_commands: vec!["compact".to_owned()],
                    ..ClaudeHandshakeDeclaration::default()
                },
            );
            session.channel.fail_next_user_write(delivery);

            let response = compact_claude_context(
                &session.live,
                &session.start.handshakes,
                &session.start.routes,
                &PendingCompactionRegistry::default(),
            )
            .await
            .expect("the compaction answers");

            assert_eq!(
                response,
                AgentRunContextCompactResponse::Failed {
                    reason: CompactionFailure::ProviderError
                }
            );
            assert_eq!(
                session.start.routes.is_turn_held(session.session_id),
                is_held_after
            );
        }
    }
}
