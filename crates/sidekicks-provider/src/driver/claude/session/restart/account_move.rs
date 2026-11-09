//! A Claude Code session's move onto another account: its process ended between turns and its
//! conversation resumed by id on that account, one relaunch of a session at a time. A busy
//! session's move waits for its turn to settle, and a move asked while one waits, or while the
//! relaunch that settle began has not read its account yet, joins it: a person's switch takes the
//! account and leg of whatever waits, while the driver's own relaunch onto an account (a hand-back,
//! a re-supplied token) never replaces a person's switch and lands where that switch lands.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use super::{ClaudeRestartStage, ClaudeRestartTable, ClaudeSessionRestarts};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::session_process_unavailable;
use crate::driver::session_control::DriverResumeResult;
use crate::runtime_binding::writer::RuntimeBindingWriter;

// One session's moves onto another account: whether its relaunch onto one runs, and the move the
// next relaunch makes.
#[derive(Default)]
pub(super) struct ClaudeSessionAccountMoves {
    is_relaunching: bool,
    next: Option<ClaudeAskedAccountMove>,
}

// The move the session's next relaunch makes: the account and leg of the move that stands, who
// asked it, where its landing is answered, and where it is answered to every move that joined it.
struct ClaudeAskedAccountMove {
    provider_account_id: ProviderAccountId,
    leg: ClaudeLegBinding,
    asker: ClaudeAccountMoveAsker,
    landed: AccountLandingSender,
    joined: Vec<AccountLandingSender>,
}

type AccountLandingSender = oneshot::Sender<Result<ClaudeAccountLanding, DriverError>>;

/// Who asks a session's move onto another account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeAccountMoveAsker {
    /// The person's switch, which replaces any move waiting.
    Person,
    /// The driver's own relaunch, a hand-back or a re-supplied token, which a person's move
    /// waiting stands over.
    Driver,
}

/// Where a session's move onto another account landed: the binding its relaunched process runs
/// under, the account it runs on, and whether a newer move took this one's place while it waited,
/// the session then on that move's account.
#[derive(Clone)]
pub(crate) struct ClaudeAccountLanding {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The account.
    pub(crate) provider_account_id: ProviderAccountId,
    /// Whether another move landed the session.
    pub(crate) is_replaced: bool,
}

/// The binding a session's lead runs on, which a relaunch onto another account moves before it
/// starts, so the binding the relaunch records carries the account its process starts on.
pub(crate) struct ClaudeLegBinding {
    /// Where the move is written.
    pub(crate) bindings: Arc<dyn RuntimeBindingWriter>,
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
}

impl ClaudeLegBinding {
    // Moves the binding onto `provider_account_id`'s account. Fails when nothing was recorded.
    async fn move_to(&self, provider_account_id: ProviderAccountId) -> Result<(), DriverError> {
        self.bindings
            .move_account(self.binding_id.clone(), provider_account_id)
            .await
            .map_err(DriverError::Internal)
    }
}

impl ClaudeSessionAccountMoves {
    // Joins `asked` to the move the next relaunch makes: a person's, or any move where none or
    // only the driver's waits, takes its account and leg; the move it replaced, or the driver's
    // move a person's stands over, is answered with the landing as replaced.
    fn join(&mut self, asked: ClaudeAskedAccountMove) {
        let Some(waiting) = self.next.as_mut() else {
            self.next = Some(asked);
            return;
        };
        if asked.asker == ClaudeAccountMoveAsker::Driver
            && waiting.asker == ClaudeAccountMoveAsker::Person
        {
            waiting.joined.push(asked.landed);
            waiting.joined.extend(asked.joined);
            return;
        }
        let replaced = std::mem::replace(waiting, asked);
        waiting.joined.push(replaced.landed);
        waiting.joined.extend(replaced.joined);
    }
}

impl ClaudeSessionRestarts {
    /// Moves `live`'s session onto `provider_account_id`'s account for `asker` by ending its
    /// process the way a close does and resuming its conversation by id on that account, as a
    /// relaunch does, so the new process starts with that account's sign-in: an idle session at
    /// once, a busy one when its turn settles, one relaunch of the session at a time. `leg` moves
    /// onto the account just before the relaunch, after every frame of the turn it waited for. A
    /// move asked before the relaunch reads its account joins it as
    /// [`ClaudeAccountMoveAsker`] says. Answers where the session landed once its relaunched
    /// process runs; fails `provider.unavailable` once the process is no longer the session's or
    /// ended first, as the move of `leg` fails, and with the relaunch's failure, which the session
    /// directory records too.
    pub(crate) async fn relaunch_on_account(
        self: &Arc<Self>,
        live: &LiveClaudeSession,
        provider_account_id: ProviderAccountId,
        leg: ClaudeLegBinding,
        asker: ClaudeAccountMoveAsker,
    ) -> Result<ClaudeAccountLanding, DriverError> {
        let session_id = live.session_id;
        self.ask_account_move(session_id, provider_account_id, leg, asker)
            .await
            .unwrap_or_else(|_dropped| Err(session_process_unavailable(session_id).into()))
    }

    /// Asks the move [`Self::relaunch_on_account`] makes and answers where its landing is told,
    /// once the move waits or its relaunch is set going.
    pub(crate) fn ask_account_move(
        self: &Arc<Self>,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
        leg: ClaudeLegBinding,
        asker: ClaudeAccountMoveAsker,
    ) -> oneshot::Receiver<Result<ClaudeAccountLanding, DriverError>> {
        let (landed, landing) = oneshot::channel();
        let is_started = {
            let mut table = lock(&self.table);
            let moves = table.pending_account_moves.entry(session_id).or_default();
            moves.join(ClaudeAskedAccountMove {
                provider_account_id,
                leg,
                asker,
                landed,
                joined: Vec::new(),
            });
            // Read under the table's lock, which the turn's settle takes once the turn is let go,
            // so a move asked as the turn settles is taken at that settle.
            let is_started = !moves.is_relaunching && !self.routes.is_turn_held(session_id);
            if is_started {
                moves.is_relaunching = true;
            }
            is_started
        };
        if is_started {
            self.spawn_account_relaunches(session_id);
        }
        landing
    }

    // Starts, where a move waits for `session_id`'s settled turn and no relaunch runs, the task
    // that makes it; answers whether it did.
    pub(super) fn start_waiting_account_move(self: &Arc<Self>, session_id: SessionId) -> bool {
        let is_started = {
            let mut table = lock(&self.table);
            match table.pending_account_moves.get_mut(&session_id) {
                Some(moves) if !moves.is_relaunching && moves.next.is_some() => {
                    moves.is_relaunching = true;
                    true
                }
                Some(_) | None => false,
            }
        };
        if is_started {
            self.spawn_account_relaunches(session_id);
        }
        is_started
    }

    // Relaunches `session_id` onto the account of each move asked for it, one after another,
    // reading each move's account only as its relaunch begins; a move asked during a relaunch
    // waits for the next, which goes at once unless a turn holds the relaunched process, its
    // settle then starting it.
    fn spawn_account_relaunches(self: &Arc<Self>, session_id: SessionId) {
        let restarts = Arc::clone(self);
        tokio::spawn(async move {
            let mut is_after_relaunch = false;
            loop {
                let Some(asked) = restarts.take_next_account_move(session_id, is_after_relaunch)
                else {
                    return;
                };
                is_after_relaunch = true;
                let landed = match restarts.slots.live_session(session_id) {
                    Some(live) => {
                        restarts
                            .relaunch_now_on_account(&live, asked.provider_account_id, &asked.leg)
                            .await
                    }
                    None => Err(session_process_unavailable(session_id).into()),
                };
                answer_account_landing(asked.landed, asked.joined, landed);
            }
        });
    }

    // The move the session's relaunch makes next; `None`, the relaunch let go, once none waits,
    // or, `is_after_relaunch`, where a turn holds the relaunched process, its settle starting the
    // next.
    fn take_next_account_move(
        &self,
        session_id: SessionId,
        is_after_relaunch: bool,
    ) -> Option<ClaudeAskedAccountMove> {
        let mut table = lock(&self.table);
        let moves = table.pending_account_moves.get_mut(&session_id)?;
        let is_turn_held = is_after_relaunch && self.routes.is_turn_held(session_id);
        match moves.next.take() {
            Some(asked) if !is_turn_held => Some(asked),
            Some(asked) => {
                moves.next = Some(asked);
                moves.is_relaunching = false;
                None
            }
            None => {
                table.pending_account_moves.remove(&session_id);
                None
            }
        }
    }

    // Relaunches `live` on `provider_account_id`'s account now, under a binding that copies
    // `leg`'s, and answers that binding on that account; the session and `leg` stay on their
    // account where its process is no longer its own.
    async fn relaunch_now_on_account(
        &self,
        live: &Arc<LiveClaudeSession>,
        provider_account_id: ProviderAccountId,
        leg: &ClaudeLegBinding,
    ) -> Result<ClaudeAccountLanding, DriverError> {
        let session_id = live.session_id;
        let previous = live.admitted_provider_account_id();
        // Both moved first: the relaunch composes its start from the session's account, and the
        // binding it records copies the leg's.
        leg.move_to(provider_account_id.clone()).await?;
        live.move_admitted_account(provider_account_id.clone());
        // The relaunch resumes on the build installed now, so a build move that waited lands here.
        let build_change = lock(&self.table).pending_build_moves.remove(&session_id);
        let Some(answer) = self.relaunch(live, true).await else {
            live.move_admitted_account(previous.clone());
            leg.move_to(previous).await?;
            return Err(session_process_unavailable(session_id).into());
        };
        let relaunched = match &answer.result {
            DriverResumeResult::Resumed { binding_id, .. } => Ok(ClaudeAccountLanding {
                binding_id: binding_id.clone(),
                provider_account_id,
                is_replaced: false,
            }),
            DriverResumeResult::Failed {
                provider_failure_detail,
                ..
            } => {
                self.report_gone(session_id);
                Err(DriverError::Internal(
                    provider_failure_detail.as_str().into(),
                ))
            }
            // The move's relaunch names no live run, so it never defers.
            DriverResumeResult::Deferred { .. } => {
                self.report_gone(session_id);
                Err(session_process_unavailable(session_id).into())
            }
        };
        self.record_relaunch(session_id, answer).await?;
        if relaunched.is_ok()
            && let Some(change) = &build_change
        {
            self.post_build_update(session_id, change).await;
        }
        relaunched
    }

    /// Moves the account `ended`'s restart starts on to `provider_account_id`'s, while its
    /// settings are still held for it; `false` once the relaunch composed its start or the
    /// session left the restart.
    pub(crate) fn move_held_account(
        &self,
        ended: &Arc<LiveClaudeSession>,
        provider_account_id: ProviderAccountId,
    ) -> bool {
        // Moved under the table's lock, which the relaunch takes before it composes.
        let table = lock(&self.table);
        let is_held = matches!(
            table.restarting.get(&ended.session_id),
            Some(ClaudeRestartStage::Held { ended: held, .. }) if Arc::ptr_eq(held, ended)
        );
        if is_held {
            ended.move_admitted_account(provider_account_id);
        }
        is_held
    }
}

// Drops the move waiting for `session_id`'s turn, so each move waiting is told the session is
// gone; a relaunch onto an account that runs keeps its own entry, which it ends.
pub(super) fn drop_waiting_account_move(table: &mut ClaudeRestartTable, session_id: SessionId) {
    let Some(moves) = table.pending_account_moves.get_mut(&session_id) else {
        return;
    };
    moves.next = None;
    if !moves.is_relaunching {
        table.pending_account_moves.remove(&session_id);
    }
}

// Drops every move waiting for a turn, as the daemon stops; the relaunches that run end their own.
pub(super) fn drop_every_waiting_account_move(table: &mut ClaudeRestartTable) {
    table.pending_account_moves.retain(|_, moves| {
        moves.next = None;
        moves.is_relaunching
    });
}

// Answers `landed` with the relaunch's outcome, and each move in `joined` with the same landing as
// replaced, or a copy of the failure.
fn answer_account_landing(
    landed: AccountLandingSender,
    joined: Vec<AccountLandingSender>,
    landing: Result<ClaudeAccountLanding, DriverError>,
) {
    let landing = landing.map_err(Arc::new);
    for waiting in joined {
        let answer = match &landing {
            Ok(landing) => Ok(ClaudeAccountLanding {
                is_replaced: true,
                ..landing.clone()
            }),
            Err(failure) => Err(DriverError::shared(failure)),
        };
        // A move that stopped waiting needs no answer.
        waiting.send(answer).unwrap_or(());
    }
    let answer = landing.map_err(|failure| DriverError::shared(&failure));
    landed.send(answer).unwrap_or(());
}
