use std::fs;
use std::path::{Path, PathBuf};

use rstest::rstest;
use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_platforms::PathRules;

use super::{
    CodexProjectRules, CodexRuleSources, CodexRulesError, CodexUnreadRuleFile,
    read_codex_project_rules, remove_codex_project_rule, write_codex_project_rule,
};
use crate::provider::port::permission_ask::{ProviderAskActionKind, ProviderAskRule};

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

fn rule_file(project_folder: &Path) -> PathBuf {
    project_folder.join(".codex/rules/sidekicks.rules")
}

// A Codex home and a project folder, both under one scratch folder.
struct Places {
    scratch: tempfile::TempDir,
}

impl Places {
    fn new() -> Self {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        for folder in ["home/rules", "project/.codex/rules"] {
            fs::create_dir_all(scratch.path().join(folder)).expect("the folder is made");
        }
        Self { scratch }
    }

    fn project(&self) -> PathBuf {
        self.scratch.path().join("project")
    }

    fn write(&self, file: &str, text: &str) -> PathBuf {
        let path = self.scratch.path().join(file);
        fs::write(&path, text).expect("the rule file is written");
        path
    }

    async fn read(&self, is_project_trusted: bool) -> Result<CodexProjectRules, CodexRulesError> {
        read_codex_project_rules(&CodexRuleSources {
            codex_home: &self.scratch.path().join("home"),
            project_folder: &self.project(),
            is_project_trusted,
            path_rules: PathRules::Posix,
        })
        .await
    }

    async fn read_rules(&self) -> Vec<ProviderAskRule> {
        let read = self.read(true).await.expect("the rules read");
        assert_eq!(read.unread_files, []);
        read.rules.into_iter().map(|kept| kept.rule).collect()
    }
}

#[tokio::test]
async fn a_block_replaces_the_allow_and_a_revoke_of_the_last_rule_deletes_the_file() {
    let places = Places::new();
    let project = places.project();
    let git_folder = tempfile::tempdir().expect("a git folder");
    let allow = rule(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::Network,
        "example.com",
    );
    let block = rule(
        RememberedRuleSense::Block,
        ProviderAskActionKind::Network,
        "example.com",
    );
    let command = allow_command("npm  test");

    for written in [&allow, &command, &block] {
        write_codex_project_rule(&project, Some(git_folder.path()), written)
            .await
            .expect("the rule is written");
    }

    assert_eq!(
        fs::read_to_string(rule_file(&project)).expect("the rule file reads"),
        "prefix_rule(pattern=[\"npm\", \"test\"], decision=\"allow\")\n\
         network_rule(host=\"example.com\", protocol=\"https\", decision=\"deny\")\n\
         network_rule(host=\"example.com\", protocol=\"http\", decision=\"deny\")\n"
    );
    assert_eq!(
        fs::read_to_string(git_folder.path().join("info/exclude")).expect("the exclude list reads"),
        "/.codex/rules/sidekicks.rules\n"
    );

    remove_codex_project_rule(&project, &block, PathRules::Posix)
        .await
        .expect("the block is removed");
    assert_eq!(places.read_rules().await, [allow_command("npm test")]);

    remove_codex_project_rule(&project, &command, PathRules::Posix)
        .await
        .expect("the last rule is removed");
    assert!(!rule_file(&project).exists());
}

#[tokio::test]
async fn a_revoke_of_a_rule_the_daemons_file_lacks_names_where_it_is_kept() {
    let places = Places::new();
    let project = places.project();
    let own_file = places.write(
        "project/.codex/rules/sidekicks.rules",
        "prefix_rule(pattern=[\"ls\"])\n",
    );
    let team_file = places.write(
        "project/.codex/rules/team.rules",
        "prefix_rule(pattern=[\"npm\", \"test\"])\n",
    );

    let in_team_file =
        remove_codex_project_rule(&project, &allow_command("npm test"), PathRules::Posix).await;
    let nowhere =
        remove_codex_project_rule(&project, &allow_command("cargo build"), PathRules::Posix).await;

    assert!(matches!(
        in_team_file,
        Err(CodexRulesError::RuleInUneditedFile { path }) if path == team_file
    ));
    assert!(matches!(nowhere, Err(CodexRulesError::RuleNotFound)));
    assert_eq!(
        fs::read_to_string(own_file).expect("the daemon's file reads"),
        "prefix_rule(pattern=[\"ls\"])\n"
    );
}

#[rstest]
#[case::the_whole_of_git(ProviderAskActionKind::Command, "git", None)]
#[case::a_push(ProviderAskActionKind::Command, "git push", None)]
#[case::a_branch_change(ProviderAskActionKind::Command, "git branch", None)]
#[case::no_word(
    ProviderAskActionKind::Command,
    " \u{3000}",
    Some("a command rule names no word")
)]
#[case::a_url(
    ProviderAskActionKind::Network,
    "https://x",
    Some("Codex refuses this network rule's host: the host names a scheme or a path")
)]
#[case::a_wildcard(
    ProviderAskActionKind::Network,
    "*.example.com",
    Some("Codex refuses this network rule's host: the host holds a wildcard")
)]
#[case::a_file(
    ProviderAskActionKind::FileChange,
    "src/a.rs",
    Some("Codex keeps no project rule on a fileChange ask")
)]
#[tokio::test]
async fn an_allow_codex_would_stretch_or_refuse_leaves_the_file_untouched(
    #[case] action: ProviderAskActionKind,
    #[case] subject: &str,
    #[case] refusal: Option<&str>,
) {
    let project = tempfile::tempdir().expect("a project folder");
    let existing = "prefix_rule(pattern=[\"ls\"], decision=\"allow\")\n";
    fs::create_dir_all(project.path().join(".codex/rules")).expect("the folder is made");
    fs::write(rule_file(project.path()), existing).expect("the rule file is written");

    let outcome = write_codex_project_rule(
        project.path(),
        None,
        &rule(RememberedRuleSense::Allow, action, subject),
    )
    .await;

    assert_eq!(
        outcome
            .err()
            .map(|error: CodexRulesError| error.to_string())
            .as_deref(),
        refusal
    );
    assert_eq!(
        fs::read_to_string(rule_file(project.path())).expect("the rule file reads"),
        existing
    );
}

#[tokio::test]
async fn the_persons_own_rule_files_are_read_as_codex_reads_them() {
    let places = Places::new();
    places.write(
        "project/.codex/rules/team.rules",
        "\"\"\"The team's rules.\"\"\"\n\
         host_executable(name = \"git\", paths = [\"/usr/bin/git\"])\n\
         prefix_rule(pattern = [[\"npm\", \"pnpm\"], \"install\"], match = [\"pnpm install x\"])\n\
         prefix_rule([\"rm\"], \"forbidden\", not_match = [[\"rmdir\"]])\n\
         prefix_rule(pattern = [\"curl\"], decision = \"prompt\")\n\
         prefix_rule(pattern = [\"git\", \"status\"], match = [\"/usr/bin/git status\"])\n\
         network_rule(host = \"Example.COM:443\", protocol = \"https\", decision = \"deny\")\n",
    );
    places.write("project/.codex/rules/notes.txt", "not a rule file");

    assert_eq!(
        places.read_rules().await,
        [
            allow_command("npm install"),
            allow_command("pnpm install"),
            rule(
                RememberedRuleSense::Block,
                ProviderAskActionKind::Command,
                "rm"
            ),
            allow_command("git status"),
            rule(
                RememberedRuleSense::Block,
                ProviderAskActionKind::Network,
                "example.com"
            ),
        ]
    );
}

#[rstest]
#[case::a_syntax_error("prefix_rule(pattern = [\n")]
#[case::a_network_rule_with_no_protocol("network_rule(host = \"a.com\", decision = \"deny\")")]
#[case::a_prefix_rule_with_no_pattern("prefix_rule(decision = \"allow\")")]
#[case::an_unknown_argument("prefix_rule(pattern = [\"ls\"], when = \"always\")")]
#[case::an_argument_past_the_last("prefix_rule([\"ls\"], \"allow\", [], [], \"why\", 3)")]
#[case::a_blank_justification("prefix_rule(pattern = [\"ls\"], justification = \" \")")]
#[case::an_unknown_decision("prefix_rule(pattern = [\"ls\"], decision = \"Allow\")")]
#[case::an_unmatched_example("prefix_rule(pattern = [\"ls\"], match = [\"cat x\"])")]
#[case::a_matched_counterexample("prefix_rule(pattern = [\"ls\"], not_match = [\"ls -l\"])")]
#[case::an_example_that_is_no_command_line("prefix_rule(pattern = [\"ls\"], match = [\"'ls\"])")]
#[case::a_path_the_host_executable_does_not_list(
    "host_executable(name = \"git\", paths = [\"/opt/git\"])\n\
     prefix_rule(pattern = [\"git\"], match = [\"/usr/bin/git status\"])"
)]
#[case::a_host_executable_path_of_another_program(
    "host_executable(name = \"git\", paths = [\"/usr/bin/rg\"])"
)]
#[case::a_name_codex_does_not_know("allow_rule(pattern = [\"ls\"])")]
#[case::a_value_of_another_type("prefix_rule(pattern = [\"ls\"], decision = None)")]
#[case::a_load("load(\"other.star\", \"rule\")")]
#[tokio::test]
async fn a_file_codex_refuses_drops_every_rule(#[case] text: &str) {
    let places = Places::new();
    places.write(
        "project/.codex/rules/a.rules",
        "prefix_rule(pattern = [\"ls\"])\n",
    );
    let refused = places.write("project/.codex/rules/b.rules", text);

    let outcome = places.read(true).await;

    assert!(
        matches!(&outcome, Err(CodexRulesError::Unloadable { path, .. }) if *path == refused),
        "{outcome:?}"
    );
}

#[rstest]
#[case::a_variable("words = [\"cargo\"]\nprefix_rule(pattern = words)", "a variable")]
#[case::a_loop(
    "for tool in [\"cargo\"]:\n    prefix_rule(pattern = [tool])",
    "a loop"
)]
#[case::a_function("def allow(word):\n    prefix_rule(pattern = [word])", "a function")]
#[case::a_computed_argument(
    "prefix_rule(pattern = [\"car\" + \"go\"])",
    "a rule built from a computed value"
)]
#[tokio::test]
async fn a_file_only_running_would_read_is_listed_unread_and_none_of_its_rules(
    #[case] text: &str,
    #[case] reason: &str,
) {
    let places = Places::new();
    places.write(
        "project/.codex/rules/a.rules",
        "prefix_rule(pattern = [\"ls\"])\n",
    );
    let unread = places.write(
        "project/.codex/rules/b.rules",
        &format!("prefix_rule(pattern = [\"cat\"])\n{text}\n"),
    );

    let read = places.read(true).await.expect("the rules read");

    assert_eq!(
        read.rules
            .into_iter()
            .map(|kept| kept.rule)
            .collect::<Vec<_>>(),
        [allow_command("ls")]
    );
    assert_eq!(
        read.unread_files,
        [CodexUnreadRuleFile {
            file: unread,
            reason: reason.to_owned(),
        }]
    );
}

#[tokio::test]
async fn a_broken_file_of_the_persons_own_drops_the_projects_rules_and_an_untrusted_project_has_none()
 {
    let places = Places::new();
    places.write(
        "project/.codex/rules/a.rules",
        "prefix_rule(pattern = [\"ls\"])\n",
    );
    assert_eq!(
        places.read(false).await.expect("nothing is read"),
        CodexProjectRules::default()
    );

    let broken = places.write("home/rules/default.rules", "prefix_rule(pattern = [])\n");

    assert!(matches!(
        places.read(true).await,
        Err(CodexRulesError::Unloadable { path, .. }) if path == broken
    ));
}
