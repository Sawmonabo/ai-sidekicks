use std::collections::HashSet;

use sidekicks_contracts::provider::settings::rules::{
    ProviderStandingRule, ProviderStandingRuleRevokeOutcome, ProviderStandingRuleScope,
};

use super::revoke_codex_standing_rule;
use super::test_machine::{
    CAT_CALL, COMMENTED_CALL, LS_CALL, Machine, NPM_CALL, TRUSTED_MOUNT, file_path, home_scope,
    mount,
};
use crate::driver::codex::rules::CodexRulesError;

// What a row says, its id aside.
fn row(rule: &ProviderStandingRule) -> (Option<ProviderStandingRuleScope>, String, String, String) {
    (
        rule.scope.clone(),
        rule.source_path.as_str().to_owned(),
        rule.decision.as_str().to_owned(),
        rule.text.as_str().to_owned(),
    )
}

// The list reads every call of the system files once under no scope, each home's own files under
// that home, and the trusted project's under the project, once, each with Codex's decision word and
// its call as written, and nothing of the untrusted project; the id holds the scope and the file,
// and is the same on every read. Killed by listing a system rule under each home's scope.
#[tokio::test]
async fn lists_each_rule_call_as_written_under_its_scope_and_file_with_a_stable_id() {
    let machine = Machine::new();
    machine.write_rule_files();
    let rules = machine.list().await;

    let system = machine.path("system/rules/system.rules");
    let system = system.to_string_lossy();
    let home_a = machine.path("home-a/codex/rules/default.rules");
    let home_b = machine.path("home-b/codex/rules/default.rules");
    let project = machine.path("trusted/.codex/rules/team.rules");
    let expected =
        |scope: Option<ProviderStandingRuleScope>, file: &str, decision: &str, text: &str| {
            (scope, file.to_owned(), decision.to_owned(), text.to_owned())
        };
    let trusted = Some(ProviderStandingRuleScope::Project {
        repo_mount_id: mount(TRUSTED_MOUNT),
    });
    assert_eq!(
        rules.iter().map(row).collect::<Vec<_>>(),
        vec![
            expected(None, &system, "prompt", COMMENTED_CALL),
            expected(None, &system, "allow", LS_CALL),
            expected(
                Some(home_scope("a")),
                &home_a.to_string_lossy(),
                "allow",
                LS_CALL
            ),
            expected(
                Some(home_scope("b")),
                &home_b.to_string_lossy(),
                "allow",
                LS_CALL
            ),
            expected(trusted, &project.to_string_lossy(), "allow", NPM_CALL),
        ]
    );
    let ids: HashSet<_> = rules.iter().map(|rule| rule.rule_id.clone()).collect();
    assert_eq!(ids.len(), rules.len(), "every rule has its own id");
    let again: Vec<_> = machine
        .list()
        .await
        .into_iter()
        .map(|rule| rule.rule_id)
        .collect();
    assert_eq!(
        again,
        rules
            .into_iter()
            .map(|rule| rule.rule_id)
            .collect::<Vec<_>>()
    );
}

// A revoke takes the one call out of its home's file, leaving the file's other call and every
// other file as they were, and a second revoke of the same id finds it gone.
#[tokio::test]
async fn revokes_one_call_from_its_own_file_and_again_reads_already_absent() {
    let machine = Machine::new();
    machine.write_rule_files();
    machine.write(
        "home-a/codex/rules/default.rules",
        &format!("{LS_CALL}\n{CAT_CALL}\n"),
    );
    let untouched = [
        "system/rules/system.rules",
        "home-b/codex/rules/default.rules",
        "trusted/.codex/rules/team.rules",
    ]
    .map(|file| (file, machine.read(file)));
    let home_a = machine.path("home-a/codex/rules/default.rules");
    let revoked = machine
        .list()
        .await
        .into_iter()
        .find(|rule| {
            rule.scope == Some(home_scope("a"))
                && rule.source_path == file_path(&home_a)
                && rule.text.as_str() == LS_CALL
        })
        .expect("home a's own ls rule is listed")
        .rule_id;

    let outcome = revoke_codex_standing_rule(&machine.sources(), &revoked)
        .await
        .expect("the revoke");

    assert_eq!(outcome, ProviderStandingRuleRevokeOutcome::Revoked);
    assert_eq!(
        machine.read("home-a/codex/rules/default.rules"),
        format!("{CAT_CALL}\n")
    );
    for (file, text) in untouched {
        assert_eq!(machine.read(file), text, "{file} is unchanged");
    }
    assert!(
        machine
            .list()
            .await
            .iter()
            .all(|rule| rule.rule_id != revoked)
    );
    let again = revoke_codex_standing_rule(&machine.sources(), &revoked)
        .await
        .expect("the second revoke");
    assert_eq!(again, ProviderStandingRuleRevokeOutcome::AlreadyAbsent);
}

// A rule of the system folder, which Codex reads for every home, is never revoked: the revoke is
// refused and the file left as it was. Killed by letting the revoke edit a system file.
#[tokio::test]
async fn a_system_rule_is_refused_and_its_file_left_as_it_was() {
    let machine = Machine::new();
    machine.write_rule_files();
    let before = machine.read("system/rules/system.rules");
    let system_rule = machine
        .list()
        .await
        .into_iter()
        .find(|rule| rule.scope.is_none() && rule.text.as_str() == LS_CALL)
        .expect("the system ls rule is listed")
        .rule_id;

    let refused = revoke_codex_standing_rule(&machine.sources(), &system_rule).await;

    assert!(
        matches!(refused, Err(CodexRulesError::RuleInUneditedFile { .. })),
        "{refused:?}"
    );
    assert_eq!(machine.read("system/rules/system.rules"), before);
}

// A call whose removal would leave a file Codex refuses, the one statement of a loop's body or
// one of two calls on one line, is refused with the file left as it was, since Codex would then
// drop every rule file's rules. Killed by writing the edited text without evaluating it first.
#[tokio::test]
async fn a_revoke_that_would_leave_an_unloadable_file_is_refused_and_writes_nothing() {
    let loop_body = "for word in [\"ls\"]:\n    prefix_rule(pattern = [word])\n";
    let one_line = format!("{LS_CALL}; {CAT_CALL}\n");
    for (text, revoked_text) in [
        (loop_body.to_owned(), "prefix_rule(pattern = [word])"),
        (one_line, LS_CALL),
    ] {
        let machine = Machine::new();
        machine.write_rule_files();
        machine.write("home-a/codex/rules/default.rules", &text);
        let revoked = machine
            .list()
            .await
            .into_iter()
            .find(|rule| rule.scope == Some(home_scope("a")) && rule.text.as_str() == revoked_text)
            .expect("home a's rule is listed")
            .rule_id;

        let refused = revoke_codex_standing_rule(&machine.sources(), &revoked).await;

        assert!(
            matches!(refused, Err(CodexRulesError::RevokeRefused { .. })),
            "{text}: {refused:?}"
        );
        assert_eq!(machine.read("home-a/codex/rules/default.rules"), text);
    }
}
