//! A Claude Code session's move onto another account: its process ended between turns and its
//! conversation resumed by id on that account, a busy session's move waiting for its turn and the
//! newest move asked meanwhile replacing the account and the leg of the one waiting.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use super::{ClaudeRestartStage, ClaudeSessionRestarts};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::session_process_unavailable;
use crate::driver::session_control::DriverResumeResult;
use crate::runtime_binding::writer::RuntimeBindingWriter;

// A move onto another account waiting for its session's turn to settle, the newest move's account
// and leg, and where its landing is told to every move it replaced too; dropped, it tells each the
// session is gone.
pub(super) struct ClaudePendingAccountMove {
    pub(super) provider_account_id: ProviderAccountId,
    pub(super) leg: ClaudeLegBinding,
    pub(super) landed: Vec<oneshot::Sender<Result<ClaudeAccountLanding, DriverError>>>,
}

/// Where a session's move onto another account landed: the binding its relaunched process runs
/// under, and the account it runs on, a later move's where one replaced the move while it waited.
#[derive(Clone)]
pub(crate) struct ClaudeAccountLanding {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The account.
    pub(crate) provider_account_id: ProviderAccountId,
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

impl ClaudeSessionRestarts {
    /// Moves `live` onto `provider_account_id`'s account by ending its process the way a close
    /// does and resuming its conversation by id on that account, as a relaunch does, so the new
    /// process starts with that account's sign-in: an idle session at once, a busy one when its
    /// turn settles. `leg` moves onto the account just before the relaunch, after every frame of
    /// the turn it waited for. A move asked while another waits replaces its account and leg, so
    /// one relaunch lands on the newest and answers both. Answers where the session landed once
    /// its relaunched process runs; fails `provider.unavailable` once the process is no longer the
    /// session's or ended first, as the move of `leg` fails, and with the relaunch's failure,
    /// which the session directory records too.
    pub(crate) async fn relaunch_on_account(
        self: &Arc<Self>,
        live: &Arc<LiveClaudeSession>,
        provider_account_id: ProviderAccountId,
        leg: ClaudeLegBinding,
    ) -> Result<ClaudeAccountLanding, DriverError> {
        let session_id = live.session_id;
        if !self.routes.is_turn_held(session_id) {
            return self
                .relaunch_now_on_account(live, provider_account_id, &leg)
                .await;
        }
        let (landed, landing) = oneshot::channel();
        {
            let mut table = lock(&self.table);
            let mut waiting = table
                .pending_account_moves
                .remove(&session_id)
                .map_or_else(Vec::new, |replaced| replaced.landed);
            waiting.push(landed);
            table.pending_account_moves.insert(
                session_id,
                ClaudePendingAccountMove {
                    provider_account_id,
                    leg,
                    landed: waiting,
                },
            );
        }
        landing
            .await
            .unwrap_or_else(|_dropped| Err(session_process_unavailable(session_id).into()))
    }

    // Relaunches `live` on `provider_account_id`'s account now, under a binding that copies
    // `leg`'s, and answers that binding on that account; the session and `leg` stay on their
    // account where its process is no longer its own.
    pub(super) async fn relaunch_now_on_account(
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
