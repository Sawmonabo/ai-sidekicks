//! A revoked project rule, taken out beside the rules of the account home its session ran on.

use std::sync::Arc;

use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::super::CodexDriver;
use crate::driver::codex::session::test_fixture::OneFolder;
use crate::driver::contract::DriverError;
use crate::driver::schema::schema_parts;
use crate::driver::session_control::RevokeRuleParams;
use crate::driver::test_registry::{new_session_id, test_driver_services};
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::runtime_binding::test_store::{record_session_leg, test_provider_account_id};

/// The rule both the session's account home and the project's own file keep.
const KEPT_RULE_LINE: &str = "prefix_rule(pattern=[\"cargo\", \"build\"], decision=\"allow\")\n";

// A resting session's revoke reads the rules of the account home its stored leg ran on: a rule
// that home keeps stays in force, so the project's own file is left as it was. Killed by reading
// any other home, where nothing keeps the rule and the project's line is taken out.
#[tokio::test]
async fn a_revoke_reads_the_rules_of_the_sessions_own_account_home() {
    let folder = tempfile::tempdir().expect("a test folder");
    let working_folder = folder.path().join("work");
    let account_home = folder.path().join("codex-home");
    std::fs::create_dir_all(account_home.join("rules")).expect("the home's rules folder");
    std::fs::write(account_home.join("rules/default.rules"), KEPT_RULE_LINE)
        .expect("the home's rule is written");
    let project_folder = folder.path().join("project");
    let own_file = project_folder.join(".codex/rules/sidekicks.rules");
    std::fs::create_dir_all(project_folder.join(".codex/rules")).expect("the project's rules");
    std::fs::write(&own_file, KEPT_RULE_LINE).expect("the project's rule is written");

    let services = test_driver_services();
    let engine = Arc::new(RecordingRunEngine::default());
    assert!(
        services
            .ports
            .run_engine
            .register(Arc::clone(&engine) as _)
            .is_ok()
    );
    assert!(
        services
            .ports
            .provider_accounts
            .register(Arc::new(OneFolder(working_folder)) as _)
            .is_ok()
    );
    let driver = CodexDriver::new(&services);
    let database = TestDatabase::new(schema_parts());
    let session_id = new_session_id();
    record_session_leg(
        &database,
        &engine,
        session_id,
        test_provider_account_id(),
        "thread",
    )
    .await;

    let revoked = driver
        .revoke_rule(RevokeRuleParams {
            session_id,
            rule: ProviderAskRule {
                kind: RememberedScopeKind::Project,
                sense: RememberedRuleSense::Allow,
                action: ProviderAskActionKind::Command,
                subject: "cargo build".to_owned(),
            },
            project_folder: Some(project_folder),
        })
        .await;

    assert!(
        matches!(revoked, Err(DriverError::Internal(_))),
        "the home's rule keeps the revoke from taking effect: {revoked:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&own_file).expect("the project's file is kept"),
        KEPT_RULE_LINE
    );
}
