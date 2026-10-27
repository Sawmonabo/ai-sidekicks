//! The session projections the daemon rebuilds from each session's log, in the order a rebuild
//! clears and writes them.

use sidekicks_approval::projection::rebuild::ApprovalsProjection;
use sidekicks_artifact::plans::projection::PlansProjection;
use sidekicks_session::directory::projection::SessionDirectoryProjection;
use sidekicks_session::questions::projection::QuestionsProjection;
use sidekicks_session::run::projection::RunsProjection;
use sidekicks_store::events::projection::SessionProjection;

/// Every session projection the daemon keeps, as the projection rebuild takes them: the session's
/// directory row first, which the others' rows refer to, then its runs, approvals, questions and
/// plans.
#[expect(
    dead_code,
    reason = "the daemon's start, which hands them to the projection rebuild"
)]
pub(crate) fn rebuild_projections() -> Vec<Box<dyn SessionProjection>> {
    vec![
        Box::new(SessionDirectoryProjection),
        Box::new(RunsProjection),
        Box::new(ApprovalsProjection),
        Box::new(QuestionsProjection),
        Box::new(PlansProjection),
    ]
}
