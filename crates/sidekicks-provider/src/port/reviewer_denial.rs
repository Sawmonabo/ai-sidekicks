//! Where a driver hands a block the provider's own reviewer made at Reviewed, so the approval
//! pipeline records it once and can later allow it once through the driver's `override_denial`.

use std::error::Error;

use futures::future::BoxFuture;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

/// One action the provider's reviewer blocked: the tool call it blocked (absent for an action that
/// is no call, such as a network request), the reviewer's reason (absent where it gave none),
/// whether the provider lets it be allowed once, and the provider's own record of the block, kept
/// verbatim so `override_denial` hands it back unchanged.
#[derive(Debug)]
pub struct ProviderReviewerDenial {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The blocked tool call; `None` for a block that names no call, recorded as a row of its own.
    pub tool_call_id: Option<String>,
    /// The reviewer's reason.
    pub reason: Option<String>,
    /// Whether the provider lets the block be allowed once.
    pub is_overridable: bool,
    /// The provider's own record of the block, relayed and stored as received.
    pub provider_denial: Box<RawValue>,
}

/// The approval pipeline's intake of reviewer blocks, registered through a `PortRegistration`.
/// Until it is registered, a block stays the provider's own: the agent is told why and nothing is
/// recorded.
pub trait ReviewerDenialPort: Send + Sync {
    /// Records `denial`, waiting for the blocked call's row when the block arrives first; a block
    /// that names no call is recorded at once. An error when it could not be recorded.
    fn take_denial(
        &self,
        denial: ProviderReviewerDenial,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// The provider process behind `binding_id` has ended, so an `Allow once` pressed on one of its
    /// blocks and held, or still waiting on its answer, may be pressed again.
    fn release_held_presses(&self, binding_id: &RuntimeBindingId);
}
