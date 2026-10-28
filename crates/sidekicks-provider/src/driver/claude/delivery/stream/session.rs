//! One session's stream while its process runs, the readings the stream keeps for it behind one
//! lock, and every live session's stream by session.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::{MAX_SAFE_INTEGER, SafeInt};
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use crate::driver::claude::delivery::run_readings::ClaudeStreamSession;
use crate::driver::claude::delivery::turn_end::read_claude_result_message_uuids;
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::arrivals::{ClaudeArrivalSender, ClaudeTurnAtRead};
use crate::driver::diagnostics::OnceReportedDiagnostics;

/// One session's stream while its process runs: its readings, behind one lock never held across
/// an await, and its queue.
pub(crate) struct ClaudeSessionStream {
    pub(super) session_id: SessionId,
    pub(super) provider_account_id: ProviderAccountId,
    pub(super) step_bound: Option<SafeInt<1>>,
    readings: Mutex<ClaudeStreamSession>,
    arrivals: ClaudeArrivalSender,
    routes: Arc<ClaudeRunRoutes>,
    prompts: Arc<Mutex<ClaudeSentPrompts>>,
    // The kinds of the frames no daemon run held, already logged on this process's connection.
    pub(super) unheld_reports: Mutex<OnceReportedDiagnostics>,
    // The `result` kinds of unlisted subtypes that ended a run, already logged on this connection,
    // apart from the unheld ones so neither record keeps the other from being logged.
    pub(super) unlisted_result_reports: Mutex<OnceReportedDiagnostics>,
    // How many turns the run engine could not number have ended.
    unnumbered_turns: AtomicU64,
}

impl ClaudeSessionStream {
    /// A stream for the process running on `provider_account_id`'s home, counting each turn's
    /// steps against `step_bound` and queuing onto `arrivals`.
    pub(crate) fn new(
        provider_account_id: ProviderAccountId,
        step_bound: Option<SafeInt<1>>,
        arrivals: ClaudeArrivalSender,
        routes: Arc<ClaudeRunRoutes>,
        prompts: Arc<Mutex<ClaudeSentPrompts>>,
    ) -> Self {
        Self {
            session_id: arrivals.session_id(),
            readings: Mutex::new(ClaudeStreamSession::new(provider_account_id.clone())),
            provider_account_id,
            step_bound,
            arrivals,
            routes,
            prompts,
            unheld_reports: Mutex::default(),
            unlisted_result_reports: Mutex::default(),
            unnumbered_turns: AtomicU64::new(0),
        }
    }

    // A terminal gate version for one more turn the run engine could not number, past every
    // turn number, so no two such turns share one.
    pub(super) fn unnumbered_turn_version(&self) -> u64 {
        MAX_SAFE_INTEGER + 1 + self.unnumbered_turns.fetch_add(1, Ordering::Relaxed)
    }

    /// The session.
    pub(crate) fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// The bound on each turn's steps the process was started with.
    pub(crate) fn step_bound(&self) -> Option<SafeInt<1>> {
        self.step_bound
    }

    /// The session's queue.
    pub(crate) fn arrivals(&self) -> &ClaudeArrivalSender {
        &self.arrivals
    }

    /// The account the process runs on.
    pub(crate) fn provider_account_id(&self) -> &ProviderAccountId {
        &self.provider_account_id
    }

    /// The tool call that started the running command `task_id`, where Claude Code named it.
    pub(crate) fn command_tool_use_id(&self, task_id: &str) -> Option<String> {
        self.lock().command_tasks.tool_use_id_of(task_id)
    }

    /// Whether the lead `result` in `text` ends the session's turn, read on the process's reader.
    /// A `result` naming no steer written `now` while one waits is Claude Code's abort for that
    /// steer and ends nothing; one naming it ends the turn and settles the steer. A run with a
    /// steer still waiting keeps the turn through the settlement the reader then makes, since
    /// Claude Code starts its next turn with that steer; the turn's end on the session's task
    /// decides whether the run goes on into it.
    pub(crate) fn is_turn_ending(&self, text: &str) -> bool {
        let is_ending = {
            let mut readings = self.lock();
            if readings.now_steers.is_empty() {
                true
            } else {
                let named = read_claude_result_message_uuids(text);
                let before = readings.now_steers.len();
                readings
                    .now_steers
                    .retain(|uuid| !named.iter().any(|named| named == uuid));
                readings.now_steers.len() < before
            }
        };
        if !is_ending {
            return false;
        }
        let lead = self.routes.lead_run_on(self.session_id);
        let carried = lead.filter(|lead| self.lock_prompts().has_untaken_steer(lead.run_id));
        if let Some(lead) = &carried {
            self.routes.carry_turn_over(lead.run_id);
        }
        self.lock().reader_carried_run = carried.map(|lead| lead.run_id);
        true
    }

    /// The session's turn now, which the reader stamps on each frame as it reads it.
    pub(crate) fn turn_at_read(&self) -> ClaudeTurnAtRead {
        ClaudeTurnAtRead {
            lead: self.routes.lead_run_on(self.session_id),
            is_held: self.routes.is_turn_held(self.session_id),
        }
    }

    /// Records a steer written with Claude Code's `now` mark, whose turn's own `result` alone ends
    /// the turn; recorded before the write.
    pub(crate) fn mark_now_steer(&self, message_uuid: &str) {
        self.lock().now_steers.insert(message_uuid.to_owned());
    }

    /// Takes back a `now` steer that never reached Claude Code, or that it dropped.
    pub(crate) fn unmark_now_steer(&self, message_uuid: &str) {
        self.lock().now_steers.remove(message_uuid);
    }

    /// Marks a close the daemon asked for, so the turn end it provokes carries it.
    pub(crate) fn signal_intended_close(&self) {
        self.lock().gate.signal_intended_close();
    }

    /// The permission mode the process last reported it runs in, if any.
    pub(crate) fn permission_mode(&self) -> Option<String> {
        self.lock().permission_mode.clone()
    }

    /// When the stream's timed work next comes due: a streamed piece's interval or a held tool
    /// result's pairing timeout.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        let readings = self.lock();
        match (
            readings.streamed_blocks.next_deadline(),
            readings.buffer.next_release(),
        ) {
            (Some(piece), Some(held)) => Some(piece.min(held)),
            (piece, held) => piece.or(held),
        }
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, ClaudeStreamSession> {
        lock(&self.readings)
    }

    pub(super) fn lock_prompts(&self) -> MutexGuard<'_, ClaudeSentPrompts> {
        lock(&self.prompts)
    }
}

/// Every live session's stream, by session.
#[derive(Default)]
pub(crate) struct ClaudeSessionStreams {
    streams: Mutex<HashMap<SessionId, Arc<ClaudeSessionStream>>>,
}

impl ClaudeSessionStreams {
    /// Keeps `stream` as its session's, replacing a process's that came before.
    pub(crate) fn insert(&self, stream: Arc<ClaudeSessionStream>) {
        self.lock().insert(stream.session_id, stream);
    }

    /// The session's stream, if its process runs.
    pub(crate) fn get(&self, session_id: SessionId) -> Option<Arc<ClaudeSessionStream>> {
        self.lock().get(&session_id).cloned()
    }

    /// Forgets the session's stream, if it is still `stream`: a successor's is kept.
    pub(crate) fn remove(&self, stream: &Arc<ClaudeSessionStream>) {
        let mut streams = self.lock();
        if streams
            .get(&stream.session_id)
            .is_some_and(|kept| Arc::ptr_eq(kept, stream))
        {
            streams.remove(&stream.session_id);
        }
    }

    // The stream holding the daemon's end of `run_id`, wherever the run is now routed.
    pub(super) fn holding_daemon_end(&self, run_id: RunId) -> Option<Arc<ClaudeSessionStream>> {
        self.lock()
            .values()
            .find(|stream| stream.lock().daemon_ended.contains_key(&run_id))
            .cloned()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, Arc<ClaudeSessionStream>>> {
        lock(&self.streams)
    }
}
