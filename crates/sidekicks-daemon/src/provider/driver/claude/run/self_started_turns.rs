//! A turn Claude Code starts by itself, with a message a turn ended without taking or when a
//! background command it ran ends: no run or command holds the session's turn when its
//! `system/init` arrives, so the session's own run opens for it, awaited on the session's task so
//! no later arrival reaches the run engine before the run exists. A paused lead run takes the turn
//! itself, since its pause stops that turn again. A turn whose run cannot open is interrupted, so
//! no turn runs with no run.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error_description::describe_error;
use crate::mutex_lock::lock;
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
    /// Reads one frame on the session's task: a turn's `system/init` that nothing held the
    /// session's turn for, as it was read and now (a helper's aside), gets its run before the frame
    /// goes on. A run that cannot open is recorded, and the turn interrupted unless a run started
    /// meanwhile holds it or the process is gone; the interrupt's failure is recorded too.
    pub(crate) async fn open_for_frame(
        &self,
        live: &Arc<LiveClaudeSession>,
        frame_kind: &str,
        text: &str,
        is_held_at_read: bool,
    ) {
        let session_id = live.session_id;
        let routes = &self.start.routes;
        if frame_kind != CLAUDE_TURN_START_FRAME_KIND
            || is_held_at_read
            || routes.is_turn_held(session_id)
        {
            return;
        }
        let frame = serde_json::from_str::<TurnStartFrame>(text).unwrap_or_default();
        if frame
            .parent_tool_use_id
            .is_some_and(|parent| !parent.is_empty())
        {
            return;
        }
        let paused = lock(&self.pauses).reported_lead_pause(&session_id).copied();
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

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::provider::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
    };
    use crate::provider::port::run_host::test_host::EngineCall;
    use crate::provider::run::state_entry::RunStateEntry;

    fn turn() -> [Value; 3] {
        [
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            }),
            json!({
                "type": "assistant",
                "session_id": SCRIPTED_PROVIDER_SESSION_ID,
                "message": {
                    "id": "message-1",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call-1",
                            "name": "Bash",
                            "input": {"command": "ls"},
                        },
                    ],
                },
            }),
            json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "result": "done",
                "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            }),
        ]
    }

    // Killed by letting the turn's next frames go before its run exists, which drops them as a
    // turn no run holds, and by leaving a turn whose run could not open running with none.
    #[tokio::test(start_paused = true)]
    async fn a_turn_claude_code_starts_itself_runs_on_its_own_run_or_is_interrupted() {
        let session = ScriptedSession::new().await;
        for frame in turn() {
            session.frame(&frame);
        }
        settle().await;

        let calls = session.engine.calls();
        let Some(EngineCall::StartDaemonTurn(run_id)) = calls.first().cloned() else {
            unreachable!("the turn's run opens before anything else")
        };
        assert!(calls.contains(&EngineCall::CountStep(run_id)));
        let deliveries = session.engine.deliveries();
        assert!(
            deliveries
                .iter()
                .all(|delivery| delivery.binding_id == Some(binding_id("daemon-turn")))
        );
        let moves: Vec<_> = deliveries
            .into_iter()
            .filter_map(|delivery| delivery.change)
            .map(|change| (change.run_id, change.entry))
            .collect();
        assert_eq!(
            moves,
            [(
                run_id,
                RunStateEntry::Completed {
                    intended_close: None
                }
            )]
        );

        let refused = ScriptedSession::new().await;
        refused.engine.fail_daemon_turns();
        refused.frame(&turn()[0]);
        settle().await;
        let requests = refused.channel.control_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["subtype"], "interrupt");
    }
}
