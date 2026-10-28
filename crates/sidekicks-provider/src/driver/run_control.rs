//! The params and results of the driver operations that act on one live run: a steer or an
//! interrupt, pause and continue, withdrawing a waiting message, overruling a reviewer's block,
//! answering a provider's choice and resending a held turn on a faster model; and the binding the
//! run queue opens for a turn the daemon starts itself.

use std::error::Error;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FALLBACK_ACTION_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::{
    PROVIDER_WIRE_HANDLE_MAX_LEN, PROVIDER_WIRE_REASON_MAX_LEN,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{RunRefusalChoice, RunUsageCreditsChoice};
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};

/// A skill picked for a message as its provider listed it: its name and the file the provider
/// loads it from, absolute. The daemon resolves a person's pick to it, so no path a client sent
/// reaches a provider; reading one refuses an empty field or an unknown member.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PickedSkill {
    /// The skill's name.
    pub(crate) name: NonEmptyText,
    /// The file the provider loads it from.
    pub(crate) path: NonEmptyText,
}

/// Payload of a driver's steer: the queued message's content, its attachments, the skills the
/// person picked for it and a target turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SteerPayload {
    /// The message's words.
    pub content: MessageContent,
    /// The message's files in staging order; one the turn cannot resolve becomes an unresolved
    /// marker in its own place, never dropped, and no count of the app's own bounds the list.
    pub attachments: Vec<ArtifactId>,
    /// The skills picked for the message, in the order picked.
    pub skills: Vec<PickedSkill>,
    /// The provider turn the steer is meant for.
    pub expected_turn_id: Option<String>,
    /// Whether the provider reads it before anything it holds, at the turn's next step: a
    /// person's `Send now` on a provider that reads a priority message.
    pub is_priority: bool,
}

/// What the daemon asks a driver to do on a live run, one arm per verb: a steer delivers a message
/// the run queue holds, and an interrupt carries out an intervention. The idempotency key is
/// passed through unchanged; a steer's is the message's own id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyInterventionParams {
    /// Delivers a message the run queue holds into the running turn.
    Steer {
        /// The run the message goes to.
        target_run_id: RunId,
        /// The run version the queue saw.
        expected_run_version: SafeInt<0>,
        /// The message's own id.
        client_idempotency_key: QueueItemId,
        /// The message.
        payload: SteerPayload,
    },
    /// Carries out an interrupt.
    Interrupt {
        /// The run interrupted.
        target_run_id: RunId,
        /// The run version the caller saw, the fail-closed comparand.
        expected_run_version: SafeInt<0>,
        /// The requester's idempotency key, passed through unchanged.
        client_idempotency_key: ClientUuid,
        /// What the interrupt does.
        payload: InterruptPayload,
    },
}

/// What an interrupt does with the messages still waiting for the run. Stored by its camelCase
/// name.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, strum::IntoStaticStr, strum::VariantArray, strum::EnumString,
)]
#[strum(serialize_all = "camelCase")]
pub enum InterruptPendingChoice {
    /// They go as the next turn.
    NextTurn,
    /// They return to the draft.
    ReturnToDraft,
    /// They keep waiting, and none starts a turn of its own: the daemon's interrupt at a limit.
    KeepWaiting,
}

/// Payload of a driver's interrupt: what becomes of the waiting messages, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InterruptPayload {
    /// What becomes of the waiting messages.
    pub pending: InterruptPendingChoice,
    /// Whether the choice moves a waiting message ahead of the ones before it, so a provider that
    /// holds its waiting messages must hand them back for the daemon to resend in that order.
    pub reorders_waiting: bool,
    /// The person's reason.
    pub reason: Option<FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>>,
}

/// Asks a driver to interrupt one run, with an optional reason. A run's id is unique
/// on its own, so no session id sits beside it as a second key that could disagree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InterruptRunRequest {
    /// The run to interrupt.
    pub run_id: RunId,
    /// The person's reason.
    pub reason: Option<FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>>,
}

/// Whether an intervention landed as asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterventionResultStatus {
    /// As asked.
    Applied,
    /// Through a fallback.
    Degraded,
}

/// What a driver answers an intervention with. `fallback_action` names the fallback of a
/// `Degraded` result; `delivered_run_id` names the run a delivered message went to when that is
/// not its target; `canceled` names the waiting messages an interrupt took back from the provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyInterventionResponse {
    /// Whether it landed as asked.
    pub status: InterventionResultStatus,
    /// The fallback a degraded result took.
    pub fallback_action: Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>,
    /// The run a delivered message went to, when not the target.
    pub delivered_run_id: Option<RunId>,
    /// The messages the provider held that an interrupt took back, none of which runs: the ids of
    /// its receipt that read as queue items, the driver dropping any other it does not recognize.
    pub canceled: Vec<QueueItemId>,
}

/// A driver's steer, or a continue that waited on a pause, not sent because the turn it was handed
/// for ended first: nothing reached the provider, and the message is left for the run's next turn.
#[derive(Debug, thiserror::Error)]
#[error("the turn of run {run_id} ended before the message was sent")]
pub struct SteerTurnEndedError {
    /// The run whose turn ended.
    pub run_id: RunId,
}

/// A run start the driver refused before its provider saw the run: the model it would have run on
/// and the refusal's sentence, which the run's failure carries as the daemon's own refusal.
#[derive(Debug, thiserror::Error)]
#[error("{sentence}")]
pub struct DriverRunRefusal {
    /// The model the run would have run on.
    pub model: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    /// The refusal's sentence.
    pub sentence: String,
}

/// Params of `pause_run`: the lead run or a provider subagent's child run to stop after the step
/// in flight. The caller has moved the run to `pausing`; the driver reports `paused` once nothing
/// runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PauseRunParams {
    /// The session.
    pub session_id: SessionId,
    /// The run to pause.
    pub run_id: RunId,
}

/// A message waiting for a run, as the queue holds it, for delivery when the run continues: its
/// words, files and the skills picked for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WaitingMessage {
    /// The queue item.
    pub id: QueueItemId,
    /// The words.
    pub content: MessageContent,
    /// The message's files in staging order.
    pub attachments: Vec<ArtifactId>,
    /// The skills picked for the message, in the order picked.
    pub skills: Vec<PickedSkill>,
}

/// Params of `resume_run`: the paused or pausing run to continue from where it stopped, with the
/// messages that waited for it in send order, delivered as it continues.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeRunParams {
    /// The session.
    pub session_id: SessionId,
    /// The run to continue.
    pub run_id: RunId,
    /// The messages that waited for it, in send order.
    pub messages: Vec<WaitingMessage>,
}

/// Params of `find_taken_messages`: messages a resume of the run sent with no answer back, by the
/// ids they went under, to look up in the provider's own record of the conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindTakenMessagesParams {
    /// The session.
    pub session_id: SessionId,
    /// The run the messages were sent into.
    pub run_id: RunId,
    /// The ids the messages went under.
    pub message_ids: Vec<QueueItemId>,
}

/// The messages of a [`FindTakenMessagesParams`] the provider's own record holds, so it took them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TakenMessages {
    /// The ids the record holds, among those asked about.
    pub taken: Vec<QueueItemId>,
}

/// Params of `withdraw_queued_message` (gated on `steer`): takes back a steer sent into a running
/// turn before the provider reads it. The key is the steer's own, which the driver sent as the
/// message's id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawQueuedMessageParams {
    /// The session.
    pub session_id: SessionId,
    /// The run the steer went to.
    pub run_id: RunId,
    /// The steer's own key.
    pub client_idempotency_key: QueueItemId,
}

/// What a withdraw did: taken back before the provider read the message, or already delivered
/// when the message is no longer the driver's to take back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WithdrawQueuedMessageResult {
    /// Taken back before the provider read it.
    Withdrawn {},
    /// The provider took it into the turn, or the driver had already sent it on, so nothing was
    /// taken back.
    AlreadyDelivered {},
}

/// Params of `override_denial`: `Allow once` on a block by the provider's own reviewer, addressed
/// to the run the block was made in, which may have ended. The denial is the provider's own record
/// of the block, as the daemon kept it, relayed back unchanged.
#[derive(Debug)]
pub struct OverrideDenialParams {
    /// The session.
    pub session_id: SessionId,
    /// The run the block was made in.
    pub run_id: RunId,
    /// The provider's own record of the block.
    pub provider_denial: Box<RawValue>,
}

/// The person's answer to a choice the provider holds a run on, one arm per kind of choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderChoiceAnswer {
    /// The answer to a refused turn's retry-or-edit choice.
    Refusal {
        /// The answer.
        choice: RunRefusalChoice,
    },
    /// The answer to a turn's switch-or-credits choice.
    UsageCredits {
        /// The answer.
        choice: RunUsageCreditsChoice,
    },
}

/// Params of `answer_provider_choice`: the run the choice holds and the person's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnswerProviderChoiceParams {
    /// The session.
    pub session_id: SessionId,
    /// The run the choice holds.
    pub run_id: RunId,
    /// The person's answer.
    pub answer: ProviderChoiceAnswer,
}

/// What answering a choice did: the provider took the answer, or the run holds no choice of that
/// kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerProviderChoiceResult {
    /// The provider took the answer.
    Answered {},
    /// The run holds no choice of that kind, because it was settled or never asked.
    NotPending {},
}

/// Params of `retry_turn_on_faster_model`: resend the turn `expected_turn_id` that the provider
/// holds for a safety check, on `model`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FasterModelRetryParams {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The provider turn the safety check holds.
    pub expected_turn_id: String,
    /// The model to resend it on.
    pub model: ProviderToken,
}

/// How a faster-model retry ended: sent again, or refused with its reason. A failure after the
/// retry was accepted is the operation's error, not an outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FasterModelRetryOutcome {
    /// Sent again.
    Applied {},
    /// Refused, because the turn is no longer the run's latest or its reply has started.
    Rejected {
        /// Why it was refused.
        rejection_reason: String,
    },
}

/// A tool call of a run's turn finished while the turn still runs: the step boundary at which the
/// run queue hands the driver every message it holds for that run, in send order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunToolBoundary {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
}

/// The reason a helper reads when its next tool use is refused at its token limit.
pub const HELPER_TOKEN_LIMIT_REASON: &str =
    "You have reached your token limit. Report what you completed and what remains.";

/// Params of `stop_helper_at_token_limit`: the helper whose own run passed its token limit, which
/// stops alone while its lead goes on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelperTokenLimitParams {
    /// The session.
    pub session_id: SessionId,
    /// The helper's own run.
    pub run_id: RunId,
    /// The provider's id of the helper on its lead's run.
    pub subagent_id: SubagentId,
}

/// The binding a turn the daemon starts on a session itself runs on, and the session's agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonTurnBinding {
    /// The runtime binding.
    pub binding_id: RuntimeBindingId,
    /// The session's lead agent.
    pub agent_id: AgentId,
    /// The session's own bound on the steps one turn may take, read as the binding opens; `None`
    /// where the person set none.
    pub step_bound: Option<SafeInt<1>>,
}

/// Why the binding of a turn the daemon starts on a session could not be opened, which ends the
/// run failed.
#[derive(Debug, thiserror::Error)]
pub enum DaemonTurnBindingError {
    /// The session's provider session was not opened in this process.
    #[error(
        "the provider session of session {} could not be opened: it has no provider session open",
        .session_id
    )]
    NoProviderSession {
        /// The session.
        session_id: SessionId,
    },
    /// The session has no conversation to run on.
    #[error(
        "the provider session of session {} could not be opened: it has no conversation to run on",
        .session_id
    )]
    NoConversation {
        /// The session.
        session_id: SessionId,
    },
    /// The run's binding could not be recorded.
    #[error("the binding of a turn on session {session_id} could not be recorded")]
    BindingNotRecorded {
        /// The session.
        session_id: SessionId,
        /// The store's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
}

/// Opens the binding of a turn the daemon starts on a session itself; the run queue serves it.
pub trait DaemonTurnBindingResolver: Send + Sync {
    /// The binding `run_id` runs on in `session_id`, and the session's lead agent. An error when
    /// the binding cannot be opened, which ends the run failed.
    fn open_daemon_turn_binding(
        &self,
        run_id: RunId,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>>;
}
