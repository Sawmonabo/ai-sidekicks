//! How a driver reports a session it moved onto another account with no switch waiting on the
//! move, as a session left behind by a refused switch, attached to a service that carried no
//! account, or not named by the switch that moved its service, so the daemon lands the move in the
//! session's log as it lands a switch's.

use futures::future::BoxFuture;
use sidekicks_contracts::trust_statement::DeviceId;

use crate::driver::contract::account::SessionAccountMove;

/// The record of a session moved onto another account with no switch to settle it, registered
/// through a `PortRegistration`.
pub trait SessionAccountMoveRecorder: Send + Sync {
    /// Lands `moved`'s session on the account its move names, its bindings moved there already, as
    /// a switch's move lands: by `actor`, the person whose switch moved it, or this machine's own
    /// device where `None`, with its level and its first request's hand-back. The landing runs on
    /// a task of its own, so a driver may report from inside its own session's task; it never
    /// fails back into the driver, which has nothing to undo.
    fn record_account_moved(
        &self,
        moved: SessionAccountMove,
        actor: Option<DeviceId>,
    ) -> BoxFuture<'_, ()>;
}
