//! The session projections the daemon rebuilds from each session's log, in the order a rebuild
//! clears and writes them.

use sidekicks_approval::projection::rebuild::ApprovalsProjection;
use sidekicks_artifact::plans::projection::PlansProjection;
use sidekicks_session::attention::rebuild::AttentionEntriesProjection;
use sidekicks_session::directory::projection::SessionDirectoryProjection;
use sidekicks_session::questions::projection::QuestionsProjection;
use sidekicks_session::run::projection::RunsProjection;
use sidekicks_store::events::projection::SessionProjection;

/// Every session projection the daemon keeps, as the projection rebuild takes them: the session's
/// directory row first, which the others' rows refer to, then its runs, approvals, questions and
/// plans, then its attention entries, which read whether a run is a lead run from its runs' rows.
pub(crate) fn rebuild_projections() -> Vec<Box<dyn SessionProjection>> {
    vec![
        Box::new(SessionDirectoryProjection),
        Box::new(RunsProjection),
        Box::new(ApprovalsProjection),
        Box::new(QuestionsProjection),
        Box::new(PlansProjection),
        Box::new(AttentionEntriesProjection),
    ]
}
