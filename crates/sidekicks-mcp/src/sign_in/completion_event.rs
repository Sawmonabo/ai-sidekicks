//! The one `mcp.server.signIn.completed` a settled sign-in appends, on the daemon's sentinel
//! session, naming the binding by its provider, scope and server name and, for a failure, a reason
//! from the daemon's own fixed words: never the authorization server's text, an error's
//! description or an address.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the sign-in service whose settled attempts append it"
    )
)]

use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::mcp::governance::{
    McpServerSignInCompletedPayload, McpServerSignInOutcome,
};
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};

use crate::binding::store::McpBindingKey;

/// Why a settled sign-in failed, each in the daemon's own words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SignInFailureReason {
    /// The browser came back carrying the authorization server's error instead of a code.
    CallbackCarriedError,
    /// The authorization server did not exchange the code for tokens.
    CodeNotRedeemed,
    /// The tokens came back but the keychain did not keep them.
    SignInNotSaved,
    /// The code's exchange did not finish while the browser waited.
    DidNotFinishInTime,
}

impl SignInFailureReason {
    /// The reason as the event's `failureReason` carries it.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CallbackCarriedError => "The authorization server sent back an error.",
            Self::CodeNotRedeemed => "The authorization server did not accept the sign-in code.",
            Self::SignInNotSaved => "The sign-in could not be saved.",
            Self::DidNotFinishInTime => "The sign-in did not finish in time.",
        }
    }
}

/// Appends the one `mcp.server.signIn.completed` of `binding`'s sign-in: a success when `failure`
/// is `None`, else a failure carrying its reason. Fails with [`SessionEventEmitError`] when the
/// event is not drafted or not kept.
pub(crate) async fn append_sign_in_completed(
    appender: &SessionEventAppender,
    binding: &McpServerBindingRef,
    failure: Option<SignInFailureReason>,
) -> Result<(), SessionEventEmitError> {
    let key = McpBindingKey::of(binding);
    let payload = McpServerSignInCompletedPayload {
        provider: key.provider,
        scope: key.scope,
        server_name: key.server_name,
        outcome: if failure.is_some() {
            McpServerSignInOutcome::Failure
        } else {
            McpServerSignInOutcome::Success
        },
        failure_reason: failure.map(|reason| reason.as_str().to_owned()),
        initiating_session_id: None,
    };
    let draft = SessionEventDraft::of_session(
        *DAEMON_SCOPE_SENTINEL_SESSION_ID,
        &SessionEvent::McpServerSignInCompleted(payload),
    )?;
    appender
        .append(draft, SessionEventLinkage::default())
        .await?;
    Ok(())
}
