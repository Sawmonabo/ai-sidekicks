use std::fs;
use std::path::{Path, PathBuf};

use rstest::rstest;
use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_platforms::PathRules;

use super::{
    ClaudeProjectFolder, ClaudeRepository, ClaudeRulesError, compose_claude_project_allow_update,
    compose_claude_session_rule_lists, remove_claude_project_rule, remove_claude_tool_server_rules,
    write_claude_project_rule,
};
use crate::keyed_lock::KeyedLock;
use crate::provider::port::permission_ask::{ProviderAskActionKind, ProviderAskRule};

// Every write holds a `'static` lock, so each test takes one of its own for the test's life.
fn lock() -> &'static KeyedLock<PathBuf> {
    Box::leak(Box::new(KeyedLock::new()))
}

fn rule(
    sense: RememberedRuleSense,
    action: ProviderAskActionKind,
    subject: &str,
) -> ProviderAskRule {
    ProviderAskRule {
        kind: RememberedScopeKind::Project,
        sense,
        action,
        subject: subject.to_owned(),
    }
}

fn allow_command(subject: &str) -> ProviderAskRule {
    rule(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::Command,
        subject,
    )
}

fn local_settings(folder: &Path) -> PathBuf {
    folder.join(".claude").join("settings.local.json")
}

fn read(file: &Path) -> String {
    fs::read_to_string(file).expect("the settings file reads")
}

// A repository at `root` with a worktree at `worktree`, both under one scratch folder.
struct Repository {
    scratch: tempfile::TempDir,
}

impl Repository {
    fn new() -> Self {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        for folder in ["root/.git", "worktree", "home"] {
            fs::create_dir_all(scratch.path().join(folder)).expect("the folder is made");
        }
        Self { scratch }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.scratch.path().join(name)
    }
}

#[tokio::test]
async fn a_write_lands_at_the_root_once_and_a_revoke_clears_the_root_and_the_starting_folder() {
    let repository = Repository::new();
    let (root, worktree, home) = (
        repository.path("root"),
        repository.path("worktree"),
        repository.path("home"),
    );
    let common_git_folder = root.join(".git");
    let folders = [&root, &worktree].map(|working_folder| ClaudeProjectFolder {
        working_folder,
        repository: Some(ClaudeRepository {
            root: &root,
            common_git_folder: &common_git_folder,
            is_owned_by_user: true,
        }),
    });
    // A file an earlier Claude Code left in the starting folder, whose rules still apply.
    fs::create_dir_all(worktree.join(".claude")).expect("the folder is made");
    fs::write(
        local_settings(&worktree),
        "{\"permissions\": {\"allow\": [\"Bash(npm test *)\", \"Read\"]}}",
    )
    .expect("the old file is written");
    let lock = lock();

    for _ in 0..2 {
        write_claude_project_rule(
            &folders,
            &home,
            PathRules::Posix,
            &allow_command("npm test"),
            None,
            lock,
        )
        .await
        .expect("the rule is written");
    }
    assert_eq!(
        read(&local_settings(&root)),
        "{\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(npm test *)\"\n    ]\n  }\n}\n"
    );
    assert_eq!(
        read(&common_git_folder.join("info").join("exclude")),
        "/.claude/settings.local.json\n"
    );

    remove_claude_project_rule(
        &folders,
        &home,
        PathRules::Posix,
        &allow_command("npm test"),
        lock,
    )
    .await
    .expect("the rule is revoked");
    assert!(!read(&local_settings(&root)).contains("npm test"));
    assert_eq!(
        read(&local_settings(&worktree)),
        "{\"permissions\": {\"allow\": [\"Read\"]}}"
    );
}

#[tokio::test]
async fn an_edit_keeps_every_other_byte_and_a_block_moves_the_allow_out() {
    let folder = tempfile::tempdir().expect("a project folder");
    let file = local_settings(folder.path());
    fs::create_dir_all(file.parent().expect("the file has a folder")).expect("the folder is made");
    fs::write(
        &file,
        "{\n    \"model\": \"opus\",\n    \"permissions\": {\n        \"allow\": [\"WebFetch(domain:example.com)\", \"Read\"],\n        \"deny\": [\"Bash(rm *)\"]\n    }\n}\n",
    )
    .expect("the file is written");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];

    write_claude_project_rule(
        &folders,
        folder.path(),
        PathRules::Posix,
        &rule(
            RememberedRuleSense::Block,
            ProviderAskActionKind::Network,
            "example.com",
        ),
        None,
        lock(),
    )
    .await
    .expect("the block is written");

    assert_eq!(
        read(&file),
        "{\n    \"model\": \"opus\",\n    \"permissions\": {\n        \"allow\": [\"Read\"],\n        \"deny\": [\"Bash(rm *)\", \"WebFetch(domain:example.com)\"]\n    }\n}\n"
    );
}

#[rstest]
#[case::a_comment("{\"permissions\": {} // mine\n}")]
#[case::a_trailing_comma("{\"permissions\": {\"allow\": [],}}")]
#[case::an_array("[]")]
#[case::a_blank_file(" \n")]
#[case::permissions_not_an_object("{\"permissions\": []}")]
#[case::a_list_not_an_array("{\"permissions\": {\"allow\": \"Read\"}}")]
#[tokio::test]
async fn a_file_that_is_not_a_strict_settings_object_is_refused_unchanged(#[case] text: &str) {
    let folder = tempfile::tempdir().expect("a project folder");
    let file = local_settings(folder.path());
    fs::create_dir_all(file.parent().expect("the file has a folder")).expect("the folder is made");
    fs::write(&file, text).expect("the file is written");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];

    let outcome = write_claude_project_rule(
        &folders,
        folder.path(),
        PathRules::Posix,
        &allow_command("ls"),
        None,
        lock(),
    )
    .await;

    let failure = outcome.expect_err("the file is refused");
    assert!(matches!(
        failure.original(),
        ClaudeRulesError::Refused { .. }
    ));
    assert!(text.trim().is_empty() || !failure.to_string().contains(text.trim()));
    assert_eq!(read(&file), text);
}

#[tokio::test]
async fn a_revoke_and_a_server_removal_make_no_file() {
    let folder = tempfile::tempdir().expect("a project folder");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];
    let lock = lock();

    remove_claude_project_rule(
        &folders,
        folder.path(),
        PathRules::Posix,
        &allow_command("ls"),
        lock,
    )
    .await
    .expect("the revoke succeeds");
    remove_claude_tool_server_rules(&folders, folder.path(), PathRules::Posix, "docs", lock)
        .await
        .expect("the removal succeeds");

    assert!(!local_settings(folder.path()).exists());
}

#[tokio::test]
async fn a_removed_tool_servers_rules_go_and_other_servers_stay() {
    let folder = tempfile::tempdir().expect("a project folder");
    let file = local_settings(folder.path());
    fs::create_dir_all(file.parent().expect("the file has a folder")).expect("the folder is made");
    fs::write(
        &file,
        "{\"permissions\": {\"allow\": [\"mcp__srv__read\", \"mcp__srv\", \"mcp__other__x\", \"mcp__srvx__y\"], \"deny\": [\"mcp__srv__write\"]}}",
    )
    .expect("the file is written");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];

    remove_claude_tool_server_rules(&folders, folder.path(), PathRules::Posix, "srv", lock())
        .await
        .expect("the server's rules are removed");

    assert_eq!(
        read(&file),
        "{\"permissions\": {\"allow\": [\"mcp__other__x\", \"mcp__srvx__y\"], \"deny\": []}}"
    );
}

#[tokio::test]
async fn two_writes_to_one_file_at_once_both_land() {
    let folder = tempfile::tempdir().expect("a project folder");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];
    let lock = lock();
    let write = |subject: &'static str| {
        let folders = &folders;
        let home = folder.path();
        async move {
            write_claude_project_rule(
                folders,
                home,
                PathRules::Posix,
                &allow_command(subject),
                None,
                lock,
            )
            .await
        }
    };

    let (first, second) = tokio::join!(write("npm test"), write("cargo build"));
    first.expect("the first write lands");
    second.expect("the second write lands");

    let text = read(&local_settings(folder.path()));
    assert!(text.contains("Bash(npm test *)") && text.contains("Bash(cargo build *)"));
}

#[rstest]
#[case::the_whole_of_git("git")]
#[case::a_push("git push")]
#[case::a_branch_change("git branch")]
#[case::a_wildcard("npm *")]
#[tokio::test]
async fn an_allow_that_would_stretch_is_never_handed_over(#[case] subject: &str) {
    let folder = tempfile::tempdir().expect("a project folder");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];
    let allow = allow_command(subject);

    write_claude_project_rule(
        &folders,
        folder.path(),
        PathRules::Posix,
        &allow,
        None,
        lock(),
    )
    .await
    .expect("nothing is written");

    assert!(!local_settings(folder.path()).exists());
    assert_eq!(
        compose_claude_project_allow_update(&allow, PathRules::Posix)
            .expect("a command's rule composes"),
        None
    );
    assert_eq!(
        compose_claude_session_rule_lists(&[allow], PathRules::Posix)
            .expect("a command's rule composes")
            .allow,
        Vec::<String>::new()
    );
}

#[rstest]
#[case::a_windows_drive(PathRules::Windows, "C:\\a[1]\\b", "Edit(//c/a\\[1\\]/b)")]
#[case::a_posix_path(PathRules::Posix, "/srv/a?b*\\c", "Edit(//srv/a\\?b\\*\\\\c)")]
#[case::a_relative_path(PathRules::Posix, "src/[id].ts", "Edit(src/\\[id\\].ts)")]
fn a_path_rule_matches_only_the_path_in_claude_codes_words(
    #[case] path_rules: PathRules,
    #[case] path: &str,
    #[case] expected: &str,
) {
    let lists = compose_claude_session_rule_lists(
        &[rule(
            RememberedRuleSense::Allow,
            ProviderAskActionKind::FileChange,
            path,
        )],
        path_rules,
    )
    .expect("a file rule composes");

    assert_eq!(lists.allow, [expected]);
}

#[test]
fn a_project_allow_rides_the_answer_as_claude_codes_own_update() {
    let update = compose_claude_project_allow_update(&allow_command("npm test"), PathRules::Posix)
        .expect("a command's rule composes")
        .expect("the allow is handed over");

    assert_eq!(
        serde_json::to_value(update).expect("the update serializes"),
        serde_json::json!({
            "type": "addRules",
            "rules": [{"toolName": "Bash", "ruleContent": "npm test *"}],
            "behavior": "allow",
            "destination": "localSettings",
        })
    );
}
