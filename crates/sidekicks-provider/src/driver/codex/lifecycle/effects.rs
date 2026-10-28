//! What the handles built before the session pieces do through them once composed: the frame
//! delivery's effects on the asks, the rewind and the queue, a session's disposal, and the service
//! events, each reaching the pieces through one weak link, so no piece keeps itself alive.

use std::sync::{Arc, OnceLock, Weak};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::delivery::frames::CodexFrameEffects;
use crate::driver::codex::delivery::rows::CodexRowRun;
use crate::driver::codex::lifecycle::CodexDriverParts;
use crate::driver::codex::run::start::record::CodexSessionDisposal;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::server_requests::CodexAskKind;
use crate::driver::codex::session::lifecycle_call::let_go_codex_session_record;
use crate::driver::run_control::RunToolBoundary;
use crate::port::plan::ProviderPlan;

/// The link to the session pieces, set once they are composed.
#[derive(Default)]
pub(crate) struct CodexDriverLink {
    parts: OnceLock<Weak<CodexDriverParts>>,
}

impl CodexDriverLink {
    /// Links the composed pieces; a second link is ignored, since the first pieces stay.
    pub(crate) fn set(&self, parts: &Arc<CodexDriverParts>) {
        // The driver keeps only the pieces set first, so a second set has nothing to link.
        let _kept = self.parts.set(Arc::downgrade(parts));
    }

    /// The pieces, `None` before they are composed or once the driver is gone.
    pub(crate) fn parts(&self) -> Option<Arc<CodexDriverParts>> {
        self.parts.get().and_then(Weak::upgrade)
    }
}

/// The frame delivery's effects and a session's disposal, through the link.
pub(crate) struct CodexDriverEffects {
    link: Arc<CodexDriverLink>,
}

impl CodexDriverEffects {
    /// Effects reaching the pieces through `link`.
    pub(crate) fn new(link: Arc<CodexDriverLink>) -> Self {
        Self { link }
    }
}

impl CodexFrameEffects for CodexDriverEffects {
    fn withdraw_ask(
        &self,
        session_id: SessionId,
        provider_account_id: Option<&ProviderAccountId>,
        request_id: &str,
        ask_kind: CodexAskKind,
    ) {
        if let Some(parts) = self.link.parts() {
            parts.hand_off.withdraw(
                session_id,
                provider_account_id.cloned(),
                request_id,
                ask_kind,
            );
        }
    }

    fn forget_turn_asks(&self, session_id: SessionId, turn_id: &str) {
        if let Some(parts) = self.link.parts() {
            parts.hand_off.forget_turn_asks(session_id, turn_id);
        }
    }

    fn cut_oversized_turn(&self, session_id: SessionId, thread_id: &str, turn_id: &str) {
        if let Some(parts) = self.link.parts() {
            parts
                .rewind
                .cut_oversized_turn(session_id, thread_id, turn_id);
        }
    }

    // The queue's tool-boundary intake reaches no driver through a port yet, so a held message
    // waits for its run's turn to end rather than for the boundary.
    fn on_tool_boundary(&self, _boundary: RunToolBoundary) {}

    // Codex holds no request on a plan, so the plan record takes it with nothing held.
    fn plan_proposed(&self, run: &CodexRowRun, text: &str, turn_id: &str, item_id: &str) {
        let Some(parts) = self.link.parts() else {
            return;
        };
        let Some(plans) = parts.ports.plans.port().cloned() else {
            return;
        };
        let plan = ProviderPlan {
            session_id: run.session_id,
            run_id: run.run_id,
            text: text.to_owned(),
            plan_file_path: None,
            holds_request: false,
        };
        let turn_id = turn_id.to_owned();
        let item_id = item_id.to_owned();
        parts.tasks.spawn(async move {
            if let Err(error) = plans.take_plan(plan).await {
                tracing::warn!(
                    error = &*error as &(dyn std::error::Error + 'static),
                    turn_id,
                    item_id,
                    "a plan codex proposed could not be recorded"
                );
            }
        });
    }
}

impl CodexSessionDisposal for CodexDriverEffects {
    fn dispose(&self, session_id: SessionId) {
        let Some(parts) = self.link.parts() else {
            return;
        };
        let tasks = parts.tasks.clone();
        tasks.spawn(async move {
            let claim = parts.slots.claim_closing(session_id).await;
            if let Some(inbound) = claim.live() {
                let_go_codex_session_record(&inbound, CodexRecordExit::SessionContinues).await;
                claim.vacate();
            }
        });
    }
}
