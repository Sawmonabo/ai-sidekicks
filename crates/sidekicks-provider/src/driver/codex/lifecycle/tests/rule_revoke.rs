//! A revoked project rule, taken out of the rules of the account home its session ran on too.

use std::sync::Arc;

use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_contracts::provider::tool_call::ToolCallActionKind;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::super::CodexDriver;
use crate::driver::codex::session::test_fixture::one_folder::OneFolder;
use crate::driver::schema::schema_parts;
use crate::driver::session_control::RevokeRuleParams;
use crate::driver::test_registry::{new_session_id, test_driver_services};
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::runtime_binding::test_store::{record_session_leg, test_provider_account_id};

/// The rule both the session's account home and the project's own file keep.
const KEPT_RULE_LINE: &str = "prefix_rule(pattern=[\"cargo\", \"build\"], decision=\"allow\")\n";

/// Another rule the session's account home keeps, which the revoke leaves.
const OTHER_RULE_LINE: &str = "prefix_rule(pattern=[\"git\", \"status\"])\n";

// A resting session's revoke reads the rules of the account home its stored leg ran on: the rule
// is taken out of that home's file as well as the project's own, every other rule kept. Killed by
// reading any other home, where nothing keeps the rule and the home's line stays in force.
#[tokio::test]
async fn a_revoke_reads_the_rules_of_the_sessions_own_account_home() {
    let folder = tempfile::tempdir().expect("a test folder");
    let working_folder = folder.path().join("work");
    let account_home = folder.path().join("codex-home");
    std::fs::create_dir_all(account_home.join("rules")).expect("the home's rules folder");
    let home_file = account_home.join("rules/default.rules");
    std::fs::write(&home_file, format!("{KEPT_RULE_LINE}{OTHER_RULE_LINE}"))
        .expect("the home's rules are written");
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
            .register(Arc::new(OneFolder(working_folder).accounts()) as _)
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
                action: ToolCallActionKind::Command,
                subject: "cargo build".to_owned(),
            },
            project_folder: Some(project_folder),
        })
        .await;

    assert!(revoked.is_ok(), "{revoked:?}");
    assert_eq!(
        std::fs::read_to_string(&home_file).expect("the home's file is kept"),
        OTHER_RULE_LINE
    );
    assert!(
        !own_file.exists(),
        "the project's own file, its one line taken out, is removed"
    );
}
