//! The conversation cut on Claude Code: `rewind_conversation` cuts the live conversation in place,
//! stopping a running turn first. A refusal arrives as a success carrying `rewound: false` and a
//! `reason`, so the answer is read from `rewound`, never from the answer's kind. The reason is one
//! of a closed set of codes, [`ClaudeRewindRefusal`], some of which Claude Code marks as worth
//! sending again. The person's undo cuts back to one of their messages, ending the run whose turn
//! the cut took; a turn too long to fit even after compaction is cut back out, since every later
//! turn would fail on it again.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use strum::EnumString;

use crate::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::driver::claude::delivery::stream::ClaudeSessionStreams;
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::driver::claude::run::controls::{ClaudeChoiceSettling, settle_claude_choice};
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::contract::error::DriverError;
use crate::driver::rewind::RewindConversationResult;
use crate::lenient_json::{lenient_object, read_lenient};
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::run::delivery::{DeliveryBinding, InboundDelivery};
use crate::run::state_entry::{RunStateEntry, RunStateReport};

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
    // Spelled in snake_case on the wire, unlike the reply's other members.
    #[serde(
        default,
        rename = "target_not_found",
        deserialize_with = "read_lenient"
    )]
    target_not_found: Option<bool>,
}

lenient_object!(RewindReply);

/// Why Claude Code refused a cut: the `reason` of a refused `rewind_conversation`, read from its
/// `snake_case` word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, EnumString)]
#[strum(serialize_all = "snake_case")]
enum ClaudeRewindRefusal {
    /// Messages were queued behind the running turn.
    CommandsQueued,
    /// A message was written and not yet taken into a turn.
    PromptPending,
    /// A turn was still running.
    TurnRunning,
    /// The message to cut back to is not in the conversation Claude Code holds.
    TargetNotFound,
    /// The message to cut back to is older than the conversation allows a cut to.
    StaleTarget,
    /// A later turn exists that the daemon has not seen.
    UnseenLaterTurn,
    /// The message to cut back to is a tool's result from a poll.
    PollToolResultTarget,
    /// The cut would fall between a tool call and its result.
    TargetSplitsToolCall,
    /// Events of a poll were already delivered inside the range the cut removes.
    DeliveredPollEventsInRange,
    /// Claude Code could not save where the cut lands.
    PersistFailed,
    /// The conversation changed while the cut was made.
    StateChanged,
    /// The account's usage limit was reached.
    UsageLimited,
    /// The request waited too long to be taken.
    Expired,
}

impl ClaudeRewindRefusal {
    /// Whether Claude Code marks a cut it refused for this reason as one a caller may send again.
    fn may_be_sent_again(self) -> bool {
        match self {
            Self::CommandsQueued
            | Self::TurnRunning
            | Self::TargetNotFound
            | Self::PersistFailed
            | Self::StateChanged
            | Self::Expired => true,
            Self::PromptPending
            | Self::StaleTarget
            | Self::UnseenLaterTurn
            | Self::PollToolResultTarget
            | Self::TargetSplitsToolCall
            | Self::DeliveredPollEventsInRange
            | Self::UsageLimited => false,
        }
    }
}

// What one `rewind_conversation` answered.
enum ClaudeCutAnswer {
    // The cut landed, with the text of the message it removed where Claude Code returned it.
    Applied { cut_message_text: Option<String> },
    Refused(ClaudeCutRefusal),
}

// A refused cut: the reason's word as sent, its code when the word is one of the set, and whether
// Claude Code also found the target missing.
struct ClaudeCutRefusal {
    reason: Option<String>,
    refusal: Option<ClaudeRewindRefusal>,
    is_target_not_found: bool,
}

impl ClaudeCutRefusal {
    // A cut refused for a code Claude Code marks sendable again, with its target found, goes once
    // more; a missing target is no resend, and a word outside the set is final.
    fn may_be_sent_again(&self) -> bool {
        !self.is_target_not_found
            && self.refusal.is_some_and(|refusal| {
                refusal != ClaudeRewindRefusal::TargetNotFound && refusal.may_be_sent_again()
            })
    }

    fn into_degraded(self) -> RewindConversationResult {
        RewindConversationResult::Degraded {
            fallback_action: self
                .reason
                .filter(|reason| !reason.is_empty())
                .map(|reason| format!("rewind-refused: {reason}")),
        }
    }
}

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
    /// refusal Claude Code marks sendable again, but a missing target, is sent once more after the
    /// session's turn settles; any other refusal, a second one, or a turn still held at the
    /// request deadline is `Degraded` with Claude Code's reason. Fails as the settle or a request
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
        let session_id = live.session_id;
        // Taken before the first send, so a turn released while it goes still wakes the wait.
        let mark = self.routes.turn_mark(session_id);
        let mut answer = self.cut_to(live, target_message_id).await?;
        // A refusal Claude Code marks sendable goes once more after the turn settles; one whose
        // turn is still held at the deadline is final.
        if let ClaudeCutAnswer::Refused(refusal) = &answer
            && refusal.may_be_sent_again()
            && (!self.routes.is_turn_held(session_id)
                || self
                    .routes
                    .when_turn_changed_after(session_id, mark, CLAUDE_REQUEST_DEADLINE)
                    .await)
        {
            answer = self.cut_to(live, target_message_id).await?;
        }
        let cut_message_text = match answer {
            ClaudeCutAnswer::Applied { cut_message_text } => cut_message_text,
            ClaudeCutAnswer::Refused(refusal) => return Ok(refusal.into_degraded()),
        };
        if let Some(lead) = self.routes.lead_run_on(session_id) {
            self.fail_superseded_run(live, lead.run_id, lead.binding_id);
            self.routes.forget_run(lead.run_id);
        }
        self.routes.retire_run_routes(session_id);
        self.lock_prompts().forget_session(session_id);
        // Every run the process served is retired, so none still needs its presses.
        live.release_served_presses(reviewer_denials);
        Ok(RewindConversationResult::Applied {
            binding_id: None,
            cut_message_text,
        })
    }

    // Sends the cut back to before `target_message_id`, naming the newest message written as it
    // goes.
    async fn cut_to(
        &self,
        live: &LiveClaudeSession,
        target_message_id: &str,
    ) -> Result<ClaudeCutAnswer, ClaudeSessionError> {
        let newest = self
            .lock_prompts()
            .newest_for(live.session_id)
            .map(str::to_owned);
        cut_claude_conversation(live, target_message_id, newest).await
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
                Ok(ClaudeCutAnswer::Applied { .. }) => {
                    cuts.lock_prompts().forget_session(live.session_id);
                }
                Ok(ClaudeCutAnswer::Refused(refusal)) => {
                    tracing::warn!(
                        session_id = %live.session_id,
                        reason = refusal.reason,
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
) -> Result<ClaudeCutAnswer, ClaudeSessionError> {
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
        let refusal = reply
            .reason
            .as_deref()
            .and_then(|reason| reason.parse().ok());
        return Ok(ClaudeCutAnswer::Refused(ClaudeCutRefusal {
            reason: reply.reason,
            refusal,
            is_target_not_found: reply.target_not_found == Some(true),
        }));
    }
    Ok(ClaudeCutAnswer::Applied {
        cut_message_text: reply.prefill_text.filter(|text| !text.is_empty()),
    })
}

#[cfg(test)]
mod tests;
