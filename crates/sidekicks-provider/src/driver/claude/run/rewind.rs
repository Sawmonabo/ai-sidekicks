//! The conversation cut on Claude Code: `rewind_conversation` cuts the live conversation in place,
//! stopping a running turn first. A refusal arrives as a success carrying `rewound: false`, so the
//! answer is read from `rewound`, never from the answer's kind. The person's undo cuts back to one
//! of their messages, ending the run whose turn the cut took; a turn too long to fit even after
//! compaction is cut back out, since every later turn would fail on it again.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::driver::claude::delivery::stream::ClaudeSessionStreams;
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::driver::claude::run::controls::{ClaudeChoiceSettling, settle_claude_choice};
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::contract::DriverError;
use crate::driver::rewind::RewindConversationResult;
use crate::lenient_json::{lenient_object, read_lenient};
use crate::port::registration::PortRegistration;
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::run::delivery::{DeliveryBinding, InboundDelivery};
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use sidekicks_std::mutex_lock::lock;

// Why a run whose turn a cut took before Claude Code settled it ended failed.
const CLAUDE_SUPERSEDED_RUN_DETAIL: &str = "The turn carrying this run's words was cut from the \
    conversation before the provider settled it, so whether those words reached the model was \
    never established.";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewindReply {
    #[serde(default, deserialize_with = "read_lenient")]
    rewound: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    reason: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    prefill_text: Option<String>,
}

lenient_object!(RewindReply);

/// The person's undo and the cut of a turn too long to fit, on live Claude Code sessions.
pub(crate) struct ClaudeConversationCuts {
    /// The runs bound to each session.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// The messages written and not yet reported taken.
    pub(crate) prompts: Arc<Mutex<ClaudeSentPrompts>>,
    /// The choices Claude Code holds a run on.
    pub(crate) dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
    /// Each live session's stream, whose queue a superseded run's end takes.
    pub(crate) streams: Arc<ClaudeSessionStreams>,
}

impl ClaudeConversationCuts {
    /// Cuts the live conversation back to before the person's message `target_message_id`. A
    /// choice the running turn is held on is settled as an interrupt's is, and the run whose turn
    /// the cut took ends failed before its route retires, since no turn end can reach it after. A
    /// refused cut is `Degraded` with Claude Code's reason; fails as the settle or the request
    /// fails. An applied cut lets go the held `Allow once` presses of every binding the process
    /// served, through `reviewer_denials` once the approvals are registered.
    pub(crate) async fn rewind(
        &self,
        live: &LiveClaudeSession,
        target_message_id: &str,
        reviewer_denials: &PortRegistration<Arc<dyn ReviewerDenialPort>>,
    ) -> Result<RewindConversationResult, DriverError> {
        if let Some(lead) = self.routes.lead_run_on(live.session_id) {
            settle_claude_choice(
                &self.dialogs,
                live,
                lead.run_id,
                ClaudeChoiceSettling::Interrupt,
            )
            .await?;
        }
        let newest = self
            .lock_prompts()
            .newest_for(live.session_id)
            .map(str::to_owned);
        let result = cut_claude_conversation(live, target_message_id, newest).await?;
        if matches!(result, RewindConversationResult::Applied { .. }) {
            if let Some(lead) = self.routes.lead_run_on(live.session_id) {
                self.fail_superseded_run(live, lead.run_id, lead.binding_id);
                self.routes.forget_run(lead.run_id);
            }
            self.routes.retire_run_routes(live.session_id);
            self.lock_prompts().forget_session(live.session_id);
            // Every run the process served is retired, so none still needs its presses.
            live.release_served_presses(reviewer_denials);
        }
        Ok(result)
    }

    /// Cuts the newest message of a turn too long to fit back out of the conversation, off the
    /// session's task; a failed cut is recorded, since no caller hears it.
    pub(crate) fn cut_too_long_turn(self: &Arc<Self>, live: Arc<LiveClaudeSession>) {
        let Some(newest) = self
            .lock_prompts()
            .newest_for(live.session_id)
            .map(str::to_owned)
        else {
            return;
        };
        let cuts = Arc::clone(self);
        tokio::spawn(async move {
            match cut_claude_conversation(&live, &newest, Some(newest.clone())).await {
                Ok(RewindConversationResult::Applied { .. }) => {
                    cuts.lock_prompts().forget_session(live.session_id);
                }
                Ok(RewindConversationResult::Degraded { fallback_action }) => {
                    tracing::warn!(
                        session_id = %live.session_id,
                        fallback_action,
                        "Claude Code refused to cut a turn too long to fit"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        session_id = %live.session_id,
                        error = &error as &(dyn std::error::Error + 'static),
                        "the cut of a Claude Code turn too long to fit failed"
                    );
                }
            }
        });
    }

    /// Ends the run whose turn a cut or a fork took as failed, on its own binding, through the
    /// session's queue so it keeps its place behind the turn's frames.
    pub(crate) fn fail_superseded_run(
        &self,
        live: &LiveClaudeSession,
        run_id: RunId,
        binding_id: RuntimeBindingId,
    ) {
        let Some(stream) = self.streams.get(live.session_id) else {
            return;
        };
        let change = RunStateReport {
            failure_category: Some(RunFailureCategory::ProviderFailure),
            ..RunStateReport::new(
                run_id,
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause: None,
                    provider_failure_detail: Some(
                        FreeFormText::new(CLAUDE_SUPERSEDED_RUN_DETAIL.to_owned())
                            .expect("the superseded run's words fit a failure's detail"),
                    ),
                    process_exit: None,
                },
            )
        };
        drop(stream.arrivals().dispatch(InboundDelivery::RunLifecycle {
            binding: DeliveryBinding {
                binding_id,
                operation: None,
            },
            change,
            turn_end: None,
            is_daemon_interrupt_end: false,
        }));
    }

    fn lock_prompts(&self) -> std::sync::MutexGuard<'_, ClaudeSentPrompts> {
        lock(&self.prompts)
    }
}

// Cuts the live conversation back to before `target_message_id`, naming the newest message the
// daemon sent, since Claude Code refuses a cut when a later message is one it may not have seen.
async fn cut_claude_conversation(
    live: &LiveClaudeSession,
    target_message_id: &str,
    newest_message_id: Option<String>,
) -> Result<RewindConversationResult, ClaudeSessionError> {
    let answer = live
        .channel
        .send_control_request(ClaudeControlRequest::RewindConversation {
            target_message_uuid: target_message_id.to_owned(),
            last_seen_user_message_uuid: newest_message_id,
            interrupt_if_running: true,
        })
        .await?;
    let reply = answer
        .response
        .and_then(|response| serde_json::from_str::<RewindReply>(response.get()).ok())
        .unwrap_or_default();
    if reply.rewound != Some(true) {
        return Ok(RewindConversationResult::Degraded {
            fallback_action: reply
                .reason
                .filter(|reason| !reason.is_empty())
                .map(|reason| format!("rewind-refused: {reason}")),
        });
    }
    Ok(RewindConversationResult::Applied {
        binding_id: None,
        cut_message_text: reply.prefill_text.filter(|text| !text.is_empty()),
    })
}
