//! What a Codex service, its connection and its conversations report to the service log: one
//! closed set, so nothing drops silently. Each names what happened and a bounded reason, never a
//! frame's own content, which can hold the person's words, a file or a credential. The facts the
//! shared driver diagnostics already name are logged through them, with their counters.

use std::error::Error;
use std::path::PathBuf;

use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use strum::IntoStaticStr;

use crate::error_description::describe_error;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::session::helper_roles::CodexRoleFileWithheldField;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

/// A failure a diagnostic carries, logged with every cause.
type DiagnosticCause = Box<dyn Error + Send + Sync>;

/// Why a message from the service is no JSON-RPC message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CodexUnparsableMessageReason {
    /// The text is not JSON.
    NotJson,
    /// The JSON is not an object.
    NotAnObject,
    /// A response that names no request id.
    ResponseWithoutId,
}

/// The teardown steps that carry on past a failure of their own.
#[expect(
    dead_code,
    reason = "the Codex session close reports each step that failed"
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CodexTeardownStep {
    /// Leaving the conversation's notifications.
    ThreadUnsubscribe,
    /// Interrupting the running turn.
    TurnInterrupt,
    /// Listing the conversation's background terminals.
    BackgroundTerminalList,
    /// Ending one background terminal.
    BackgroundTerminalTerminate,
    /// Clearing the ended background terminals.
    BackgroundTerminalClean,
    /// Stopping the service.
    ServiceStop,
}

/// A port the daemon wired that the driver hands deliveries to.
#[expect(
    dead_code,
    reason = "the Codex deliveries report the port a delivery failed at"
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CodexDeliveryPort {
    /// A run's end.
    RunEnd,
    /// A session started again on a new process.
    SessionRelaunched,
    /// A permission ask.
    PermissionAsk,
    /// A question to the person.
    Question,
    /// Codex's own reviewer denying a call.
    ReviewerDenial,
    /// The service's own prompts.
    ServerPrompts,
    /// A run's output speed.
    OutputSpeed,
}

/// Why the frames held while a turn Codex started opens its run went on before the run opened.
#[expect(
    dead_code,
    reason = "the Codex session's frame hold reports why it let its frames go"
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CodexHeldFramesReleaseReason {
    /// The hold filled.
    HoldFull,
    /// The hold outlived its deadline.
    HoldDeadline,
}

/// Everything the Codex transport, service and deliveries could not route or carry out, and the
/// notices only the service log keeps; `report` logs one.
#[expect(
    dead_code,
    reason = "the Codex connection, service, sessions and deliveries report what they could not do"
)]
#[derive(Debug)]
pub(crate) enum CodexTransportDiagnostic {
    /// A message that is no JSON-RPC message, by why and how long it was.
    UnparsableMessage {
        /// Why it is none.
        reason: CodexUnparsableMessageReason,
        /// Its length, in characters.
        character_count: usize,
    },
    /// A response naming a request id nothing waits on.
    UnknownResponseId {
        /// The id it named.
        response_id: String,
    },
    /// A request from the service that nothing handles, answered `-32601`.
    UnhandledServerRequest {
        /// The request's method.
        method: String,
        /// Whether the protocol names the method.
        is_in_protocol: bool,
    },
    /// A request the service routes to a session that reached none, so it was refused.
    UnroutedServerRequestRefused {
        /// The request's method.
        method: String,
    },
    /// The responder of a request from the service failed.
    ServerRequestResponderFailed {
        /// The request's method.
        method: String,
        /// The responder's failure.
        error: DiagnosticCause,
    },
    /// A routed ask named a turn with no live route, so it is refused: deciding it against the
    /// one active run would decide it for a run that never asked.
    RoutedAskTurnUnresolved {
        /// The ask's method.
        method: String,
        /// The turn it named, cut to its bound, or `None` when it named none.
        turn_id: Option<String>,
        /// Whether the turn id was cut.
        is_turn_id_cut: bool,
    },
    /// A routed ask named no conversation a session holds on this service, so it is refused.
    RoutedAskThreadUnresolved {
        /// The ask's method.
        method: String,
        /// The conversation it named, or `None` when it named none.
        thread_id: Option<String>,
    },
    /// An answer to an ask was larger, encoded, than the service takes in one message, so the
    /// service gets a refusal instead, and nothing when the refusal does not fit either.
    ServerRequestAnswerOversized {
        /// The ask's method.
        method: String,
        /// The encoded answer's size, in bytes.
        encoded_bytes: usize,
        /// The most the service takes in one message, in bytes.
        limit: usize,
    },
    /// The answer to an ask could not be sent; the service may wait on it still.
    ServerRequestAnswerWriteFailed {
        /// The ask's method.
        method: String,
        /// The write's failure.
        error: DiagnosticCause,
    },
    /// A notification to the service could not be sent.
    NotificationWriteFailed {
        /// The notification's method.
        method: String,
        /// The write's failure.
        error: DiagnosticCause,
    },
    /// The connection to a service closed while its process still ran, or on the person's own.
    ServiceConnectionDropped {
        /// The service's Codex home.
        codex_home: PathBuf,
        /// How the connection closed, in words.
        reason: String,
    },
    /// A restart or reconnect of a service failed.
    ServiceStartFailed {
        /// The service's Codex home.
        codex_home: PathBuf,
        /// The start's failure.
        error: DiagnosticCause,
    },
    /// A teardown step failed where the teardown carries on without it.
    TeardownStepFailed {
        /// The step that failed.
        step: CodexTeardownStep,
        /// Its failure.
        error: DiagnosticCause,
    },
    /// A conversation could not be resumed on its service after a restart, reconnect or move.
    ConversationResumeFailed {
        /// The conversation.
        thread_id: String,
        /// The resume's failure.
        error: DiagnosticCause,
    },
    /// The connection to a service that kept running came back, and its conversations resumed.
    ServiceReconnected {
        /// The service's Codex home.
        codex_home: PathBuf,
        /// Each conversation resumed.
        conversations: Vec<String>,
    },
    /// A conversation moving to a new build stayed loaded on its old service past the deadline,
    /// held by another client, so its resume on the new build went ahead.
    ConversationUnloadTimedOut {
        /// The conversation.
        thread_id: String,
    },
    /// `thread/read` could not confirm a conversation unloaded; its resume decides.
    ConversationUnloadUnconfirmed {
        /// The conversation.
        thread_id: String,
        /// The read's failure.
        error: DiagnosticCause,
    },
    /// The fork that moves an idle conversation onto the session's config failed; the session's
    /// next turn forks again before it starts.
    ConversationForkFailed {
        /// The conversation.
        thread_id: String,
        /// The fork's failure.
        error: DiagnosticCause,
    },
    /// Codex reported a conversation running under a profile the daemon never asked for, or
    /// none; the daemon asked for the session's own again.
    PermissionProfileDrifted {
        /// The conversation.
        thread_id: String,
        /// The profile Codex reported, `none` when it named none.
        active_profile: String,
        /// The profile the session runs under.
        expected_profile: String,
    },
    /// The ask that sets a drifted conversation back to the session's profile failed.
    PermissionProfileRestoreFailed {
        /// The conversation.
        thread_id: String,
        /// The ask's failure.
        error: DiagnosticCause,
    },
    /// An item's final text does not continue the pieces already streamed for it; those pieces
    /// stand and nothing more of it is written.
    StreamedTextDiverged {
        /// The account the service runs on; `None` on the machine's default home.
        provider_account_id: Option<ProviderAccountId>,
        /// The conversation.
        thread_id: String,
        /// The item.
        item_id: String,
    },
    /// The messages a continue waited to steer in could not be delivered once its pause failed.
    ContinueSteerFailed {
        /// The conversation.
        thread_id: String,
        /// The steer's failure.
        error: DiagnosticCause,
    },
    /// A pause's interrupt at the step boundary failed, so the turn runs on and no pause lands.
    PauseInterruptFailed {
        /// The conversation.
        thread_id: String,
        /// The interrupt's failure.
        error: DiagnosticCause,
    },
    /// The account read that classifies a failed resume failed, so the resume needs recovery.
    ResumeAuthClassificationFailed {
        /// The read's failure.
        error: DiagnosticCause,
    },
    /// A `thread/fork` reply's turn list did not bear the fork out (an absent list reads as
    /// zero); reported, not fatal.
    ForkTurnLedgerUnconfirmed {
        /// The turns the fork should hold.
        expected_turn_count: usize,
        /// The turns the reply listed.
        confirmed_turn_count: usize,
    },
    /// A helper definition's field its role file cannot carry; the helper runs without it.
    SubagentDefinitionFieldWithheld {
        /// The account the service runs on; `None` on the machine's default home.
        provider_account_id: Option<ProviderAccountId>,
        /// The helper's name.
        definition_name: String,
        /// The field withheld.
        field: CodexRoleFileWithheldField,
    },
    /// The session owed terminals to more interrupted runs than it remembers, so its
    /// conversation was ended rather than lose one silently.
    InterruptedRouteMemoryOverflowed {
        /// The interrupted turns it remembered.
        retained_turn_count: usize,
    },
    /// A port the daemon wired refused what the driver handed it.
    PortDeliveryFailed {
        /// The account the service runs on; `None` on the machine's default home.
        provider_account_id: Option<ProviderAccountId>,
        /// The port.
        port: CodexDeliveryPort,
        /// The session the delivery was for; `None` where it belongs to no one session.
        session_id: Option<SessionId>,
        /// The port's failure.
        error: DiagnosticCause,
    },
    /// The run engine refused or failed a delivery.
    DeliveryDispatchFailed {
        /// The account the service runs on; `None` on the machine's default home.
        provider_account_id: Option<ProviderAccountId>,
        /// The provider frame the delivery came from; `None` for the driver's own.
        method: Option<String>,
        /// The delivery's kind.
        delivery_kind: String,
        /// The session the delivery was for.
        session_id: SessionId,
        /// The dispatch's failure.
        error: DiagnosticCause,
    },
    /// A session's command list could not be read for a listener following it.
    ProviderCommandListFailed {
        /// The session.
        session_id: SessionId,
        /// The read's failure.
        error: DiagnosticCause,
    },
    /// A side question's throwaway turn ended without an answer.
    SideQuestionUnanswered {
        /// The session.
        session_id: SessionId,
        /// Why no answer came.
        error: DiagnosticCause,
    },
    /// A frame the driver reads only into the service log, by its method.
    ProviderNoticeLogged {
        /// The frame's method.
        method: String,
        /// The session it came on.
        session_id: SessionId,
    },
    /// A frame whose run no live route, interrupt or starting turn names, so nothing is written.
    UnattributedTurnFrame {
        /// The frame's method.
        method: String,
        /// The turn it named, or `None` when it named none.
        turn_id: Option<String>,
    },
    /// A turn too long for the model's window that could not be cut out of the conversation.
    OversizedTurnCutFailed {
        /// The session.
        session_id: SessionId,
        /// The cut's failure.
        error: DiagnosticCause,
    },
    /// The run of a turn Codex started by itself could not open; the turn's frames go unheld.
    ProviderTurnRunFailed {
        /// The session.
        session_id: SessionId,
        /// The open's failure.
        error: DiagnosticCause,
    },
    /// The interrupt of a turn Codex started whose run could not open failed; the turn runs on.
    ProviderTurnInterruptFailed {
        /// The session.
        session_id: SessionId,
        /// The interrupt's failure.
        error: DiagnosticCause,
    },
    /// The frames held while a turn Codex started opens its run went on before the run opened.
    ProviderTurnFramesReleased {
        /// The session.
        session_id: SessionId,
        /// Why they went on.
        reason: CodexHeldFramesReleaseReason,
        /// How many frames went on.
        frame_count: usize,
    },
    /// A hook input the daemon could not read or answer; a pre-tool one was denied.
    HookAnswerFailed {
        /// The failure.
        error: DiagnosticCause,
    },
}

impl CodexTransportDiagnostic {
    /// Logs the diagnostic as one line on the service log, a failure with every cause; one the
    /// shared driver diagnostics name goes through them, with its counter.
    pub(crate) fn report(&self) {
        match self {
            Self::UnparsableMessage {
                reason,
                character_count,
            } => tracing::warn!(
                reason = <&str>::from(*reason),
                character_count,
                "A message from the Codex service is no JSON-RPC message"
            ),
            Self::UnknownResponseId { response_id } => tracing::warn!(
                response_id = response_id.as_str(),
                "A Codex response named a request nothing waits on"
            ),
            Self::UnhandledServerRequest {
                method,
                is_in_protocol,
            } => tracing::warn!(
                method = method.as_str(),
                is_in_protocol,
                "A request from the Codex service that nothing handles was refused"
            ),
            Self::UnroutedServerRequestRefused { method } => tracing::warn!(
                method = method.as_str(),
                "A request from the Codex service reached no session and was refused"
            ),
            Self::ServerRequestResponderFailed { method, error } => tracing::warn!(
                method = method.as_str(),
                error = &**error as &(dyn Error + 'static),
                "The answer to a request from the Codex service failed"
            ),
            Self::RoutedAskTurnUnresolved {
                method,
                turn_id,
                is_turn_id_cut,
            } => tracing::warn!(
                method = method.as_str(),
                turn_id = turn_id.as_deref(),
                is_turn_id_cut,
                "A Codex ask named a turn with no live run and was refused"
            ),
            Self::RoutedAskThreadUnresolved { method, thread_id } => tracing::warn!(
                method = method.as_str(),
                thread_id = thread_id.as_deref(),
                "A Codex ask named no conversation a session holds and was refused"
            ),
            Self::ServerRequestAnswerOversized {
                method,
                encoded_bytes,
                limit,
            } => tracing::warn!(
                method = method.as_str(),
                encoded_bytes,
                limit,
                "An answer to a Codex ask was larger than the service takes and was refused"
            ),
            Self::ServerRequestAnswerWriteFailed { method, error } => tracing::warn!(
                method = method.as_str(),
                error = &**error as &(dyn Error + 'static),
                "The answer to a Codex ask could not be sent"
            ),
            Self::NotificationWriteFailed { method, error } => tracing::warn!(
                method = method.as_str(),
                error = &**error as &(dyn Error + 'static),
                "A notification to the Codex service could not be sent"
            ),
            Self::ServiceConnectionDropped { codex_home, reason } => tracing::warn!(
                codex_home = %codex_home.display(),
                reason = reason.as_str(),
                "The connection to a Codex service closed"
            ),
            Self::ServiceStartFailed { codex_home, error } => tracing::warn!(
                codex_home = %codex_home.display(),
                error = &**error as &(dyn Error + 'static),
                "A Codex service could not be started or reached again"
            ),
            Self::TeardownStepFailed { step, error } => tracing::warn!(
                step = <&str>::from(*step),
                error = &**error as &(dyn Error + 'static),
                "A Codex teardown step failed; the teardown went on"
            ),
            Self::ConversationResumeFailed { thread_id, error } => tracing::warn!(
                thread_id = thread_id.as_str(),
                error = &**error as &(dyn Error + 'static),
                "A Codex conversation could not be resumed"
            ),
            Self::ServiceReconnected {
                codex_home,
                conversations,
            } => tracing::info!(
                codex_home = %codex_home.display(),
                conversations = ?conversations,
                "The connection to a Codex service came back and its conversations resumed"
            ),
            Self::ConversationUnloadTimedOut { thread_id } => tracing::warn!(
                thread_id = thread_id.as_str(),
                "A Codex conversation stayed loaded on its old service; its resume went ahead"
            ),
            Self::ConversationUnloadUnconfirmed { thread_id, error } => tracing::warn!(
                thread_id = thread_id.as_str(),
                error = &**error as &(dyn Error + 'static),
                "A Codex conversation's unload could not be confirmed; its resume decides"
            ),
            Self::ConversationForkFailed { thread_id, error } => tracing::warn!(
                thread_id = thread_id.as_str(),
                error = &**error as &(dyn Error + 'static),
                "A Codex conversation's fork onto the session's config failed"
            ),
            Self::PermissionProfileDrifted {
                thread_id,
                active_profile,
                expected_profile,
            } => tracing::warn!(
                thread_id = thread_id.as_str(),
                active_profile = active_profile.as_str(),
                expected_profile = expected_profile.as_str(),
                "A Codex conversation ran under a profile the daemon never asked for"
            ),
            Self::PermissionProfileRestoreFailed { thread_id, error } => tracing::warn!(
                thread_id = thread_id.as_str(),
                error = &**error as &(dyn Error + 'static),
                "A Codex conversation's profile could not be set back"
            ),
            Self::StreamedTextDiverged {
                provider_account_id,
                thread_id,
                item_id,
            } => emit_shared(
                DriverDiagnosticKind::StreamedTextDiverged,
                provider_account_id.as_ref(),
                None,
                "the item's final text does not continue its streamed pieces, which stand",
                [("threadId", json!(thread_id)), ("itemId", json!(item_id))],
            ),
            Self::ContinueSteerFailed { thread_id, error } => tracing::warn!(
                thread_id = thread_id.as_str(),
                error = &**error as &(dyn Error + 'static),
                "The messages a Codex continue waited to steer in could not be delivered"
            ),
            Self::PauseInterruptFailed { thread_id, error } => tracing::warn!(
                thread_id = thread_id.as_str(),
                error = &**error as &(dyn Error + 'static),
                "A Codex pause's interrupt failed; the turn runs on"
            ),
            Self::ResumeAuthClassificationFailed { error } => tracing::warn!(
                error = &**error as &(dyn Error + 'static),
                "The account read for a failed Codex resume failed; the resume needs recovery"
            ),
            Self::ForkTurnLedgerUnconfirmed {
                expected_turn_count,
                confirmed_turn_count,
            } => tracing::warn!(
                expected_turn_count,
                confirmed_turn_count,
                "A Codex fork's turn list did not bear the fork out"
            ),
            Self::SubagentDefinitionFieldWithheld {
                provider_account_id,
                definition_name,
                field,
            } => emit_shared(
                DriverDiagnosticKind::SubagentDefinitionFieldWithheld,
                provider_account_id.as_ref(),
                None,
                "a Codex role file has no place for the field, so the helper runs without it",
                [
                    ("definitionName", json!(definition_name)),
                    ("field", json!(field.as_str())),
                ],
            ),
            Self::InterruptedRouteMemoryOverflowed {
                retained_turn_count,
            } => tracing::warn!(
                retained_turn_count,
                "A Codex session owed terminals to more interrupted runs than it remembers"
            ),
            Self::PortDeliveryFailed {
                provider_account_id,
                port,
                session_id,
                error,
            } => emit_shared(
                DriverDiagnosticKind::DeliveryDispatchFailed,
                provider_account_id.as_ref(),
                None,
                "a port the daemon wired refused what the Codex driver handed it",
                [
                    ("port", json!(<&str>::from(*port))),
                    (
                        "sessionId",
                        json!(session_id.as_ref().map(ToString::to_string)),
                    ),
                    ("detail", json!(describe_error(&**error))),
                ],
            ),
            Self::DeliveryDispatchFailed {
                provider_account_id,
                method,
                delivery_kind,
                session_id,
                error,
            } => emit_shared(
                DriverDiagnosticKind::DeliveryDispatchFailed,
                provider_account_id.as_ref(),
                method.as_deref(),
                "the run engine refused or failed a Codex delivery",
                [
                    ("deliveryKind", json!(delivery_kind)),
                    ("sessionId", json!(session_id.to_string())),
                    ("detail", json!(describe_error(&**error))),
                ],
            ),
            Self::ProviderCommandListFailed { session_id, error } => tracing::warn!(
                session_id = %session_id,
                error = &**error as &(dyn Error + 'static),
                "A Codex session's command list could not be read"
            ),
            Self::SideQuestionUnanswered { session_id, error } => tracing::warn!(
                session_id = %session_id,
                error = &**error as &(dyn Error + 'static),
                "A Codex side question ended without an answer"
            ),
            Self::ProviderNoticeLogged { method, session_id } => tracing::info!(
                method = method.as_str(),
                session_id = %session_id,
                "A Codex notice the service log keeps"
            ),
            Self::UnattributedTurnFrame { method, turn_id } => tracing::warn!(
                method = method.as_str(),
                turn_id = turn_id.as_deref(),
                "A Codex turn frame named no run, so nothing was written"
            ),
            Self::OversizedTurnCutFailed { session_id, error } => tracing::warn!(
                session_id = %session_id,
                error = &**error as &(dyn Error + 'static),
                "A Codex turn too long for the model's window could not be cut out"
            ),
            Self::ProviderTurnRunFailed { session_id, error } => tracing::warn!(
                session_id = %session_id,
                error = &**error as &(dyn Error + 'static),
                "The run of a turn Codex started could not open"
            ),
            Self::ProviderTurnInterruptFailed { session_id, error } => tracing::warn!(
                session_id = %session_id,
                error = &**error as &(dyn Error + 'static),
                "The interrupt of a turn Codex started failed; the turn runs on"
            ),
            Self::ProviderTurnFramesReleased {
                session_id,
                reason,
                frame_count,
            } => tracing::warn!(
                session_id = %session_id,
                reason = <&str>::from(*reason),
                frame_count,
                "The frames of a turn Codex started went on before its run opened"
            ),
            Self::HookAnswerFailed { error } => tracing::warn!(
                error = &**error as &(dyn Error + 'static),
                "A Codex hook input could not be read or answered"
            ),
        }
    }
}

// Logs one fact the shared driver diagnostics name, as Codex's, with its counter.
fn emit_shared<const DETAILS: usize>(
    kind: DriverDiagnosticKind,
    provider_account_id: Option<&ProviderAccountId>,
    raw_wire_type: Option<&str>,
    disposition_reason: &str,
    details: [(&str, Value); DETAILS],
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: provider_account_id.cloned(),
        kind,
        raw_wire_type: raw_wire_type.map(str::to_owned),
        disposition_reason: disposition_reason.to_owned(),
        details: details
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect::<Map<String, Value>>(),
    });
}
