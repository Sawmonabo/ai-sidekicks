//! A Claude Code turn that settled on its terminal frame: the output speed it ran at is settled, a
//! compaction still waiting on it ends uncompacted, and helper starts the turn held are let go. It
//! releases no turn hold: the process's reader released the lead's at the `result` that ended the
//! turn, and a run another caller started since keeps the hold it took. Whether a pending relaunch
//! may go is read from the hold afterwards.

use std::sync::{Arc, Mutex};

use sidekicks_std::mutex_lock::lock;

use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::port::run_host::RunHost;

/// What a turn's settlement settles through.
pub(crate) struct ClaudeTurnSettlement {
    /// Each process's handshake, which holds the output speed a run's turn ran at.
    pub(crate) handshakes: Arc<ClaudeHandshakeRegister>,
    /// The run engine, which records that output speed.
    pub(crate) engine: Arc<dyn RunHost>,
    /// The runs bound to each session.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// Each session's helper limit and the starts it holds.
    pub(crate) helpers: Arc<Mutex<ClaudeHelperLimit>>,
    /// The compaction waits, which the end of a compaction's own turn settles.
    pub(crate) pending_compactions: PendingCompactionRegistry,
}

impl ClaudeTurnSettlement {
    /// Settles the live session's turn on the session's task, and answers whether nothing holds the
    /// session's turn now, so a relaunch that waited for it may go.
    pub(crate) async fn settle_turn(&self, live: &LiveClaudeSession) -> bool {
        let session_id = live.session_id;
        // A turn that ended before its handshake reported settles on the state the process holds.
        if let Some(settled) = self
            .handshakes
            .settle_run_output_speed(session_id, &live.provider_session_id)
            && let Err(error) = self
                .engine
                .record_settled_output_speed(session_id, settled.run_id, settled.state)
                .await
        {
            tracing::warn!(
                session_id = %session_id,
                error = &*error as &(dyn std::error::Error + 'static),
                "the run engine could not record the output speed a Claude Code turn ran at"
            );
        }
        // A compaction holds the turn while it waits, so a turn ending under a wait is the
        // compaction's own, whose frame came first if it compacted.
        self.pending_compactions
            .observe_turn_end(&session_id.to_string());
        let admitted = lock(&self.helpers).turn_ended(&session_id);
        for request_id in admitted {
            answer_claude_request(
                &*live.channel,
                &session_id,
                &live.admitted_provider_account_id,
                request_id,
                &ClaudeHookAnswer::Pass,
            )
            .await;
        }
        !self.routes.is_turn_held(session_id)
    }
}
