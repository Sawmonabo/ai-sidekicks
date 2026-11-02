use std::fs;

use serde_json::json;
use sidekicks_contracts::provider::settings::{
    ProviderStandingRuleRevokeOutcome, ProviderStandingRuleScope,
};

use super::test_tree::{Tree, account, account_homes, project_id, sources, wire_path, write};
use super::{
    ClaudeRuleAccountHome, ClaudeRuleHome, ClaudeRuleListingSources, ClaudeRuleProject,
    list_claude_standing_rules, revoke_claude_standing_rule,
};
use crate::driver::claude::session::rules::ClaudeRulesError;

// Killed by an id minted without the scope or without the file, by the managed settings or the
// project's local file left unread, by a managed rule given a scope, and by a decision word other
// than the list's own name.
#[tokio::test]
async fn every_list_of_every_file_reads_as_one_row_each_with_an_id_of_its_scope_and_file() {
    let tree = Tree::new();
    write(
        &tree.managed_settings(),
        &json!({ "permissions": { "deny": ["Bash(curl:*)"] } }),
    );
    write(
        &tree.home_settings("home-1"),
        &json!({
            "model": "opus",
            "permissions": { "allow": ["Bash(npm test)"], "deny": ["Read(.env)"] }
        }),
    );
    write(
        &tree.home_settings("home-2"),
        &json!({ "permissions": { "ask": ["Bash(npm test)"] } }),
    );
    write(
        &tree.shared_settings(),
        &json!({ "permissions": { "deny": ["Read(.env)"] } }),
    );
    write(
        &tree.local_settings(),
        &json!({ "permissions": { "deny": ["Read(.env)"] } }),
    );
    let environment: Vec<(String, String)> = Vec::new();
    let (managed, first_home, second_home, person_home, folder) = (
        tree.path("managed"),
        tree.path("home-1"),
        tree.path("home-2"),
        tree.path("person"),
        tree.path("project"),
    );
    let homes = account_homes([&first_home, &second_home], &environment);
    let projects = [ClaudeRuleProject {
        repo_mount_id: project_id(),
        folder: &folder,
    }];
    let sources = sources(&managed, &homes, &person_home, &projects, &environment);

    let rules = list_claude_standing_rules(&sources)
        .await
        .expect("the settings files read");
    let read: Vec<_> = rules
        .iter()
        .map(|rule| {
            (
                rule.decision.as_str(),
                rule.text.as_str(),
                rule.scope.clone(),
                rule.source_path.clone(),
            )
        })
        .collect();
    let first_account = Some(ProviderStandingRuleScope::AccountHome {
        account_id: account("account-1"),
    });
    let project = Some(ProviderStandingRuleScope::Project {
        repo_mount_id: project_id(),
    });
    assert_eq!(
        read,
        [
            (
                "deny",
                "Bash(curl:*)",
                None,
                wire_path(&tree.managed_settings()),
            ),
            (
                "allow",
                "Bash(npm test)",
                first_account.clone(),
                wire_path(&tree.home_settings("home-1")),
            ),
            (
                "deny",
                "Read(.env)",
                first_account,
                wire_path(&tree.home_settings("home-1")),
            ),
            (
                "ask",
                "Bash(npm test)",
                Some(ProviderStandingRuleScope::AccountHome {
                    account_id: account("account-2"),
                }),
                wire_path(&tree.home_settings("home-2")),
            ),
            (
                "deny",
                "Read(.env)",
                project.clone(),
                wire_path(&tree.shared_settings()),
            ),
            (
                "deny",
                "Read(.env)",
                project,
                wire_path(&tree.local_settings())
            ),
        ]
    );
    // The project's two files hold one text in one list, so only the file tells their ids apart.
    assert_ne!(rules[4].rule_id, rules[5].rule_id);

    let again = list_claude_standing_rules(&sources)
        .await
        .expect("the settings files read again");
    assert_eq!(
        again.iter().map(|rule| &rule.rule_id).collect::<Vec<_>>(),
        rules.iter().map(|rule| &rule.rule_id).collect::<Vec<_>>()
    );

    // Two accounts on one home read one file, so only the scope tells their rules apart.
    let shared_homes = account_homes([&first_home, &first_home], &environment);
    let shared = list_claude_standing_rules(&sources_with_homes(&sources, &shared_homes))
        .await
        .expect("the shared home reads");
    // The managed rule, each account's two rules from the one file, then the project's two.
    assert_eq!(shared.len(), 7);
    assert_eq!(shared[1].text, shared[3].text);
    assert_ne!(shared[1].rule_id, shared[3].rule_id);
}

fn sources_with_homes<'a>(
    sources: &ClaudeRuleListingSources<'a>,
    account_homes: &'a [ClaudeRuleAccountHome<'a>],
) -> ClaudeRuleListingSources<'a> {
    ClaudeRuleListingSources {
        managed_settings_folder: sources.managed_settings_folder,
        account_homes,
        person: ClaudeRuleHome {
            home: sources.person.home,
            environment: sources.person.environment,
        },
        projects: sources.projects,
        place: sources.place,
    }
}

// Killed by a revoke that drops the rule's whole list, and by one that rewrites the file without
// its other keys or entries or with the person's spacing changed.
#[tokio::test]
async fn a_revoke_takes_one_entry_from_its_file_and_a_second_revoke_finds_it_absent() {
    let tree = Tree::new();
    fs::create_dir_all(tree.path("project").join(".claude")).expect("the folder is made");
    fs::write(
        tree.shared_settings(),
        concat!(
            "{\"model\": \"opus\",\n  \"permissions\": ",
            "{\"deny\": [\"Read(.env)\", \"Bash(rm:*)\"], ",
            "\"allow\": [\"Bash(ls)\"]},\n  \"env\": {\"EDITOR\": \"vim\"}}\n",
        ),
    )
    .expect("the shared settings are written as the person spaced them");
    let environment: Vec<(String, String)> = Vec::new();
    let (managed, first_home, second_home, person_home, folder) = (
        tree.path("managed"),
        tree.path("home-1"),
        tree.path("home-2"),
        tree.path("person"),
        tree.path("project"),
    );
    let homes = account_homes([&first_home, &second_home], &environment);
    let projects = [ClaudeRuleProject {
        repo_mount_id: project_id(),
        folder: &folder,
    }];
    let sources = sources(&managed, &homes, &person_home, &projects, &environment);
    let rules = list_claude_standing_rules(&sources)
        .await
        .expect("the settings files read");
    let revoked = rules
        .iter()
        .find(|rule| rule.text.as_str() == "Read(.env)")
        .expect("the project's deny is listed")
        .rule_id
        .clone();

    let outcome = revoke_claude_standing_rule(&sources, &revoked)
        .await
        .expect("the revoke edits the file");

    assert_eq!(outcome, ProviderStandingRuleRevokeOutcome::Revoked);
    assert_eq!(
        fs::read_to_string(tree.shared_settings()).expect("the settings file reads"),
        concat!(
            "{\"model\": \"opus\",\n  \"permissions\": {\"deny\": [\"Bash(rm:*)\"], ",
            "\"allow\": [\"Bash(ls)\"]},\n  \"env\": {\"EDITOR\": \"vim\"}}\n",
        )
    );
    let after = list_claude_standing_rules(&sources)
        .await
        .expect("the settings files read after the revoke");
    assert!(after.iter().all(|rule| rule.rule_id != revoked));
    assert_eq!(after.len(), rules.len() - 1);
    assert_eq!(
        revoke_claude_standing_rule(&sources, &revoked)
            .await
            .expect("a second revoke reads the files"),
        ProviderStandingRuleRevokeOutcome::AlreadyAbsent
    );
}

// Killed by a revoke that edits a managed settings file, or reads its rule as already absent.
#[tokio::test]
async fn a_managed_rule_s_revoke_is_refused_and_its_file_left_as_it_was() {
    let tree = Tree::new();
    write(
        &tree.managed_settings(),
        &json!({ "permissions": { "deny": ["Bash(curl:*)"] } }),
    );
    let before = fs::read(tree.managed_settings()).expect("the managed settings read");
    let environment: Vec<(String, String)> = Vec::new();
    let (managed, first_home, second_home, person_home) = (
        tree.path("managed"),
        tree.path("home-1"),
        tree.path("home-2"),
        tree.path("person"),
    );
    let homes = account_homes([&first_home, &second_home], &environment);
    let sources = sources(&managed, &homes, &person_home, &[], &environment);
    let rules = list_claude_standing_rules(&sources)
        .await
        .expect("the settings files read");

    let refusal = revoke_claude_standing_rule(&sources, &rules[0].rule_id)
        .await
        .expect_err("a managed rule is not revoked");

    assert!(
        matches!(refusal, ClaudeRulesError::RuleInUneditedFile { .. }),
        "{refusal:?}"
    );
    assert_eq!(
        fs::read(tree.managed_settings()).expect("the managed settings read again"),
        before
    );
}
