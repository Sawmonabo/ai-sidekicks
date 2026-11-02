//! How a driver reports a session it moved onto another account with no switch waiting on the
//! move, as a session left behind by a refused switch or attached to a service that carried no
//! account is moved, so the daemon records the move in the session's log as it records a switch's.

use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;

/// The record of a session moved onto another account with no switch to settle it, registered
/// through a `PortRegistration`.
pub trait SessionAccountMoveRecorder: Send + Sync {
    /// Records that `session_id`'s lead now runs on `provider_account_id`'s account, its bindings
    /// moved there already. Answers once the record is written or its failure logged; it never
    /// fails back into the driver, which has nothing to undo.
    fn record_account_moved(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, ()>;
}
