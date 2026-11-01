//! A Claude Code process's MCP server readings, reported on the status sink its spawn was bound
//! to. Claude Code pushes no status of its own, so they come from the `system/init` list and from
//! `mcp_status`, asked at a turn's end while a server still starts or reads unknown (servers set
//! up from `--mcp-config` may still be starting as the first turn runs) and on a refresh; never on
//! a timer. The process's end ends its leg once.

use std::collections::HashMap;

use serde_json::json;
use sidekicks_contracts::mcp::server::McpServerStatus;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::session::transport::mcp_status::ClaudeMcpStatusReply;
use crate::driver::claude::tools::normalize_claude_mcp_status_reply;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::mcp_server::status::{McpServerReading, McpServerStatusIngestResult};

/// What one process's leg holds: the last reading of each server it reported, by name, and
/// whether the leg has ended. Its lock is never held across an await.
#[derive(Debug, Default)]
pub(crate) struct ClaudeMcpServerReadings {
    last_readings: HashMap<String, McpServerReading>,
    is_ended: bool,
}

impl LiveClaudeSession {
    /// Reports one read of the process's servers on its leg, `wire_type` naming the frame or
    /// answer it came from: each emission reaches the status sink, each rejection is recorded, and
    /// the readings replace the last ones. Nothing is reported once the leg has ended, or for a
    /// process whose spawn was bound to no sink.
    pub(crate) fn report_mcp_servers(&self, read: &McpServerStatusIngestResult, wire_type: &str) {
        for rejection in &read.rejections {
            emit_driver_diagnostic(&DriverDiagnosticRecord {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id: Some(self.admitted_provider_account_id.clone()),
                kind: DriverDiagnosticKind::McpServerStatusRejected,
                raw_wire_type: Some(wire_type.to_owned()),
                disposition_reason: rejection.reason.clone(),
                details: [("sessionId".to_owned(), json!(self.session_id))]
                    .into_iter()
                    .collect(),
            });
        }
        let Some(sink) = &self.spawn_bound_legs.on_mcp_server_status else {
            return;
        };
        // Held while the sink takes the readings, so an end between the check and a report never
        // lets a reading through after the leg ended; the sink returns at once.
        let mut readings = lock(&self.mcp_server_readings);
        if readings.is_ended {
            return;
        }
        readings.last_readings = read
            .emissions
            .iter()
            .map(|emission| (emission.server_name.as_str().to_owned(), emission.reading))
            .collect();
        for emission in &read.emissions {
            sink.report_status(emission.clone());
        }
    }

    /// Whether a turn's end asks for the servers' status: while the leg is live and any server it
    /// reported last read starting or unknown.
    pub(crate) fn is_any_mcp_server_unsettled(&self) -> bool {
        let readings = lock(&self.mcp_server_readings);
        self.spawn_bound_legs.on_mcp_server_status.is_some()
            && !readings.is_ended
            && readings.last_readings.values().any(|reading| {
                matches!(
                    reading,
                    McpServerReading::Observed(
                        McpServerStatus::Starting | McpServerStatus::Unknown
                    )
                )
            })
    }

    /// Reads the status of each MCP server the process holds with `mcp_status` and reports it on
    /// the process's leg; the refresh of a live leg calls it too. A process whose spawn was bound
    /// to no sink, or whose leg ended, is not asked; a refused or unanswered read is recorded and
    /// changes no reading.
    pub(crate) async fn read_mcp_status(&self) {
        if self.spawn_bound_legs.on_mcp_server_status.is_none()
            || lock(&self.mcp_server_readings).is_ended
        {
            return;
        }
        let answer = match self
            .channel
            .send_control_request(ClaudeControlRequest::McpStatus {})
            .await
        {
            Ok(answer) => answer,
            Err(error) => {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    self.session_id,
                    "the MCP server status read",
                    &error,
                );
                return;
            }
        };
        let reply = ClaudeMcpStatusReply::read(answer.response.as_deref());
        if let Some(read) = normalize_claude_mcp_status_reply(&reply) {
            self.report_mcp_servers(&read, "mcp_status");
        }
    }

    /// Ends the process's leg on its status sink, once, as the process ends; a read answered
    /// after it reports nothing.
    pub(crate) fn end_mcp_server_leg(&self) {
        let Some(sink) = &self.spawn_bound_legs.on_mcp_server_status else {
            return;
        };
        let mut readings = lock(&self.mcp_server_readings);
        if std::mem::replace(&mut readings.is_ended, true) {
            return;
        }
        readings.last_readings.clear();
        sink.end_leg();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpServerStatus;
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_std::mutex_lock::lock;

    use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
    use crate::driver::claude::session::scripted::driver::{ScriptedDriver, create_params};
    use crate::driver::claude::session::scripted::starts::ScriptedStartRecord;
    use crate::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, hand_scripted_frame, settle,
    };
    use crate::driver::mcp_server::status::{
        McpServerReading, McpServerStatusEmission, McpServerStatusSink,
    };
    use crate::driver::session_control::{
        CreateSessionParams, MoveSessionToForkParams, MoveSessionToForkResult,
    };
    use crate::driver::test_registry::new_session_id;
    use crate::runtime_binding::store::mint_runtime_binding_id;

    // A status sink that records what reaches it and counts its leg's ends.
    #[derive(Default)]
    struct RecordingSink {
        reports: Mutex<Vec<McpServerStatusEmission>>,
        ends: AtomicUsize,
    }

    impl McpServerStatusSink for RecordingSink {
        fn report_status(&self, emission: McpServerStatusEmission) {
            lock(&self.reports).push(emission);
        }

        fn end_leg(&self) {
            self.ends.fetch_add(1, Ordering::SeqCst);
        }
    }

    async fn session_on(sink: &Arc<RecordingSink>) -> ScriptedSession {
        let sink = Arc::clone(sink);
        ScriptedSession::created_with(|session_id| CreateSessionParams {
            on_mcp_server_status: Some(sink),
            ..create_params(session_id)
        })
        .await
    }

    // One lead turn: its `system/init`, listing `servers` where given, then the `result` that
    // ends it.
    async fn run_turn(session: &ScriptedSession, servers: Option<&Value>) {
        session.hold_lead_turn("lead");
        let mut init = json!({
            "type": "system",
            "subtype": "init",
            "session_id": session.live.provider_session_id,
        });
        if let Some(servers) = servers {
            init["mcp_servers"] = servers.clone();
        }
        session.frame(&init);
        session.frame(&json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done",
            "session_id": session.live.provider_session_id,
        }));
        settle().await;
    }

    // Hands `started`, the session's process now, a `system/init` that lists `github` connected.
    async fn hand_github_census(
        fixture: &ScriptedDriver,
        started: &ScriptedStartRecord,
        session_id: SessionId,
    ) {
        let routes = &fixture
            .driver
            .composed_parts()
            .expect("composed")
            .run_start
            .routes;
        hand_scripted_frame(
            &*started.listener,
            routes,
            session_id,
            &json!({
                "type": "system",
                "subtype": "init",
                "session_id": SCRIPTED_PROVIDER_SESSION_ID,
                "mcp_servers": [{ "name": "github", "status": "connected" }],
            }),
        );
        settle().await;
    }

    // What reached `sink`, each server by name with its reading.
    fn reports_of(sink: &RecordingSink) -> Vec<(String, McpServerReading)> {
        lock(&sink.reports)
            .iter()
            .map(|emission| (emission.server_name.as_str().to_owned(), emission.reading))
            .collect()
    }

    fn status_reads(session: &ScriptedSession) -> usize {
        session
            .channel
            .control_requests()
            .iter()
            .filter(|request| request["subtype"] == "mcp_status")
            .count()
    }

    // Budget: servers all connected at `system/init` are never asked after; a server still
    // pending is asked after once per turn end, and no more once an answer reads it connected.
    // Killed by a read at every turn end (a connected leg sends one), and by a read only once
    // (the second pending turn sends none).
    #[tokio::test(start_paused = true)]
    async fn a_turn_end_reads_the_status_only_while_a_server_starts() {
        let connected = json!([{ "name": "github", "status": "connected" }]);
        let pending = json!([
            { "name": "github", "status": "connected" },
            { "name": "tracker", "status": "pending" },
        ]);

        let settled_sink = Arc::new(RecordingSink::default());
        let settled = session_on(&settled_sink).await;
        run_turn(&settled, Some(&connected)).await;
        run_turn(&settled, Some(&connected)).await;
        assert_eq!(status_reads(&settled), 0);
        assert_eq!(lock(&settled_sink.reports).len(), 2);

        let starting_sink = Arc::new(RecordingSink::default());
        let starting = session_on(&starting_sink).await;
        // An answer that carries no list changes no reading, so the next turn asks again.
        run_turn(&starting, Some(&pending)).await;
        assert_eq!(status_reads(&starting), 1);
        run_turn(&starting, Some(&pending)).await;
        assert_eq!(status_reads(&starting), 2);

        starting.channel.answer(
            "mcp_status",
            ScriptedAnswer::Reply(json!({ "mcpServers": [
                { "name": "github", "status": "connected" },
                { "name": "tracker", "status": "connected" },
            ] })),
        );
        run_turn(&starting, Some(&pending)).await;
        assert_eq!(status_reads(&starting), 3);
        let last_report = lock(&starting_sink.reports)
            .last()
            .map(|emission| (emission.server_name.as_str().to_owned(), emission.reading));
        assert_eq!(
            last_report,
            Some((
                "tracker".to_owned(),
                McpServerReading::Observed(McpServerStatus::Connected)
            ))
        );
        // Only the answer read the servers connected: a turn whose init lists none asks nothing.
        run_turn(&starting, None).await;
        assert_eq!(status_reads(&starting), 3);
    }

    // A process's exit nothing asked for ends its producer's leg once, and the relaunch that
    // follows reports its census on the sink the session directory answered for the relaunch's
    // binding. Killed by the end call dropped, so a dead process's last reading pins the session's
    // aggregate, by a second end, and by the relaunch reusing the ended leg's producer (the census
    // reaches the old sink, the new one hears nothing).
    #[tokio::test(start_paused = true)]
    async fn a_relaunch_after_an_exit_reports_on_its_own_leg_once_the_old_one_ended() {
        let fixture = ScriptedDriver::new();
        let (ended_sink, relaunched_sink) = (
            Arc::new(RecordingSink::default()),
            Arc::new(RecordingSink::default()),
        );
        *lock(&fixture.relaunches.status_sink) = Some(Arc::clone(&relaunched_sink) as _);
        let session_id = new_session_id();
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        fixture
            .driver
            .create_session(CreateSessionParams {
                on_mcp_server_status: Some(Arc::clone(&ended_sink) as _),
                ..create_params(session_id)
            })
            .await
            .expect("the session opens");
        let first = fixture.next_start().await;
        assert_eq!(ended_sink.ends.load(Ordering::SeqCst), 0);
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));

        ScriptedDriver::exit(&first);
        let relaunched = fixture.next_start().await;
        // Reported once the resume answered, so the relaunched process holds the session's slot.
        fixture.relaunches.reported(1).await;
        hand_github_census(&fixture, &relaunched, session_id).await;

        assert_eq!(ended_sink.ends.load(Ordering::SeqCst), 1);
        assert_eq!(
            reports_of(&ended_sink),
            [] as [(String, McpServerReading); 0]
        );
        assert_eq!(
            reports_of(&relaunched_sink),
            [(
                "github".to_owned(),
                McpServerReading::Observed(McpServerStatus::Connected)
            )]
        );
        assert_eq!(relaunched_sink.ends.load(Ordering::SeqCst), 0);
    }

    // A relaunch for a new step bound, which keeps the session's binding, ends the old process's
    // leg once and reports the new process's census on a fresh leg the session directory answered
    // for it with no cursor opened. Killed by the old producer reused (the census reaches the
    // ended sink and the fresh one hears nothing), and by a cursor opened for the kept binding.
    #[tokio::test(start_paused = true)]
    async fn a_relaunch_for_a_new_step_bound_reports_on_a_fresh_leg_once_the_old_one_ended() {
        let fixture = ScriptedDriver::new();
        let (ended_sink, relaunched_sink) = (
            Arc::new(RecordingSink::default()),
            Arc::new(RecordingSink::default()),
        );
        *lock(&fixture.relaunches.status_sink) = Some(Arc::clone(&relaunched_sink) as _);
        let session_id = new_session_id();
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        fixture
            .driver
            .create_session(CreateSessionParams {
                on_mcp_server_status: Some(Arc::clone(&ended_sink) as _),
                ..create_params(session_id)
            })
            .await
            .expect("the session opens");
        fixture.next_start().await;
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        let parts = fixture.driver.composed_parts().expect("composed");
        let live = parts
            .slots()
            .live_session(session_id)
            .expect("the session is live");

        parts
            .restarts
            .relaunch_for_step_bound(&live)
            .await
            .expect("the relaunch resumes");
        let relaunched = fixture.next_start().await;
        hand_github_census(&fixture, &relaunched, session_id).await;

        assert_eq!(ended_sink.ends.load(Ordering::SeqCst), 1);
        assert_eq!(
            reports_of(&ended_sink),
            [] as [(String, McpServerReading); 0]
        );
        assert_eq!(
            reports_of(&relaunched_sink),
            [(
                "github".to_owned(),
                McpServerReading::Observed(McpServerStatus::Connected)
            )]
        );
        assert_eq!(relaunched_sink.ends.load(Ordering::SeqCst), 0);
        assert_eq!(
            fixture.relaunches.opened(),
            [] as [(SessionId, RuntimeBindingId); 0]
        );
        let legs_sessions: Vec<_> = fixture
            .relaunches
            .legs_opened()
            .into_iter()
            .map(|(opened_session, _binding)| opened_session)
            .collect();
        assert_eq!(legs_sessions, [session_id]);
    }

    // A rewind's fork reports its census on a leg the session directory answered for it, under a
    // binding of its own, and the predecessor's leg ends once as the predecessor stops. Killed by
    // the fork carrying the predecessor's producer (the census reaches the ended sink), and by the
    // fork's legs opened under the binding the session keeps, which the predecessor's end retires.
    #[tokio::test(start_paused = true)]
    async fn a_rewind_fork_reports_on_its_own_leg_once_the_predecessors_ended() {
        let fixture = ScriptedDriver::new();
        let (ended_sink, forked_sink) = (
            Arc::new(RecordingSink::default()),
            Arc::new(RecordingSink::default()),
        );
        *lock(&fixture.relaunches.status_sink) = Some(Arc::clone(&forked_sink) as _);
        let session_id = new_session_id();
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        fixture
            .driver
            .create_session(CreateSessionParams {
                on_mcp_server_status: Some(Arc::clone(&ended_sink) as _),
                ..create_params(session_id)
            })
            .await
            .expect("the session opens");
        fixture.next_start().await;
        let conversation = fixture
            .driver
            .composed_parts()
            .expect("composed")
            .slots()
            .live_session(session_id)
            .expect("the session is live")
            .provider_session_id
            .clone();
        // Two turns, so a fork after the first has a later turn to discard.
        let project_folder = fixture.home.join(".claude/projects/work");
        std::fs::create_dir_all(&project_folder).expect("the project folder is made");
        std::fs::write(
            project_folder.join(format!("{conversation}.jsonl")),
            concat!(
                r#"{"type":"user","uuid":"u1","message":{"content":"first"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a1","message":{"content":"one"}}"#,
                "\n",
                r#"{"type":"user","uuid":"u2","message":{"content":"second"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a2","message":{"content":"two"}}"#,
                "\n",
            ),
        )
        .expect("the conversation is written");
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        let kept_binding = mint_runtime_binding_id();

        let moved = fixture
            .driver
            .move_session_to_fork(MoveSessionToForkParams {
                session_id,
                position: SafeInt::new(1).expect("1 is a position"),
                binding_id: kept_binding.clone(),
            })
            .await
            .expect("the fork is answered");
        assert!(
            matches!(moved, MoveSessionToForkResult::Applied { .. }),
            "{moved:?}"
        );
        let forked = fixture.next_start().await;
        hand_github_census(&fixture, &forked, session_id).await;

        assert_eq!(ended_sink.ends.load(Ordering::SeqCst), 1);
        assert_eq!(
            reports_of(&ended_sink),
            [] as [(String, McpServerReading); 0]
        );
        assert_eq!(
            reports_of(&forked_sink),
            [(
                "github".to_owned(),
                McpServerReading::Observed(McpServerStatus::Connected)
            )]
        );
        assert_eq!(forked_sink.ends.load(Ordering::SeqCst), 0);
        let legs_opened = fixture.relaunches.legs_opened();
        assert_eq!(legs_opened.len(), 1);
        assert_eq!(legs_opened[0].0, session_id);
        assert_ne!(legs_opened[0].1, kept_binding);
    }
}
