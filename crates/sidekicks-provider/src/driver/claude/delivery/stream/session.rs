//! One session's stream while its process runs, the readings the stream keeps for it behind one
//! lock, and every live session's stream by session.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::integer::{MAX_SAFE_INTEGER, SafeInt};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::driver::claude::delivery::commands::ClaudeHeldCommand;
use crate::driver::claude::delivery::file_tool_writes::ClaudeFileToolWrites;
use crate::driver::claude::delivery::mcp_tasks::restore::{ClaudeKeptCall, ClaudeKeptCallsSource};
use crate::driver::claude::delivery::run_readings::{
    ClaudeOpenTurn, ClaudeStreamSession, ClaudeTakenMessage,
};
use crate::driver::claude::delivery::turn_end::read_claude_result_message_uuids;
use crate::driver::claude::delivery::turn_readings::ClaudeTurnReadings;
use crate::driver::claude::goals::file::ClaudeProcessGoal;
use crate::driver::claude::pricing::ClaudeResultPricing;
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoutes};
use crate::driver::claude::session::arrivals::{ClaudeArrivalSender, ClaudeTurnAtRead};
use crate::driver::claude::session::permission_mode::ClaudePermissionModeRecord;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::diagnostics::OnceReportedDiagnostics;
use crate::run::delivery::InboundDelivery;
use crate::tool_call_arguments::ToolCallArgumentStore;

/// Claude Code's error word for a request refused for its login.
pub(crate) const CLAUDE_LOGIN_REFUSAL: &str = "authentication_failed";

/// How the first request a session's process made after an account move was answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeFirstRequest {
    /// The provider answered it.
    Answered,
    /// The provider refused it for its login.
    LoginRefused,
}

/// The turn a stream read before a held lead's turn was continued on it.
pub(crate) struct ClaudeTurnBeforeContinue {
    turn: Option<ClaudeOpenTurn>,
    has_turn_message: bool,
    turn_readings: ClaudeTurnReadings,
}

/// One session's stream while its process runs: its readings, behind one lock never held across
/// an await, and its queue.
pub(crate) struct ClaudeSessionStream {
    pub(super) session_id: SessionId,
    // The account the process runs on, shared with its readers.
    account: ClaudeProcessAccount,
    pub(super) step_bound: Option<SafeInt<1>>,
    // The lead whose goal the process carries, and the conversation file its outcomes are read
    // from.
    pub(super) goal: ClaudeProcessGoal,
    readings: Mutex<ClaudeStreamSession>,
    arrivals: ClaudeArrivalSender,
    routes: Arc<ClaudeRunRoutes>,
    prompts: Arc<Mutex<ClaudeSentPrompts>>,
    permission_mode: Arc<ClaudePermissionModeRecord>,
    // The kinds of the frames no daemon run held, already logged on this process's connection.
    pub(super) unheld_reports: Mutex<OnceReportedDiagnostics>,
    // The `result` kinds of unlisted subtypes that ended a run, already logged on this connection,
    // apart from the unheld ones so neither record keeps the other from being logged.
    pub(super) unlisted_result_reports: Mutex<OnceReportedDiagnostics>,
    // How many turns the run engine could not number have ended.
    unnumbered_turns: AtomicU64,
    // Where the next request's answer goes, once an account move asked to hear it.
    first_request: Mutex<Option<oneshot::Sender<ClaudeFirstRequest>>>,
    // Where the process keeps its tool servers' background calls.
    kept_calls: ClaudeKeptCallsSource,
    // The rows the process recorded that wait for their price, behind a lock never held across an
    // await.
    pub(super) result_pricing: Mutex<ClaudeResultPricing>,
    // The arguments of the process's calls awaiting their results, kept for their traces.
    pub(super) tool_call_arguments: ToolCallArgumentStore,
    // The file-tool calls the lead and the helpers opened on a path, each until the chat versions
    // have recorded its settle, off the session's task.
    pub(super) file_tool_writes: ClaudeFileToolWrites,
}

impl ClaudeSessionStream {
    /// A stream for the process running on `provider_account_id`'s home, counting each turn's
    /// steps against `step_bound`, queuing onto `arrivals`, taking the mode reports into
    /// `permission_mode`, the process's record the live session shares, reading the goal of
    /// `goal`'s lead from its conversation file, reading its background calls' kept files from
    /// `kept_calls`, keeping its calls' arguments for their traces in `tool_call_arguments`, and
    /// keeping its file-tool calls in `file_tool_writes`.
    #[expect(
        clippy::too_many_arguments,
        reason = "the account, the bound and each part of the process the stream reads and shares"
    )]
    pub(crate) fn new(
        provider_account_id: ProviderAccountId,
        step_bound: Option<SafeInt<1>>,
        goal: ClaudeProcessGoal,
        arrivals: ClaudeArrivalSender,
        routes: Arc<ClaudeRunRoutes>,
        prompts: Arc<Mutex<ClaudeSentPrompts>>,
        permission_mode: Arc<ClaudePermissionModeRecord>,
        kept_calls: ClaudeKeptCallsSource,
        tool_call_arguments: ToolCallArgumentStore,
        file_tool_writes: ClaudeFileToolWrites,
    ) -> Self {
        Self {
            session_id: arrivals.session_id(),
            readings: Mutex::new(ClaudeStreamSession::new()),
            account: ClaudeProcessAccount::new(Some(provider_account_id)),
            step_bound,
            goal,
            arrivals,
            routes,
            prompts,
            permission_mode,
            unheld_reports: Mutex::default(),
            unlisted_result_reports: Mutex::default(),
            unnumbered_turns: AtomicU64::new(0),
            first_request: Mutex::new(None),
            kept_calls,
            result_pricing: Mutex::default(),
            tool_call_arguments,
            file_tool_writes,
        }
    }

    /// Where the process keeps its tool servers' background calls.
    pub(super) fn kept_calls(&self) -> &ClaudeKeptCallsSource {
        &self.kept_calls
    }

    /// Opens the stream on `run`'s turn `turn_number` as it was before the process came up, which a
    /// resumed process continues: its frames go to that turn and its end is that turn's, with no
    /// other turn started. `provider_turn_id` is the id the turn's start recorded. The messages of
    /// the run Claude Code took while no turn of it was open land in that turn ahead of any frame
    /// read after. Answers the turn the stream read before, which [`Self::restore_turn`] puts back.
    pub(crate) fn continue_turn(
        &self,
        run: &ClaudeBoundRun,
        turn_number: SafeInt<1>,
        provider_turn_id: Option<ProviderTurnId>,
    ) -> ClaudeTurnBeforeContinue {
        let mut readings = self.lock();
        let before = ClaudeTurnBeforeContinue {
            turn: readings.turn.clone(),
            has_turn_message: readings.has_turn_message,
            turn_readings: readings.turn_readings.clone(),
        };
        readings.turn_readings.open(run.run_id, provider_turn_id);
        // The resumed turn is under way, so a message it takes in joins it.
        readings.has_turn_message = true;
        let (taken, kept): (Vec<ClaudeTakenMessage>, _) =
            std::mem::take(&mut readings.taken_without_turn)
                .into_iter()
                .partition(|taken| taken.run_id == run.run_id);
        readings.taken_without_turn = kept;
        readings.turn = Some(ClaudeOpenTurn {
            run_id: run.run_id,
            binding_id: run.binding_id.clone(),
            turn_number: Some(turn_number),
            opening: None,
        });
        drop(readings);
        for taken in taken {
            // Queued at the call, so it lands before any frame the continued turn reads; nothing
            // waits on its outcome.
            drop(self.arrivals.dispatch(InboundDelivery::TurnSteered {
                binding_id: run.binding_id.clone(),
                turn_number,
                message_id: taken.message_id,
            }));
        }
        before
    }

    /// Puts back the turn the stream read before a continue whose message never reached the
    /// process.
    pub(crate) fn restore_turn(&self, before: ClaudeTurnBeforeContinue) {
        let mut readings = self.lock();
        readings.turn = before.turn;
        readings.has_turn_message = before.has_turn_message;
        readings.turn_readings = before.turn_readings;
    }

    /// The turn the stream has open, and whether it already took a message.
    #[cfg(test)]
    pub(crate) fn open_turn(&self) -> (Option<ClaudeOpenTurn>, bool) {
        let readings = self.lock();
        (readings.turn.clone(), readings.has_turn_message)
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

    /// The account the process runs on now: the one it started on, or the one a switch it
    /// acknowledged moved it onto.
    pub(crate) fn provider_account_id(&self) -> ProviderAccountId {
        self.account
            .read()
            .expect("a session's stream is made on an account and only ever moved onto another")
    }

    /// The account the process runs on, which its launch hands its readers so each diagnostic
    /// names the account the stream is on.
    pub(crate) fn account(&self) -> ClaudeProcessAccount {
        self.account.clone()
    }

    /// Answers `watch` how the process's next request goes; a watch held before is dropped, which
    /// reads as no request seen.
    pub(crate) fn watch_first_request(&self, watch: oneshot::Sender<ClaudeFirstRequest>) {
        *lock(&self.first_request) = Some(watch);
    }

    // Whether an account move waits to hear how the process's next request goes.
    pub(super) fn is_watching_first_request(&self) -> bool {
        lock(&self.first_request).is_some()
    }

    // Answers the watch on the next request, where one is held.
    pub(super) fn settle_first_request(&self, outcome: ClaudeFirstRequest) {
        if let Some(watch) = lock(&self.first_request).take() {
            // A watcher that stopped waiting needs no answer.
            watch.send(outcome).unwrap_or(());
        }
    }

    /// The running command `task_id` of the session's own process, where its tasks hold it.
    pub(crate) fn held_command(&self, task_id: &str) -> Option<ClaudeHeldCommand> {
        self.lock().command_tasks.held_command(task_id)
    }

    /// The tasks of the tool-server calls the session's process holds that Claude Code's record
    /// says still run, which outlive the process; none, with nothing read, when no call is held.
    /// Fails as the read of what Claude Code keeps fails.
    pub(crate) async fn surviving_held_tasks(&self) -> io::Result<Vec<String>> {
        let held: Vec<(String, String)> = self
            .lock()
            .tool_server_tasks
            .held_tasks()
            .map(|(task_id, call_id)| (task_id.to_owned(), call_id.to_owned()))
            .collect();
        if held.is_empty() {
            return Ok(Vec::new());
        }
        let kept = self.kept_calls.read().await?;
        Ok(held
            .into_iter()
            .filter(|(task_id, call_id)| kept.call(call_id, task_id) == ClaudeKeptCall::Recorded)
            .map(|(task_id, _)| task_id)
            .collect())
    }

    /// The ids of the session's own running command tasks that belong to `run_id`.
    pub(crate) fn command_ids_of_run(&self, run_id: RunId) -> Vec<String> {
        self.lock().command_tasks.command_ids_of_run(run_id)
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

    /// How many of the session's tasks other than its commands run in the background, which a stop
    /// of the process would kill: the tool servers' calls it holds open and the other tasks its
    /// latest background set listed that it holds none for, so a held call's own listed task
    /// counts once.
    pub(crate) fn background_work(&self) -> usize {
        let readings = self.lock();
        let tool_server_tasks = &readings.tool_server_tasks;
        tool_server_tasks.held_count()
            + readings
                .command_tasks
                .listed_other_tasks()
                .filter(|task_id| !tool_server_tasks.holds_task(task_id))
                .count()
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

    /// The process's permission mode: the mode it runs, the daemon's sends and its newest report.
    pub(crate) fn permission_mode(&self) -> &ClaudePermissionModeRecord {
        &self.permission_mode
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
