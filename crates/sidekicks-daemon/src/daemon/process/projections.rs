//! The session projections the daemon rebuilds from each session's log, in the order a rebuild
//! clears and writes them.

use sidekicks_approval::projection::rebuild::ApprovalsProjection;
use sidekicks_artifact::plans::projection::PlansProjection;
use sidekicks_provider::account::observer::window_store::UsageWindowsProjection;
use sidekicks_provider::account::usage_turns::UsageTurnsProjection;
use sidekicks_session::agent_tree::projection::AgentTreeProjection;
use sidekicks_session::agents::projection::AgentsProjection;
use sidekicks_session::attention::rebuild::AttentionEntriesProjection;
use sidekicks_session::directory::projection::SessionDirectoryProjection;
use sidekicks_session::questions::projection::QuestionsProjection;
use sidekicks_session::run::projection::RunsProjection;
use sidekicks_store::events::projection::SessionProjection;
use sidekicks_workflow::runs::projection::WorkflowRunsProjection;

/// Every session projection the daemon keeps, as the projection rebuild takes them: the session's
/// directory row first, which the others' rows refer to, then its runs, then its agents and its
/// agent tree, whose bindings and nodes name its runs, then its approvals, questions and plans,
/// then its workflow runs and their steps, then its attention entries, which read whether a run is
/// a lead run from its runs' rows, then the provider accounts' metered turns and quota windows.
pub(crate) fn rebuild_projections() -> Vec<Box<dyn SessionProjection>> {
    vec![
        Box::new(SessionDirectoryProjection),
        Box::new(RunsProjection),
        Box::new(AgentsProjection),
        Box::new(AgentTreeProjection),
        Box::new(ApprovalsProjection),
        Box::new(QuestionsProjection),
        Box::new(PlansProjection),
        Box::new(WorkflowRunsProjection),
        Box::new(AttentionEntriesProjection),
        Box::new(UsageTurnsProjection),
        Box::new(UsageWindowsProjection),
    ]
}
