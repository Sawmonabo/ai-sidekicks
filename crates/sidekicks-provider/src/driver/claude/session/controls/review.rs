//! Claude Code's own review of the session's changes with its bundled `code-review` skill, between
//! the `reviewStarted` and `reviewFinished` notices: a turn the daemon starts on the session
//! itself, or the turn of a run the queue admitted. The staged set alone is reviewed by a one-turn
//! process apart from the session's own.

use std::future::Future;
use std::sync::Arc;

use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{ClaudeReviewProgress, ClaudeSessionControls};
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::run::start::{ClaudeDaemonTurnOpening, claude_session_unavailable};
use crate::driver::claude::session::errors::ClaudeSessionUnavailableReason;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::contract::{DriverError, StartRunParams};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};

// The bundled skill Claude Code's review runs, by the name the build's skill list gives it.
const CLAUDE_REVIEW_SKILL_NAME: &str = "code-review";

impl ClaudeSessionControls {
    /// Starts Claude Code's own review of `target` as the session's own run: a turn on the
    /// session's process for the working tree or the branch, and for the staged set a one-turn
    /// process in a worktree holding only the staged changes, which a stop ends. Returns once it
    /// has started; fails `ReviewSkillAbsent` when the build lists no such skill, and as the run's
    /// start fails.
    pub(crate) async fn start_review(
        self: &Arc<Self>,
        live: &Arc<LiveClaudeSession>,
        target: SessionReviewTarget,
    ) -> Result<(), DriverError> {
        let session_id = live.session_id;
        self.require_review_skill(live)?;
        if target == SessionReviewTarget::Staged {
            return self.start_staged_review(live).await;
        }
        let opening = ClaudeDaemonTurnOpening::Text {
            text: review_text(target),
            message_id: mint_uuid_v7().to_string(),
            attachment_blocks: Vec::new(),
        };
        self.run_review(session_id, target, async {
            self.run_start
                .start_daemon_turn(session_id, opening)
                .await
                .map(drop)
        })
        .await
    }

    /// Starts Claude Code's own review of `target` as the turn of the run the queue admitted in
    /// `params`, which ends as the review ends; the staged set is reviewed apart from the session's
    /// process under that run. Fails as `start_review` does.
    pub(crate) async fn start_queued_review(
        self: &Arc<Self>,
        params: &StartRunParams,
        target: SessionReviewTarget,
    ) -> Result<(), DriverError> {
        let opening = &params.opening;
        let session_id = opening.session_id;
        let live = self.run_start.live_session(session_id)?;
        self.require_review_skill(&live)?;
        if target == SessionReviewTarget::Staged {
            let run = ClaudeBoundRun {
                run_id: params.run_id,
                binding_id: opening.binding_id.clone(),
            };
            self.start_queued_staged_review(&live, run).await;
            return Ok(());
        }
        let text = review_text(target);
        self.run_review(
            session_id,
            target,
            self.run_start.start_run(params, &text, &[]),
        )
        .await
    }

    // Refuses a review on a process whose build lists no `code-review` skill.
    fn require_review_skill(&self, live: &LiveClaudeSession) -> Result<(), DriverError> {
        let has_skill = self
            .run_start
            .handshakes
            .held_handshake_for(live.session_id, &live.provider_session_id)
            .is_some_and(|held| {
                held.declaration
                    .skills
                    .iter()
                    .any(|skill| skill == CLAUDE_REVIEW_SKILL_NAME)
            });
        if has_skill {
            return Ok(());
        }
        Err(claude_session_unavailable(
            ClaudeSessionUnavailableReason::ReviewSkillAbsent,
            live.session_id,
            None,
        )
        .into())
    }

    // Runs the review's turn start between its notices. The review is held before the turn
    // starts, so a turn that ends at once still finishes it, and its finish waits for its start.
    async fn run_review(
        &self,
        session_id: SessionId,
        target: SessionReviewTarget,
        start: impl Future<Output = Result<(), DriverError>>,
    ) -> Result<(), DriverError> {
        self.lock()
            .reviews
            .insert(session_id, ClaudeReviewProgress::default());
        if let Err(error) = start.await {
            self.lock().reviews.remove(&session_id);
            return Err(error);
        }
        self.post_notice(
            session_id,
            SessionNotice::ReviewStarted { session_id, target },
        )
        .await;
        // The turn may have ended while the start notice went; its finish waited for it.
        let has_ended = {
            let mut tables = self.lock();
            match tables.reviews.get_mut(&session_id) {
                Some(review) if review.has_ended => {
                    tables.reviews.remove(&session_id);
                    true
                }
                Some(review) => {
                    review.is_started_posted = true;
                    false
                }
                None => false,
            }
        };
        if has_ended {
            self.post_notice(session_id, SessionNotice::ReviewFinished { session_id })
                .await;
        }
        Ok(())
    }
}

/// The review command for `target`, typed as a person's words: with no words the skill reads the
/// branch's commits ahead of its upstream and every uncommitted change; the working tree alone is
/// named in words.
pub(super) fn review_text(target: SessionReviewTarget) -> OutboundText {
    let text = match target {
        SessionReviewTarget::Branch => format!("/{CLAUDE_REVIEW_SKILL_NAME}"),
        SessionReviewTarget::WorkingTree | SessionReviewTarget::Staged => {
            format!("/{CLAUDE_REVIEW_SKILL_NAME} the uncommitted changes in the working tree")
        }
    };
    OutboundText {
        text,
        origin: OutboundTextOrigin::HumanText,
    }
}
