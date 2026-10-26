//! The session projections the daemon rebuilds from each session's log, in the order a rebuild
//! clears and writes them.

use crate::approvals::projection::rebuild::ApprovalsProjection;
use crate::plans::projection::PlansProjection;
use crate::questions::projection::QuestionsProjection;
use crate::recovery::projection_rebuild::SessionProjection;
use crate::session::directory::projection::SessionDirectoryProjection;
use crate::session::run::projection::RunsProjection;

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
