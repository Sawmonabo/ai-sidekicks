//! Where a driver reads the standing rules in force on a session, so what it hands its provider
//! (its flag settings, or the calls it holds) carries every rule the person made and none they
//! took back.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

use crate::policy::ask_rule::ProviderAskRule;
use crate::provider::port::permission_ask::ProviderAskAction;

/// The approval pipeline's read of the rules in force on a session, its own and its project's,
/// registered through a `PortRegistration`; until it is, a session holds none. A revoked rule is
/// one the session made and the person revoked since, which a provider that cannot drop a rule
/// itself must hold the next call on.
pub(crate) trait SessionRulePort: Send + Sync {
    /// The rules in force on `session_id`, oldest first. An error when they could not be read.
    fn read_session_rules(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Vec<ProviderAskRule>, Box<dyn Error + Send + Sync>>>;

    /// The revoked rule over `action`'s subject that no rule in force covers again, if any. An
    /// error when the rules could not be read.
    fn find_revoked_rule(
        &self,
        session_id: SessionId,
        action: ProviderAskAction,
    ) -> BoxFuture<'_, Result<Option<ProviderAskRule>, Box<dyn Error + Send + Sync>>>;
}
