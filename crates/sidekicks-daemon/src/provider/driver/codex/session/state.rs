//! The state the Codex driver keeps for one live session: the session record, with its turn
//! bookkeeping and its delivery memory, and the bounds the thread-frame router holds its frames
//! within.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::attachments::ProviderAttachment;
use crate::provider::driver::codex::delivery::memory::CodexDeliveryMemory;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::session::inbound::CodexSessionInboundSender;
use crate::provider::driver::codex::thread::permission_profiles::CodexThreadPermissionProfiles;
use crate::provider::driver::codex::thread::settings::CodexThreadSettings;
use crate::provider::driver::run_control::{PickedSkill, ResumeRunParams};
use crate::provider::thread_frame_router::ThreadFrameRouterConfig;

/// How many interrupted runs whose ends are still owed a session keeps; past it the interrupt is
/// refused rather than an entry dropped, since a dropped entry's end would reach no run.
#[expect(
    dead_code,
    reason = "the Codex run's interrupt keeps the turn whose end is owed"
)]
const CODEX_INTERRUPTED_ROUTE_MEMORY: usize = 64;

/// How many settled turn ids a session remembers, oldest dropped first.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex session's frame intake remembers each turn's end"
    )
)]
const CODEX_SETTLED_TURN_MEMORY: usize = 64;

/// The thread-frame router's bounds. The hold covers one short race, a helper's frames ahead of
/// its `thread/started`, so its timeout is far below any delay a person notices.
pub(crate) const CODEX_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig =
    ThreadFrameRouterConfig {
        max_quarantined_frames: 64,
        max_pending_hold_frames: 128,
        pending_registration_timeout: Duration::from_secs(5),
    };

/// One of the person's messages a turn is sent with: its words as typed, the skills picked for it,
/// then its staged files.
#[derive(Clone, Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex run start sends a turn's messages and resends them on a retry"
    )
)]
pub(crate) struct CodexTurnMessage {
    /// The words.
    pub(crate) text: String,
    /// The skills picked for it, in the order picked.
    pub(crate) skills: Vec<PickedSkill>,
    /// Its files, in staging order.
    pub(crate) attachments: Vec<ProviderAttachment>,
}

/// What a turn was sent with, kept so a faster-model retry can send it again, files and all.
#[derive(Clone, Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex run start keeps a turn's input for a faster-model retry"
    )
)]
pub(crate) struct CodexTurnInput {
    /// The messages.
    pub(crate) messages: Vec<CodexTurnMessage>,
    /// The ids they went under.
    pub(crate) client_message_ids: Vec<String>,
    /// The level the turn alone ran at, which a resend of the turn keeps.
    pub(crate) output_speed_for_turn: Option<String>,
}

/// A run whose turn is accepted and whose settled output speed is not yet reported.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CodexUnsettledOutputSpeedRun {
    /// The run.
    pub(crate) run_id: RunId,
    /// Whether the turn changed the declared tier, so it settles on the notice that change sends.
    pub(crate) awaits_settings_notice: bool,
}

/// Everything the driver keeps for one live Codex session. The session's task holds it and every
/// change to it is made there, in the order the session's frames and calls arrive.
#[expect(
    dead_code,
    reason = "the Codex session's start, resume, fork and controls keep and read the record"
)]
pub(crate) struct CodexSessionRecord {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The service the conversation is loaded on; a move onto a new build replaces it in place.
    pub(crate) service: Arc<CodexService>,
    /// The queue the services the session runs on send its frames and asks to.
    pub(crate) inbound: CodexSessionInboundSender,
    /// The conversation the session is bound to; only a fork changes it.
    pub(crate) thread_id: String,
    /// The runtime binding whose resume handle names `thread_id`, rewritten as soon as a fork
    /// answers; `None` until the daemon names one.
    pub(crate) binding_id: Option<RuntimeBindingId>,
    /// The account the conversation runs on, `None` on the machine's default home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The conversation's turn ids, oldest first; a fork position N is entry N - 1. Uncapped, since
    /// dropping the head would shift every later position.
    pub(crate) turn_boundaries: Vec<String>,
    /// The turn each of the person's messages started, by the message's id, for an undo's cut.
    pub(crate) turn_id_by_client_message_id: HashMap<String, String>,
    /// What every start, resume and fork of the conversation carries, the settings as chosen.
    pub(crate) thread_settings: CodexThreadSettings,
    /// Whether the conversation still owes a fork onto a config `thread_settings` changed; a turn
    /// never starts while it is set.
    pub(crate) is_config_fork_owed: bool,
    /// The conversations forks moved the session off before it had a binding, oldest first.
    pub(crate) left_thread_ids_awaiting_binding: Vec<String>,
    /// The session's level and roots as they stand now; a turn the daemon starts runs at it.
    pub(crate) execution_posture: ExecutionPosture,
    /// The permission profile Codex last reported for `thread_id` and those asked for since.
    pub(crate) permission_profiles: CodexThreadPermissionProfiles,
    /// Build or Plan as the person last set it, sent again after every resume and move.
    pub(crate) session_mode: SessionMode,
    /// The output-speed level the carriers last asked for.
    pub(crate) output_speed_request: Option<String>,
    /// The tier the conversation last declared; held for the binding's life, written nowhere.
    pub(crate) declared_output_speed: Option<ProviderOutputSpeedState>,
    /// The reasoning effort Codex last reported; a mode move sends it back.
    pub(crate) reasoning_effort: Option<String>,
    /// Accepted turns, by turn id, whose run has yet to report the tier it settled at.
    pub(crate) unsettled_output_speed_runs: HashMap<String, CodexUnsettledOutputSpeedRun>,
    /// Every live turn with its run, oldest first; a run can hold several live turns.
    pub(crate) active_turns: Vec<(String, RunId)>,
    /// Turn ids whose end was read, oldest first and at most 64, so a turn that ended before its
    /// start's answer gets no live route.
    pub(crate) settled_turn_ids: VecDeque<String>,
    /// Runs whose route an interrupt retired before their turn's end arrived, by that turn's id,
    /// oldest first and at most 64, refused rather than dropped past it.
    pub(crate) interrupted_run_by_turn_id: Vec<(String, RunId)>,
    /// Turns whose `turn/interrupt` is on the wire: no steer is sent into one.
    pub(crate) interrupting_turn_ids: HashSet<String>,
    /// The steers sent into each live turn whose `userMessage` echo has yet to arrive, by turn id,
    /// each registered before its `turn/steer` is written: an echo takes one, and an interrupt
    /// cancels what its turn still holds.
    pub(crate) unechoed_steers_by_turn_id: HashMap<String, Vec<QueueItemId>>,
    /// The newest steer sent on the conversation, settled either way; the next waits for it, so
    /// steers reach Codex one at a time in the order they were handed over.
    pub(crate) last_steer_send: Option<Shared<BoxFuture<'static, ()>>>,
    /// Runs asked to pause whose turn has a step in flight, by that turn's id.
    pub(crate) pause_run_id_by_turn_id: HashMap<String, RunId>,
    /// Runs whose turn was interrupted to pause them, by that turn's id: its interrupted end is
    /// the pause taking effect, never the run's end.
    pub(crate) paused_run_id_by_interrupted_turn_id: HashMap<String, RunId>,
    /// Continues asked for while a pause's interrupt was on its way, by the run.
    pub(crate) continues_awaiting_pause: HashMap<RunId, ResumeRunParams>,
    /// What each live turn was sent with, by turn id; each leaves with its turn's end.
    pub(crate) turn_input_by_turn_id: HashMap<String, CodexTurnInput>,
    /// What the session's deliveries remember between frames.
    pub(crate) delivery: CodexDeliveryMemory,
}

/// The interrupted turns a session can keep were all taken, so one more interrupt is refused.
#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("the session already keeps {CODEX_INTERRUPTED_ROUTE_MEMORY} interrupted turns")]
#[expect(dead_code, reason = "the Codex run's interrupt refuses past the bound")]
pub(crate) struct InterruptedRouteMemoryFull;

impl CodexSessionRecord {
    /// The run of the live turn `turn_id`, if it is live.
    pub(crate) fn active_turn_run(&self, turn_id: &str) -> Option<RunId> {
        find_run(&self.active_turns, turn_id)
    }

    /// Routes the live turn `turn_id` to `run_id`, as the newest.
    pub(crate) fn add_active_turn(&mut self, turn_id: String, run_id: RunId) {
        self.active_turns.retain(|(live, _)| *live != turn_id);
        self.active_turns.push((turn_id, run_id));
    }

    /// Retires the live turn `turn_id`; answers its run when it was live.
    pub(crate) fn remove_active_turn(&mut self, turn_id: &str) -> Option<RunId> {
        let at = self
            .active_turns
            .iter()
            .position(|(live, _)| live == turn_id)?;
        Some(self.active_turns.remove(at).1)
    }

    /// Whether the end of `turn_id` was already read.
    pub(crate) fn is_turn_settled(&self, turn_id: &str) -> bool {
        self.settled_turn_ids
            .iter()
            .any(|settled| settled == turn_id)
    }

    /// Records that a turn's end was read, dropping the oldest past the memory's bound.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's frame intake remembers each turn's end"
        )
    )]
    pub(crate) fn remember_settled_turn(&mut self, turn_id: String) {
        self.settled_turn_ids.retain(|settled| *settled != turn_id);
        self.settled_turn_ids.push_back(turn_id);
        while self.settled_turn_ids.len() > CODEX_SETTLED_TURN_MEMORY {
            self.settled_turn_ids.pop_front();
        }
    }

    /// The run an interrupt took the turn `turn_id` from, while its end is owed.
    pub(crate) fn interrupted_turn_run(&self, turn_id: &str) -> Option<RunId> {
        find_run(&self.interrupted_run_by_turn_id, turn_id)
    }

    /// Keeps an interrupted run's turn for its coming end. Fails at the bound, never dropping an
    /// entry, since a dropped one's end would reach no run; the caller ends the session.
    #[expect(
        dead_code,
        reason = "the Codex run's interrupt keeps the turn whose end is owed"
    )]
    pub(crate) fn remember_interrupted_run(
        &mut self,
        turn_id: String,
        run_id: RunId,
    ) -> Result<(), InterruptedRouteMemoryFull> {
        let is_known = self
            .interrupted_run_by_turn_id
            .iter()
            .any(|(kept, _)| *kept == turn_id);
        if !is_known && self.interrupted_run_by_turn_id.len() >= CODEX_INTERRUPTED_ROUTE_MEMORY {
            return Err(InterruptedRouteMemoryFull);
        }
        self.interrupted_run_by_turn_id
            .retain(|(kept, _)| *kept != turn_id);
        self.interrupted_run_by_turn_id.push((turn_id, run_id));
        Ok(())
    }

    /// Lets go of an interrupted turn whose end arrived.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's frame intake lets go of an interrupted turn at its end"
        )
    )]
    pub(crate) fn forget_interrupted_run(&mut self, turn_id: &str) {
        self.interrupted_run_by_turn_id
            .retain(|(kept, _)| kept != turn_id);
    }

    /// The turns the daemon stopped whose `turn/completed` has yet to arrive: interrupted,
    /// interrupted for a pause, or stopped for a faster-model retry.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex run start reads whether a turn is still ending"
        )
    )]
    pub(crate) fn ending_turn_ids(&self) -> Vec<&str> {
        self.interrupted_run_by_turn_id
            .iter()
            .map(|(turn_id, _)| turn_id.as_str())
            .chain(
                self.paused_run_id_by_interrupted_turn_id
                    .keys()
                    .map(String::as_str),
            )
            .chain(
                self.delivery
                    .retried_run_id_by_turn_id
                    .keys()
                    .map(String::as_str),
            )
            .collect()
    }

    /// Whether a turn runs, is starting or is still ending, or one Codex started by itself is
    /// opening or runs with no run, so input the daemon sends would fold into it. The opening of
    /// `opening_turn_id` itself does not count, for the run that opening starts.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex run start and steer read whether a turn is in flight"
        )
    )]
    pub(crate) fn is_turn_in_flight(&self, opening_turn_id: Option<&str>) -> bool {
        let opening = self.delivery.self_started_turn_opening.as_deref();
        !self.active_turns.is_empty()
            || !self.delivery.starting_turn_run_ids.is_empty()
            || !self.delivery.unowned_turn_ids.is_empty()
            || !self.ending_turn_ids().is_empty()
            || opening.is_some_and(|opening| Some(opening) != opening_turn_id)
    }

    /// The newest live turn a run holds, where interventions land.
    pub(crate) fn newest_active_turn_for_run(&self, run_id: RunId) -> Option<&str> {
        self.active_turns
            .iter()
            .rev()
            .find(|(_, routed)| *routed == run_id)
            .map(|(turn_id, _)| turn_id.as_str())
    }

    /// The run whose turns are live, when every live turn belongs to one run.
    pub(crate) fn sole_active_run(&self) -> Option<RunId> {
        let mut runs = self.active_turns.iter().map(|(_, run_id)| *run_id);
        let first = runs.next()?;
        runs.all(|run_id| run_id == first).then_some(first)
    }
}

fn find_run(turns: &[(String, RunId)], turn_id: &str) -> Option<RunId> {
    turns
        .iter()
        .find(|(kept, _)| kept == turn_id)
        .map(|(_, run_id)| *run_id)
}
