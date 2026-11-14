use std::fs;
use std::path::{Path, PathBuf};

use rstest::rstest;
use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_contracts::provider::tool_call::ToolCallActionKind;
use sidekicks_platforms::PathRules;
use sidekicks_policy::ask_rule::ProviderAskRule;

use super::{
    CLAUDE_SHARED_SETTINGS_FILE, CLAUDE_USER_SETTINGS_FILE, ClaudeProjectFolder, ClaudeRepository,
    ClaudeRulesError, compose_claude_project_allow_update, compose_claude_session_rule_lists,
    local_settings_path, remove_claude_project_rule, remove_claude_tool_server_rules,
    resolve_claude_local_settings_file, settings_path, write_claude_project_rule,
};
use crate::driver::claude::session::settings_file::ClaudeSettingsFileError;

fn rule(sense: RememberedRuleSense, action: ToolCallActionKind, subject: &str) -> ProviderAskRule {
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
        ToolCallActionKind::Command,
        subject,
    )
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
        local_settings_path(&worktree),
        "{\"permissions\": {\"allow\": [\"Bash(npm test *)\", \"Read\"]}}",
    )
    .expect("the old file is written");

    for _ in 0..2 {
        write_claude_project_rule(
            &folders,
            &home,
            PathRules::Posix,
            &allow_command("npm test"),
            None,
        )
        .await
        .expect("the rule is written");
    }
    assert_eq!(
        read(&local_settings_path(&root)),
        "{\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(npm test *)\"\n    ]\n  }\n}\n"
    );
    assert_eq!(
        read(&common_git_folder.join("info").join("exclude")),
        "/.claude/settings.local.json\n"
    );

    remove_claude_project_rule(
        &folders,
        Some(&home),
        &home.join(".claude"),
        &home,
        PathRules::Posix,
        &allow_command("npm test"),
    )
    .await
    .expect("the rule is revoked");
    assert!(!read(&local_settings_path(&root)).contains("npm test"));
    assert_eq!(
        read(&local_settings_path(&worktree)),
        "{\"permissions\": {\"allow\": [\"Read\"]}}"
    );
}

#[rstest]
#[case::at_the_root_of_the_repository(PathRules::Posix, Some("root"), true, "root")]
#[case::outside_git(PathRules::Posix, None, true, "worktree")]
#[case::on_windows(PathRules::Windows, Some("root"), true, "worktree")]
#[case::at_a_root_that_is_the_home_folder(PathRules::Posix, Some("home"), true, "worktree")]
#[case::at_a_root_the_person_does_not_own(PathRules::Posix, Some("root"), false, "worktree")]
fn claude_codes_local_file_sits_at_the_root_only_where_claude_code_puts_it(
    #[case] path_rules: PathRules,
    #[case] root: Option<&str>,
    #[case] is_owned_by_user: bool,
    #[case] anchor: &str,
) {
    let repository = Repository::new();
    let root = root.map(|name| repository.path(name));
    let (worktree, home, common_git_folder) = (
        repository.path("worktree"),
        repository.path("home"),
        repository.path("root/.git"),
    );
    let folder = ClaudeProjectFolder {
        working_folder: &worktree,
        repository: root.as_deref().map(|root| ClaudeRepository {
            root,
            common_git_folder: &common_git_folder,
            is_owned_by_user,
        }),
    };

    let resolved = resolve_claude_local_settings_file(&folder, &home, path_rules);

    assert_eq!(resolved.path, local_settings_path(&repository.path(anchor)));
}

#[tokio::test]
async fn the_file_claude_code_writes_for_the_answer_is_left_to_it() {
    let repository = Repository::new();
    let (root, worktree, home) = (
        repository.path("root"),
        repository.path("worktree"),
        repository.path("home"),
    );
    let common_git_folder = root.join(".git");
    let folders = [
        ClaudeProjectFolder {
            working_folder: &root,
            repository: Some(ClaudeRepository {
                root: &root,
                common_git_folder: &common_git_folder,
                is_owned_by_user: true,
            }),
        },
        ClaudeProjectFolder {
            working_folder: &worktree,
            repository: None,
        },
    ];

    write_claude_project_rule(
        &folders,
        &home,
        PathRules::Posix,
        &allow_command("npm test"),
        Some(&local_settings_path(&root)),
    )
    .await
    .expect("the rule is written");

    assert!(!local_settings_path(&root).exists());
    assert!(read(&local_settings_path(&worktree)).contains("Bash(npm test *)"));
}

#[tokio::test]
async fn an_edit_keeps_every_other_byte_and_a_block_moves_the_allow_out() {
    let folder = tempfile::tempdir().expect("a project folder");
    let file = local_settings_path(folder.path());
    fs::create_dir_all(file.parent().expect("the file has a folder")).expect("the folder is made");
    fs::write(
        &file,
        concat!(
            "{\n    \"model\": \"opus\",\n    \"permissions\": {\n",
            "        \"allow\": [\"WebFetch(domain:example.com)\", \"Read\"],\n",
            "        \"deny\": [\"Bash(rm *)\"]\n    }\n}\n",
        ),
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
            ToolCallActionKind::Network,
            "example.com",
        ),
        None,
    )
    .await
    .expect("the block is written");

    assert_eq!(
        read(&file),
        concat!(
            "{\n    \"model\": \"opus\",\n    \"permissions\": {\n",
            "        \"allow\": [\"Read\"],\n",
            "        \"deny\": [\"Bash(rm *)\", \"WebFetch(domain:example.com)\"]\n    }\n}\n",
        )
    );
}

// A block on a command stands in the first folder's file; an allow for the same command moves it
// out and lands there, then fails on the second folder's file, which is no settings object, so the
// rollback puts the first file back byte for byte with the block in it. Killed by a take-back that
// only takes the allow's entries out.
#[tokio::test]
async fn a_failed_writes_rollback_brings_back_the_entry_it_moved() {
    let first = tempfile::tempdir().expect("a project folder");
    let second = tempfile::tempdir().expect("a project folder");
    let home = tempfile::tempdir().expect("a home folder");
    let block_text = "{\"permissions\": {\"deny\": [\"Bash(rm *)\"]}}";
    for (folder, text) in [(first.path(), block_text), (second.path(), "[]")] {
        let file = local_settings_path(folder);
        fs::create_dir_all(file.parent().expect("the file has a folder"))
            .expect("the folder is made");
        fs::write(&file, text).expect("the file is written");
    }
    let folders = [first.path(), second.path()].map(|working_folder| ClaudeProjectFolder {
        working_folder,
        repository: None,
    });

    let outcome = write_claude_project_rule(
        &folders,
        home.path(),
        PathRules::Posix,
        &allow_command("rm"),
        None,
    )
    .await;

    let failure = outcome.expect_err("the second file is refused");
    assert!(matches!(
        failure.original(),
        ClaudeRulesError::SettingsFile(ClaudeSettingsFileError::Refused { .. })
    ));
    assert!(failure.cleanup_failures().is_empty());
    assert_eq!(read(&local_settings_path(first.path())), block_text);
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
    let file = local_settings_path(folder.path());
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
    )
    .await;

    let failure = outcome.expect_err("the file is refused");
    assert!(matches!(
        failure.original(),
        ClaudeRulesError::SettingsFile(ClaudeSettingsFileError::Refused { .. })
    ));
    assert!(text.trim().is_empty() || !failure.to_string().contains(text.trim()));
    assert_eq!(read(&file), text);
}

// Killed by a revoke that edits a managed file or a drop-in, that clears the person's files while
// a managed file keeps the rule, that leaves the shared, user or local file's copy, or that
// answers a rule no file holds as removed.
#[tokio::test]
async fn a_revoke_clears_every_file_the_person_keeps_and_is_refused_where_managed_keeps_it() {
    let folder = tempfile::tempdir().expect("a project folder");
    let config_folder = tempfile::tempdir().expect("a config folder");
    let shared_file = settings_path(folder.path(), CLAUDE_SHARED_SETTINGS_FILE);
    fs::create_dir_all(folder.path().join(".claude")).expect("the folder is made");
    fs::write(
        &shared_file,
        "{\"permissions\": {\"allow\": [\"Bash(npm test *)\"]}}",
    )
    .expect("the shared file is written");
    let user_file = config_folder.path().join(CLAUDE_USER_SETTINGS_FILE);
    fs::write(
        &user_file,
        "{\"permissions\": {\"allow\": [\"Bash(cargo build *)\"]}}",
    )
    .expect("the user settings are written");
    let managed_file = config_folder.path().join("managed-settings.json");
    fs::write(
        &managed_file,
        "{\"permissions\": {\"allow\": [\"Bash(make *)\"]}}",
    )
    .expect("the managed settings are written");
    let drop_in_file = config_folder
        .path()
        .join("managed-settings.d")
        .join("10-team.json");
    fs::create_dir_all(config_folder.path().join("managed-settings.d"))
        .expect("the drop-in folder is made");
    fs::write(
        &drop_in_file,
        "{\"permissions\": {\"allow\": [\"Bash(just *)\"]}}",
    )
    .expect("the drop-in is written");
    // The local file holds the rule the shared file keeps, and the managed one the drop-in keeps.
    fs::write(
        local_settings_path(folder.path()),
        "{\"permissions\": {\"allow\": [\"Bash(npm test *)\", \"Bash(just *)\"]}}",
    )
    .expect("the local file is written");
    let managed_text = read(&managed_file);
    let other_folder = tempfile::tempdir().expect("another project folder");
    let folders = [folder.path(), other_folder.path()].map(|working_folder| ClaudeProjectFolder {
        working_folder,
        repository: None,
    });
    let mut outcomes = Vec::new();
    for subject in ["npm test", "cargo build", "make", "just", "ls"] {
        outcomes.push(
            remove_claude_project_rule(
                &folders,
                Some(config_folder.path()),
                config_folder.path(),
                folder.path(),
                PathRules::Posix,
                &allow_command(subject),
            )
            .await,
        );
    }
    let [
        in_shared_file,
        in_user_file,
        in_managed_file,
        in_drop_in,
        nowhere,
    ] = <[_; 5]>::try_from(outcomes).expect("five revokes ran");

    assert!(in_shared_file.is_ok(), "{in_shared_file:?}");
    assert!(in_user_file.is_ok(), "{in_user_file:?}");
    assert!(matches!(
        in_managed_file,
        Err(ClaudeRulesError::RuleInUneditedFile { path }) if path == managed_file
    ));
    assert!(matches!(
        in_drop_in,
        Err(ClaudeRulesError::RuleInUneditedFile { path }) if path == drop_in_file
    ));
    assert!(matches!(nowhere, Err(ClaudeRulesError::RuleNotFound)));
    assert!(!read(&shared_file).contains("npm test"));
    assert!(!read(&user_file).contains("cargo build"));
    let local_text = read(&local_settings_path(folder.path()));
    assert!(!local_text.contains("npm test") && local_text.contains("Bash(just *)"));
    assert_eq!(read(&managed_file), managed_text);
    assert!(!local_settings_path(other_folder.path()).exists());
}

#[tokio::test]
async fn a_removed_tool_servers_rules_go_in_claude_codes_spelling_and_other_servers_stay() {
    let folder = tempfile::tempdir().expect("a project folder");
    let file = local_settings_path(folder.path());
    fs::create_dir_all(file.parent().expect("the file has a folder")).expect("the folder is made");
    fs::write(
        &file,
        concat!(
            "{\"permissions\": {\"allow\": [",
            "\"mcp__my_server__read\", \"mcp__my_server\", \"mcp__reports\", ",
            "\"mcp__reports__search\", \"mcp__reports__v2__*\", \"mcp__reports___*\", ",
            "\"mcp__other__x\", \"mcp__my_serverx__y\", \"mcp__claude_ai_Notion_beta__search\"], ",
            "\"deny\": [\"mcp__my_server__*\"]}}",
        ),
    )
    .expect("the file is written");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];

    for server in ["my.server", "reports", "claude.ai Notion (beta)"] {
        remove_claude_tool_server_rules(&folders, folder.path(), PathRules::Posix, server)
            .await
            .expect("the server's rules are removed");
    }

    assert_eq!(
        read(&file),
        concat!(
            "{\"permissions\": {\"allow\": [\"mcp__reports__v2__*\", \"mcp__reports___*\", ",
            "\"mcp__other__x\", \"mcp__my_serverx__y\"], \"deny\": []}}",
        )
    );
}

#[rstest]
#[case::the_first_entry_right_after_the_bracket("[\"a\", \"b\"]", "[\"b\"]")]
#[case::spaces_inside_the_brackets("[ \"a\", \"b\" ]", "[ \"b\" ]")]
#[case::a_list_over_lines("[\n  \"a\",\n  \"b\"\n]", "[\n  \"b\"\n]")]
#[tokio::test]
async fn a_revoke_keeps_every_byte_of_the_list_but_the_entry_and_its_separator(
    #[case] list: &str,
    #[case] expected: &str,
) {
    let folder = tempfile::tempdir().expect("a project folder");
    let file = local_settings_path(folder.path());
    fs::create_dir_all(file.parent().expect("the file has a folder")).expect("the folder is made");
    fs::write(
        &file,
        format!(
            "{{\"permissions\": {{\"allow\": {}}}}}",
            list.replace("\"a\"", "\"Bash(a *)\"")
        ),
    )
    .expect("the file is written");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];

    remove_claude_project_rule(
        &folders,
        Some(folder.path()),
        folder.path(),
        folder.path(),
        PathRules::Posix,
        &allow_command("a"),
    )
    .await
    .expect("the rule is revoked");

    assert_eq!(
        read(&file),
        format!("{{\"permissions\": {{\"allow\": {expected}}}}}")
    );
}

#[tokio::test]
async fn two_writes_to_one_file_at_once_both_land() {
    let folder = tempfile::tempdir().expect("a project folder");
    let folders = [ClaudeProjectFolder {
        working_folder: folder.path(),
        repository: None,
    }];
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
            )
            .await
        }
    };

    let (first, second) = tokio::join!(write("npm test"), write("cargo build"));
    first.expect("the first write lands");
    second.expect("the second write lands");

    let text = read(&local_settings_path(folder.path()));
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

    write_claude_project_rule(&folders, folder.path(), PathRules::Posix, &allow, None)
        .await
        .expect("nothing is written");

    assert!(!local_settings_path(folder.path()).exists());
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
#[case::a_windows_drive(PathRules::Windows, "C:\\a[1]\\b", &["Edit(//c/a\\[1\\]/b)"])]
#[case::a_posix_path(PathRules::Posix, "/srv/a?b*\\c", &["Edit(//srv/a\\?b\\*\\\\c)"])]
#[case::a_relative_path(PathRules::Posix, "src/[id].ts", &["Edit(src/\\[id\\].ts)"])]
// Claude Code asks before any read of a network path whatever the rules say, so none is kept.
#[case::a_windows_network_path(PathRules::Windows, "\\\\server\\share\\a.txt", &[])]
fn a_path_rule_matches_only_the_path_in_claude_codes_words(
    #[case] path_rules: PathRules,
    #[case] path: &str,
    #[case] expected: &[&str],
) {
    let lists = compose_claude_session_rule_lists(
        &[rule(
            RememberedRuleSense::Allow,
            ToolCallActionKind::FileChange,
            path,
        )],
        path_rules,
    )
    .expect("a file rule composes");

    assert_eq!(lists.allow, expected);
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
