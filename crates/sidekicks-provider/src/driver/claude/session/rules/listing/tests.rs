use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::settings::{
    PROVIDER_RULE_TEXT_MAX_LEN, ProviderProtectedPath, ProviderStandingRuleRevokeOutcome,
    ProviderStandingRuleScope,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{
    ClaudeRuleAccountHome, ClaudeRuleHome, ClaudeRuleListingSources, ClaudeRuleProject,
    list_claude_standing_rules, read_claude_protected_paths, revoke_claude_standing_rule,
};

const PROJECT_ID: &str = "0190f3c4-5b6a-7c8d-9e0f-1a2b3c4d5e6f";

// Two account homes, the person's home and one project under one scratch folder, each home's
// settings file where Claude Code reads it with no `CLAUDE_CONFIG_DIR` set.
struct Tree {
    scratch: tempfile::TempDir,
}

impl Tree {
    fn new() -> Self {
        Self {
            scratch: tempfile::tempdir().expect("a scratch folder"),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.scratch.path().join(name)
    }

    fn home_settings(&self, home: &str) -> PathBuf {
        self.path(home).join(".claude").join("settings.json")
    }

    fn shared_settings(&self) -> PathBuf {
        self.path("project").join(".claude").join("settings.json")
    }

    fn local_settings(&self) -> PathBuf {
        self.path("project")
            .join(".claude")
            .join("settings.local.json")
    }
}

fn write(file: &Path, settings: &Value) {
    fs::create_dir_all(file.parent().expect("a settings file sits in a folder"))
        .expect("the folder is made");
    fs::write(
        file,
        serde_json::to_string_pretty(settings).expect("the settings serialize"),
    )
    .expect("the settings file is written");
}

fn account(id: &str) -> ProviderAccountId {
    ProviderAccountId::new(id.to_owned()).expect("the test's account id")
}

fn project_id() -> RepoMountId {
    RepoMountId::new(PROJECT_ID).expect("the id is a UUID")
}

fn wire_path(file: &Path) -> FilesystemPath {
    FilesystemPath::new(file.to_string_lossy().into_owned()).expect("the scratch path fits")
}

fn pattern(text: &str) -> FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN> {
    FreeFormText::new(text.to_owned()).expect("the test's pattern")
}

fn account_homes<'a>(
    homes: [&'a Path; 2],
    environment: &'a [(String, String)],
) -> [ClaudeRuleAccountHome<'a>; 2] {
    let [first, second] = homes;
    [
        ClaudeRuleAccountHome {
            account_id: account("account-1"),
            home: ClaudeRuleHome {
                home: first,
                environment,
            },
        },
        ClaudeRuleAccountHome {
            account_id: account("account-2"),
            home: ClaudeRuleHome {
                home: second,
                environment,
            },
        },
    ]
}

fn sources<'a>(
    account_homes: &'a [ClaudeRuleAccountHome<'a>],
    person_home: &'a Path,
    projects: &'a [ClaudeRuleProject<'a>],
    environment: &'a [(String, String)],
) -> ClaudeRuleListingSources<'a> {
    ClaudeRuleListingSources {
        account_homes,
        person: ClaudeRuleHome {
            home: person_home,
            environment,
        },
        projects,
        place: None,
    }
}

// Killed by an id minted without the scope or without the file, by the project's local file left
// unread, and by a decision word other than the list's own name.
#[tokio::test]
async fn every_list_of_every_file_reads_as_one_row_each_with_an_id_of_its_scope_and_file() {
    let tree = Tree::new();
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
    let (first_home, second_home, person_home, folder) = (
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
    let sources = sources(&homes, &person_home, &projects, &environment);

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
    let first_account = ProviderStandingRuleScope::AccountHome {
        account_id: account("account-1"),
    };
    let project = ProviderStandingRuleScope::Project {
        repo_mount_id: project_id(),
    };
    assert_eq!(
        read,
        [
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
                ProviderStandingRuleScope::AccountHome {
                    account_id: account("account-2"),
                },
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
    assert_ne!(rules[3].rule_id, rules[4].rule_id);

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
    // Each account's two rules from the one file, then the project's two.
    assert_eq!(shared.len(), 6);
    assert_eq!(shared[0].text, shared[2].text);
    assert_ne!(shared[0].rule_id, shared[2].rule_id);
}

fn sources_with_homes<'a>(
    sources: &ClaudeRuleListingSources<'a>,
    account_homes: &'a [ClaudeRuleAccountHome<'a>],
) -> ClaudeRuleListingSources<'a> {
    ClaudeRuleListingSources {
        account_homes,
        person: ClaudeRuleHome {
            home: sources.person.home,
            environment: sources.person.environment,
        },
        projects: sources.projects,
        place: sources.place.clone(),
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
    let (first_home, second_home, person_home, folder) = (
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
    let sources = sources(&homes, &person_home, &projects, &environment);
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

// Killed by `Edit(…)` deny rules left unread, by the sandbox's `denyRead` left unread, and by a
// deny rule that names no path, or an allow, listed as a protected path.
#[tokio::test]
async fn protected_paths_are_the_read_and_edit_denies_and_the_sandbox_denies_with_their_files() {
    let tree = Tree::new();
    write(
        &tree.home_settings("home-1"),
        &json!({
            "permissions": {
                "deny": ["Read(~/.aws/**)", "Edit(secrets/**)", "Bash(rm:*)"],
                "allow": ["Read(src/**)"]
            },
            "sandbox": { "filesystem": { "denyRead": ["~/.ssh"] } }
        }),
    );
    write(
        &tree.local_settings(),
        &json!({ "permissions": { "deny": ["Read(.env)"] } }),
    );
    let environment: Vec<(String, String)> = Vec::new();
    let (first_home, second_home, person_home, folder) = (
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
    let sources = sources(&homes, &person_home, &projects, &environment);

    let paths = read_claude_protected_paths(&sources)
        .await
        .expect("the settings files read");

    let home_file = wire_path(&tree.home_settings("home-1"));
    let global = |text: &str| ProviderProtectedPath::Global {
        pattern: pattern(text),
        place: None,
        source_path: home_file.clone(),
    };
    assert_eq!(
        paths,
        [
            global("~/.aws/**"),
            global("secrets/**"),
            global("~/.ssh"),
            ProviderProtectedPath::Project {
                pattern: pattern(".env"),
                source_path: wire_path(&tree.local_settings()),
                repo_mount_id: project_id(),
            },
        ]
    );
}
