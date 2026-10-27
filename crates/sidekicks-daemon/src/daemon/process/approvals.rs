//! The daemon's approval side, built once beside the run engine: the approval service, the hold an
//! open ask puts on its run, the gate that lets go of a run's asks at its end, the permission check
//! every sensitive action passes, the provider asks, the rules the providers keep, the reviewer's
//! blocks and this machine's registrations. Its follows of the log begin once the start's recovery
//! pass has settled the runs.

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use futures::FutureExt as _;

use crate::daemon::process::stop::TaskStopFailure;
use sidekicks_approval::permission_asks::{PermissionAsks, PermissionAsksDeps};
use sidekicks_approval::permission_check::{PermissionCheck, PermissionCheckDeps};
use sidekicks_approval::reviewer_denials::ReviewerDenials;
use sidekicks_approval::rules::session_end::SessionRuleEnding;
use sidekicks_approval::rules::{ApprovalRules, RevokeAtProvider};
use sidekicks_approval::run_blocking::{ApprovalRunEnd, ApprovalRunHolds, RunHoldFollowing};
use sidekicks_approval::service::ApprovalService;
use sidekicks_approval::service::session_sweep::ApprovalSweep;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::background_work::BackgroundWorkForms;
use sidekicks_provider::driver::contract::DriverError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_session::run::engine::RunEngine;
use sidekicks_store::data_folder::agent_memory_folder;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use sidekicks_store::machine::local::LocalMachine;
use sidekicks_store::machine::registry::MachineRegistry;
use sidekicks_workspace::git::worktree::watch::WorkingFolderWatcher;

/// What the approval side is built from.
pub(crate) struct ApprovalStart {
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's one writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The appender every approval event goes through.
    pub(crate) events: Arc<SessionEventAppender>,
    /// The working folders an answer marks stale.
    pub(crate) working_folders: Arc<WorkingFolderWatcher>,
    /// The registered drivers, which answer their providers' asks and keep their rules.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// This machine, whose providers keep the rules made here and whose owner every check
    /// decides as.
    pub(crate) machine: LocalMachine,
    /// The one bound on shell-line reads.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// Every provider's background work, which the permission check refuses.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// Each live run's posture.
    pub(crate) postures: Arc<ExecutionPostureService>,
    /// The workflow actions' rules, loaded and checked at the start.
    pub(crate) authorizer: Arc<Authorizer>,
    /// The daemon's data folder, which holds the agent-memory folder.
    pub(crate) data_folder: PathBuf,
    /// Where each damaged session's log stops being readable, for a session's driver read.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// The approval side, each part built once and shared by `Arc`.
#[expect(dead_code, reason = "the daemon's driver ports and method tables")]
pub(crate) struct Approvals {
    /// Raises, answers and cancels approval cards.
    pub(crate) service: Arc<ApprovalService>,
    /// Holds each run with an open ask.
    pub(crate) run_holds: Arc<ApprovalRunHolds>,
    /// The setup gate that lets go of a run's asks at its end.
    pub(crate) run_end: Arc<ApprovalRunEnd>,
    /// The gate every sensitive action passes.
    pub(crate) check: Arc<PermissionCheck>,
    /// The provider asks, the permission-ask port.
    pub(crate) asks: Arc<PermissionAsks>,
    /// The rules the providers keep, the session-rules port.
    pub(crate) rules: Arc<ApprovalRules>,
    /// The reviewer's blocks, the reviewer-denials port.
    pub(crate) denials: Arc<ReviewerDenials>,
    /// This machine's registrations and the owner they leave it.
    pub(crate) machines: Arc<MachineRegistry>,
}

/// Builds the approval side over `deps`, its run holds reaching `engine`, which the run engine's
/// own build hands it before the engine exists.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) fn build_approvals(engine: Weak<RunEngine>, deps: &ApprovalStart) -> Approvals {
    let run_holds = Arc::new(ApprovalRunHolds::new(engine, Arc::clone(&deps.reads)));
    let service = Arc::new(ApprovalService::new(
        Arc::clone(&deps.reads),
        Arc::clone(&deps.events),
        Arc::clone(&deps.writer),
        Arc::clone(&deps.working_folders),
        Arc::clone(&run_holds),
    ));
    let rules = Arc::new(ApprovalRules::new(
        Arc::clone(&deps.reads),
        Arc::clone(&deps.events),
        deps.machine.machine_id.clone(),
        revoke_at_session_provider(
            Arc::clone(&deps.reads),
            Arc::clone(&deps.providers),
            Arc::clone(&deps.read_damaged_from_sequence),
        ),
        Arc::clone(&deps.shell_lines),
    ));
    let machines = Arc::new(MachineRegistry::new(
        Arc::clone(&deps.reads),
        Arc::clone(&deps.writer),
        deps.machine.clone(),
    ));
    let check = Arc::new(PermissionCheck::new(PermissionCheckDeps {
        reads: Arc::clone(&deps.reads),
        approvals: Arc::clone(&service),
        rules: Arc::clone(&rules),
        shell_lines: Arc::clone(&deps.shell_lines),
        background_work: Arc::clone(&deps.background_work),
        postures: Arc::clone(&deps.postures),
        machine: Arc::clone(&machines),
        authorizer: Arc::clone(&deps.authorizer),
        agent_memory_folder: agent_memory_folder(&deps.data_folder),
    }));
    let asks = Arc::new(PermissionAsks::new(PermissionAsksDeps {
        reads: Arc::clone(&deps.reads),
        approvals: Arc::clone(&service),
        check: Arc::clone(&check),
        rules: Arc::clone(&rules),
        providers: Arc::clone(&deps.providers),
    }));
    let run_end = Arc::new(ApprovalRunEnd::new(Arc::clone(&service), Arc::clone(&asks)));
    let denials = Arc::new(ReviewerDenials::new(
        Arc::clone(&deps.reads),
        Arc::clone(&deps.events),
        Arc::clone(&deps.providers),
    ));
    Approvals {
        service,
        run_holds,
        run_end,
        check,
        asks,
        rules,
        denials,
        machines,
    }
}

// Why the driver of a session whose rule is revoked could not be read.
#[derive(Debug, thiserror::Error)]
enum SessionDriverReadError {
    // `session.notFound` or `provider.notFound`.
    #[error(transparent)]
    Refused(#[from] DomainError),
    // The read did not reach the database.
    #[error("the session's provider could not be read")]
    Pool(#[from] DatabaseReadError),
    // SQLite refused the read.
    #[error("the session's provider could not be read")]
    Database(#[from] rusqlite::Error),
}

// Takes a revoked rule out of force at the provider the session's lead runs on, read through
// `reads` and found in `providers`, through its driver; a refusal of the read is the driver's
// refusal, any other failure its own.
fn revoke_at_session_provider(
    reads: Arc<DatabaseReadPool>,
    providers: Arc<ProviderRegistry>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
) -> RevokeAtProvider {
    Box::new(move |params| {
        let reads = Arc::clone(&reads);
        let providers = Arc::clone(&providers);
        let read_damaged_from_sequence = Arc::clone(&read_damaged_from_sequence);
        async move {
            let (_provider, _account, driver) = read_session_driver::<SessionDriverReadError>(
                &reads,
                &providers,
                &*read_damaged_from_sequence,
                params.session_id,
            )
            .await
            .map_err(|error| match error {
                SessionDriverReadError::Refused(refusal) => DriverError::Refused(refusal),
                other @ (SessionDriverReadError::Pool(_) | SessionDriverReadError::Database(_)) => {
                    DriverError::Internal(Box::new(other))
                }
            })?;
            driver.revoke_rule(params).await
        }
        .boxed()
    })
}

/// The approval side's follows of the log, held for the stop.
pub(crate) struct ApprovalAttachments {
    // The reviewer's blocks' wakes, stopped first so no block waits on a stopped follow.
    denials: FollowerAttachment,
    sweep: ApprovalSweep,
    rule_ending: SessionRuleEnding,
    run_holds: RunHoldFollowing,
}

/// Starts the approval side's follows of `followers`: the closed sessions' sweep and rule ends,
/// the holds of each run that runs again with an ask open, and the reviewer's blocks' wakes. Called
/// once the start's recovery pass has settled the runs, inside the daemon's runtime.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) fn start_approval_attachments(
    approvals: &Approvals,
    followers: &Arc<SessionEventFollowers>,
) -> ApprovalAttachments {
    ApprovalAttachments {
        denials: approvals.denials.start(followers),
        sweep: approvals.service.start(followers),
        rule_ending: approvals.rules.start(followers),
        run_holds: approvals.run_holds.start(followers),
    }
}

impl ApprovalAttachments {
    /// Stops every follow, the reviewer's blocks' first, and waits for the work under way; answers
    /// each follower whose task ended abnormally, every one having stopped.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's stop"))]
    pub(crate) async fn stop(self, approvals: &Approvals) -> Vec<TaskStopFailure> {
        let Self {
            denials,
            sweep,
            rule_ending,
            run_holds,
        } = self;
        approvals.denials.stop(denials);
        let (sweep, rule_ending, run_holds) =
            tokio::join!(sweep.stop(), rule_ending.stop(), run_holds.stop());
        [
            ("approval sweep", sweep),
            ("session rules' end", rule_ending),
            ("approval run holds", run_holds),
        ]
        .into_iter()
        .filter_map(|(task, stopped)| stopped.err().map(|error| TaskStopFailure { task, error }))
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::id::SessionId;

    use super::revoke_at_session_provider;
    use crate::remote::shared_ports::schema::schema_parts;
    use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
    use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver};
    use sidekicks_provider::driver::session_control::RevokeRuleParams;
    use sidekicks_provider::driver::test_registry::registry_of_first_provider;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_log::open_log;
    use sidekicks_store::events::session::read::DamagedFromSequenceReader;

    // Killed by mapping the read's refusal to an internal failure, which the person would read as
    // a fault instead of the session being gone.
    #[tokio::test]
    async fn a_revoke_for_a_session_with_no_lead_is_refused_session_not_found() {
        let database = TestDatabase::new(schema_parts());
        let _log = open_log(&database, None).await;
        let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> =
            Arc::new(|_: &SessionId| None::<i64>);
        let revoke = revoke_at_session_provider(
            Arc::new(DatabaseReadPool::new(database.path(), 8)),
            Arc::new(registry_of_first_provider(Arc::new(
                MockProviderDriver::new(),
            ))),
            read_damaged_from_sequence,
        );

        let revoked = revoke(RevokeRuleParams {
            session_id: test_session_id(),
            rule: ProviderAskRule {
                kind: RememberedScopeKind::Project,
                sense: RememberedRuleSense::Allow,
                action: ProviderAskActionKind::Command,
                subject: "git status".to_owned(),
            },
            project_folder: None,
        })
        .await;

        assert!(
            matches!(
                &revoked,
                Err(DriverError::Refused(refusal)) if refusal.code == RefusalCode::SessionNotFound
            ),
            "{revoked:?}"
        );
    }
}
