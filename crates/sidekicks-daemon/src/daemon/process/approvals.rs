//! The daemon's approval side, built once beside the run engine: the approval service, the hold an
//! open ask puts on its run, the gate that lets go of a run's asks at its end, the permission check
//! every sensitive action passes, the provider asks, the rules the providers keep, the reviewer's
//! blocks and this machine's registrations. Its follows of the log begin once the start's recovery
//! pass has settled the runs.

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use futures::FutureExt as _;
use tokio::task::JoinError;

use crate::approvals::permission_asks::{PermissionAsks, PermissionAsksDeps};
use crate::approvals::reviewer_denials::ReviewerDenials;
use crate::approvals::rules::session_end::SessionRuleEnding;
use crate::approvals::rules::{ApprovalRules, RevokeAtProvider};
use crate::approvals::run_blocking::{ApprovalRunEnd, ApprovalRunHolds, RunHoldFollowing};
use crate::approvals::service::ApprovalService;
use crate::approvals::service::session_sweep::ApprovalSweep;
use crate::daemon::machine::local::LocalMachine;
use crate::daemon::machine::registry::MachineRegistry;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool};
use crate::database::writer::DatabaseWriter;
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use crate::events::session::read::DamagedFromSequenceReader;
use crate::git::worktree::watch::WorkingFolderWatcher;
use crate::ipc::domain_error::DomainError;
use crate::ipc::handlers::driver::resolution::read_session_driver;
use crate::policy::authorizer::Authorizer;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::policy::permission_check::{PermissionCheck, PermissionCheckDeps};
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::run::engine::RunEngine;

// The one all-projects agent-memory folder's name in the data folder.
const AGENT_MEMORY_FOLDER_NAME: &str = "agent-memory";

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
#[expect(
    dead_code,
    reason = "the daemon's driver ports and method tables, which the composition wires"
)]
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
#[expect(dead_code, reason = "the daemon's start, which the composition wires")]
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
        revoke_at_session_provider(deps),
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
        postures: Arc::clone(&deps.postures),
        machine: Arc::clone(&machines),
        authorizer: Arc::clone(&deps.authorizer),
        agent_memory_folder: deps.data_folder.join(AGENT_MEMORY_FOLDER_NAME),
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

// Takes a revoked rule out of force at the provider the session's lead runs on, through its
// driver; a refusal of the read is the driver's refusal, any other failure its own.
fn revoke_at_session_provider(deps: &ApprovalStart) -> RevokeAtProvider {
    let reads = Arc::clone(&deps.reads);
    let providers = Arc::clone(&deps.providers);
    let read_damaged_from_sequence = Arc::clone(&deps.read_damaged_from_sequence);
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

/// A follower of the log whose task ended abnormally at the stop.
#[derive(Debug, thiserror::Error)]
#[error("the {follower} ended abnormally at the stop")]
pub(crate) struct FollowerStopFailure {
    /// What follows the log, in plain words.
    pub(crate) follower: &'static str,
    /// How its task ended.
    #[source]
    pub(crate) error: JoinError,
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
/// once the start's recovery pass has settled the runs.
#[expect(dead_code, reason = "the daemon's start, which the composition wires")]
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
    #[expect(dead_code, reason = "the daemon's stop, which the composition wires")]
    pub(crate) async fn stop(self, approvals: &Approvals) -> Vec<FollowerStopFailure> {
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
        .filter_map(|(follower, stopped)| {
            stopped
                .err()
                .map(|error| FollowerStopFailure { follower, error })
        })
        .collect()
    }
}
