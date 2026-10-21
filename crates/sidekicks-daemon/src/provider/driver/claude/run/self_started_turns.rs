//! A turn Claude Code starts by itself, with a message a turn ended without taking or when a
//! background command it ran ends: no run or command holds the session's turn when its
//! `system/init` arrives, so the session's own run opens for it, awaited on the session's task so
//! no later arrival reaches the run engine before the run exists. A paused lead run takes the turn
//! itself, since its pause stops that turn again. A turn whose run cannot open is interrupted, so
//! no turn runs with no run.

use std::sync::{Arc, Mutex, PoisonError};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error_description::describe_error;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::provider::driver::claude::intervention::send_claude_interrupt;
use crate::provider::driver::claude::run::start::{ClaudeDaemonTurnOpening, ClaudeRunStart};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::lenient_json::{lenient_object, read_lenient};

// The frame that starts each turn.
const CLAUDE_TURN_START_FRAME_KIND: &str = "system/init";

#[derive(Default, Deserialize)]
struct TurnStartFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    parent_tool_use_id: Option<String>,
}

lenient_object!(TurnStartFrame);

/// Opens the session's own run for each turn Claude Code starts by itself.
pub(crate) struct ClaudeSelfStartedTurns {
    /// Starts the session's own run.
    pub(crate) start: ClaudeRunStart,
    /// Every session's pauses, whose reported lead pause takes such a turn itself.
    pub(crate) pauses: Arc<Mutex<ClaudeRunPauses>>,
}

impl ClaudeSelfStartedTurns {
    /// Reads one frame on the session's task: a turn's `system/init` while nothing holds the
    /// session's turn (a helper's aside) gets its run before the frame goes on. A run that cannot
    /// open is recorded, and the turn interrupted unless a run started meanwhile holds it or the
    /// process is gone; the interrupt's failure is recorded too.
    pub(crate) async fn open_for_frame(
        &self,
        live: &Arc<LiveClaudeSession>,
        frame_kind: &str,
        text: &str,
    ) {
        let session_id = live.session_id;
        let routes = &self.start.routes;
        if frame_kind != CLAUDE_TURN_START_FRAME_KIND || routes.is_turn_held(session_id) {
            return;
        }
        let frame = serde_json::from_str::<TurnStartFrame>(text).unwrap_or_default();
        if frame
            .parent_tool_use_id
            .is_some_and(|parent| !parent.is_empty())
        {
            return;
        }
        let paused = self
            .pauses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .reported_lead_pause(&session_id)
            .copied();
        if paused.is_some_and(|run_id| routes.hold_turn_again(run_id).is_ok()) {
            return;
        }
        let Err(error) = self
            .start
            .start_daemon_turn(session_id, ClaudeDaemonTurnOpening::Provider)
            .await
        else {
            return;
        };
        report(live, "no run could open for it", &describe_error(&error));
        let is_gone = !self
            .start
            .slots
            .live_session(session_id)
            .is_some_and(|current| Arc::ptr_eq(&current, live));
        // A run that started meanwhile holds the turn and takes its frames.
        if routes.is_turn_held(session_id) || is_gone {
            return;
        }
        if let Err(error) = send_claude_interrupt(live, false).await {
            report(live, "its interrupt failed", &describe_error(&error));
        }
    }
}

fn report(live: &LiveClaudeSession, what: &str, cause: &str) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: live.admitted_provider_account_id.clone(),
        kind: DriverDiagnosticKind::UnmappedWireKind,
        raw_wire_type: Some(CLAUDE_TURN_START_FRAME_KIND.to_owned()),
        disposition_reason: format!("a turn Claude Code started by itself: {what}"),
        details: Map::from_iter([
            (
                "sessionId".to_owned(),
                Value::from(live.session_id.to_string()),
            ),
            ("cause".to_owned(), Value::from(cause)),
        ]),
    });
}
