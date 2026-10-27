//! The rules and the permission check a test builds over one test database, and the bound the
//! tests read shell lines under.

use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::background_work::BackgroundWorkForms;
use sidekicks_provider::driver::PROVIDERS;
#[cfg(test)]
use sidekicks_provider::driver::session_control::RevokeRuleParams;
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::machine::local::LocalMachine;
use sidekicks_store::machine::registry::{MACHINE_REGISTRY_STATEMENT_CAPACITY, MachineRegistry};

use super::{PermissionCheck, PermissionCheckDeps};
use crate::rules::{APPROVAL_RULES_STATEMENT_CAPACITY, ApprovalRules};
use crate::service::ApprovalService;
use crate::store::APPROVAL_REQUEST_READER_STATEMENT_CAPACITY;

/// The bound the tests read shell lines under.
pub(crate) const LINE_LIMIT: usize = 4096;

/// The rules and the permission check over one test database, and what a test reads them by.
pub struct TestPermissionCheck {
    /// The rules in force.
    pub rules: Arc<ApprovalRules>,
    /// The bound every line is read under.
    #[cfg(test)]
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// The check.
    pub check: Arc<PermissionCheck>,
    /// Each live run's posture, none until a test sets one.
    #[cfg(test)]
    pub(crate) postures: Arc<ExecutionPostureService>,
    /// Every rule the rules handed a provider to take out of force, oldest first.
    #[cfg(test)]
    pub(crate) provider_rule_calls: Arc<Mutex<Vec<RevokeRuleParams>>>,
}

/// The rules and the check over the database at `path`, recording through `events` and `writer`,
/// raising cards through `approvals`, with the posture files and the agent-memory folder in
/// `home`.
pub fn test_permission_check(
    path: &Path,
    events: &Arc<SessionEventAppender>,
    writer: &Arc<DatabaseWriter>,
    approvals: &Arc<ApprovalService>,
    home: &Path,
) -> TestPermissionCheck {
    let shell_lines = Arc::new(ShellLineReadingBound::new(LINE_LIMIT));
    let machine_id =
        MachineId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a machine id");
    let provider_rule_calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&provider_rule_calls);
    let rules = Arc::new(ApprovalRules::new(
        Arc::new(DatabaseReadPool::new(
            path.to_path_buf(),
            APPROVAL_RULES_STATEMENT_CAPACITY,
        )),
        Arc::clone(events),
        machine_id.clone(),
        Box::new(move |params| {
            lock(&recorded).push(params);
            async { Ok(()) }.boxed()
        }),
        Arc::clone(&shell_lines),
    ));
    let postures = Arc::new(ExecutionPostureService::new(
        home,
        home.join("session-token"),
    ));
    let check = Arc::new(PermissionCheck::new(PermissionCheckDeps {
        reads: Arc::new(DatabaseReadPool::new(
            path.to_path_buf(),
            APPROVAL_REQUEST_READER_STATEMENT_CAPACITY,
        )),
        approvals: Arc::clone(approvals),
        rules: Arc::clone(&rules),
        shell_lines: Arc::clone(&shell_lines),
        background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
        postures: Arc::clone(&postures),
        machine: Arc::new(MachineRegistry::new(
            Arc::new(DatabaseReadPool::new(
                path.to_path_buf(),
                MACHINE_REGISTRY_STATEMENT_CAPACITY,
            )),
            Arc::clone(writer),
            LocalMachine {
                machine_id,
                owner_user_id: UserId::try_from(mint_uuid_v7())
                    .expect("a minted UUID is a user id"),
                name: "test".to_owned(),
            },
        )),
        authorizer: Arc::new(Authorizer::load_built_in().expect("the built-in rules load")),
        agent_memory_folder: home.to_path_buf(),
    }));
    TestPermissionCheck {
        rules,
        #[cfg(test)]
        shell_lines,
        check,
        #[cfg(test)]
        postures,
        #[cfg(test)]
        provider_rule_calls,
    }
}
