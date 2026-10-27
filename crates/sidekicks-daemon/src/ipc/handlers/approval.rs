//! The `approval.*` methods a client calls: a card's answer, from the calling device; the
//! session's asks; the rules in force on a session and the revoke of one; and `Allow once` on a
//! block by the provider's own reviewer.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::approval::{
    ApprovalDenialOverride, ApprovalList, ApprovalListRequest, ApprovalListResponse,
    ApprovalResolve, ApprovalRuleList, ApprovalRuleRevoke,
};
use sidekicks_contracts::method::Method as _;

use sidekicks_approval::permission_asks::PermissionAsks;
use sidekicks_approval::projection::read::{ApprovalProjectionReadError, read_approval_projection};
use sidekicks_approval::reviewer_denials::ReviewerDenials;
use sidekicks_approval::rules::ApprovalRules;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_session::directory::lookups::session_exists;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

#[cfg(test)]
mod tests;

/// The statements `approval.list` prepares on a read connection: whether the session exists, and
/// its asks.
pub(crate) const APPROVAL_METHODS_STATEMENT_CAPACITY: usize = 2;

/// What the approval methods read and act through.
pub(crate) struct ApprovalMethodSources {
    /// The read pool the session's asks are read from.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Records a card's answer and carries it back to whoever holds the call.
    pub(crate) permission_asks: Arc<PermissionAsks>,
    /// Lists and revokes the rules in force.
    pub(crate) rules: Arc<ApprovalRules>,
    /// Allows a reviewer's block once.
    pub(crate) reviewer_denials: Arc<ReviewerDenials>,
}

/// A read of the session's asks did not run: a fault in the daemon.
#[derive(Debug, thiserror::Error)]
enum ApprovalListReadError {
    /// SQLite refused the session's read.
    #[error("the session of an approval list could not be read")]
    Read(#[from] rusqlite::Error),
    /// The asks could not be read, or a stored ask does not read as one.
    #[error(transparent)]
    Projection(#[from] ApprovalProjectionReadError),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<ApprovalListReadError> for HandlerError {
    fn from(error: ApprovalListReadError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Registers `approval.resolve`, `approval.list`, `approval.rule.list`, `approval.rule.revoke` and
/// `approval.denial.override` over `sources`. An answer with no calling device is a fault in the
/// daemon, answered as an internal error. Fails the start when one is already registered.
pub(crate) fn register_approval_methods(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ApprovalMethodSources>,
) -> Result<(), RegistrationError> {
    let resolve_sources = Arc::clone(sources);
    registry.register::<ApprovalResolve, _>(move |request, context: HandlerContext| {
        let sources = Arc::clone(&resolve_sources);
        async move {
            let device_id = context.calling_device(ApprovalResolve::DESCRIPTOR.method)?;
            Ok(sources.permission_asks.resolve(&request, device_id).await?)
        }
        .boxed()
    })?;
    let list_sources = Arc::clone(sources);
    registry.register::<ApprovalList, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&list_sources);
        async move { list_approvals(&sources.pool, request).await }.boxed()
    })?;
    let rule_list_sources = Arc::clone(sources);
    registry.register::<ApprovalRuleList, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&rule_list_sources);
        async move { Ok(sources.rules.list(request.session_id).await?) }.boxed()
    })?;
    let revoke_sources = Arc::clone(sources);
    registry.register::<ApprovalRuleRevoke, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&revoke_sources);
        async move { Ok(sources.rules.revoke(request.rule_id).await?) }.boxed()
    })?;
    let override_sources = Arc::clone(sources);
    registry.register::<ApprovalDenialOverride, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&override_sources);
        async move { Ok(sources.reviewer_denials.override_denial(&request).await?) }.boxed()
    })
}

// The session's asks, read with the session's existence in one read, so a session the daemon does
// not hold is refused rather than answered with no asks.
async fn list_approvals(
    pool: &DatabaseReadPool,
    request: ApprovalListRequest,
) -> Result<ApprovalListResponse, HandlerError> {
    let session_id = request.session_id;
    let listed = pool
        .read(
            ReadLength::Short,
            move |reader| -> Result<_, ApprovalListReadError> {
                if !session_exists(reader, &request.session_id)? {
                    return Ok(None);
                }
                Ok(Some(read_approval_projection(reader, &request)?))
            },
        )
        .await?;
    listed.ok_or_else(|| session_not_found(&session_id).into())
}
