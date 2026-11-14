use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use rstest::rstest;
use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_contracts::provider::tool_call::ToolCallActionKind;
use sidekicks_platforms::PathRules;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::Notify;

use super::{
    CodexProjectRule, CodexProjectRuleFiles, CodexProjectRuleWrite, CodexRuleSources,
    CodexRulesError, RULE_EVALUATION_TIME_LIMIT, RULE_FILE_LOCK, hold_codex_project_rule_files,
    read_codex_project_rules, remove_codex_project_rule, resolve_lock_key,
    write_codex_project_rule,
};
use crate::driver::codex::delivery::asks::CodexProjectRules;
use crate::project_rule_folders::write_into_project_folders;

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

fn rule_file(project_folder: &Path) -> PathBuf {
    project_folder.join(".codex/rules/sidekicks.rules")
}

// The places a project's sessions read rules from: a system settings folder, a Codex home, a
// project folder and the person's home folder, all under one scratch folder, and how long a read
// may evaluate.
struct Places {
    scratch: tempfile::TempDir,
    evaluation_time_limit: Duration,
}

// The system folder, the Codex home, the project folder and the person's home folder.
type SourcePaths = (PathBuf, PathBuf, PathBuf, PathBuf);

impl Places {
    fn new() -> Self {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        for folder in [
            "system/rules",
            "home/rules",
            "project/.codex/rules",
            "person",
        ] {
            fs::create_dir_all(scratch.path().join(folder)).expect("the folder is made");
        }
        Self {
            scratch,
            evaluation_time_limit: RULE_EVALUATION_TIME_LIMIT,
        }
    }

    fn path(&self, path: &str) -> PathBuf {
        self.scratch.path().join(path)
    }

    fn write(&self, file: &str, text: &str) -> PathBuf {
        let path = self.path(file);
        fs::write(&path, text).expect("the rule file is written");
        path
    }

    // The sources of the project's sessions, run on the Codex home at `codex_home`.
    fn sources<'a>(
        &self,
        paths: &'a SourcePaths,
        is_project_trusted: bool,
    ) -> CodexRuleSources<'a> {
        CodexRuleSources {
            system_folder: &paths.0,
            codex_home: &paths.1,
            project_folder: &paths.2,
            home_folder: &paths.3,
            is_project_trusted,
            path_rules: PathRules::Posix,
            evaluation_time_limit: self.evaluation_time_limit,
        }
    }

    fn paths(&self, codex_home: &str, project_folder: &str) -> SourcePaths {
        (
            self.path("system"),
            self.path(codex_home),
            self.path(project_folder),
            self.path("person"),
        )
    }

    async fn read(
        &self,
        is_project_trusted: bool,
    ) -> Result<Vec<CodexProjectRule>, CodexRulesError> {
        let paths = self.paths("home", "project");
        read_codex_project_rules(&self.sources(&paths, is_project_trusted)).await
    }

    async fn read_rules(&self) -> Vec<ProviderAskRule> {
        let read = self.read(true).await.expect("the rules read");
        read.into_iter().map(|kept| kept.rule).collect()
    }

    async fn write_rule(
        &self,
        git_folder: Option<&Path>,
        rule: &ProviderAskRule,
    ) -> Result<CodexProjectRuleWrite, CodexRulesError> {
        let paths = self.paths("home", "project");
        let holds = hold_codex_project_rule_files(std::slice::from_ref(&paths.2)).await?;
        let hold = holds.hold(&paths.2);
        write_codex_project_rule(&self.sources(&paths, true), git_folder, rule, &hold).await
    }

    async fn remove_rule(&self, rule: &ProviderAskRule) -> Result<(), CodexRulesError> {
        let paths = self.paths("home", "project");
        remove_codex_project_rule(&self.sources(&paths, true), rule).await
    }
}

#[tokio::test]
async fn a_block_replaces_the_allow_and_a_revoke_of_the_last_rule_deletes_the_file() {
    let places = Places::new();
    let project = places.path("project");
    let git_folder = tempfile::tempdir().expect("a git folder");
    let allow = rule(
        RememberedRuleSense::Allow,
        ToolCallActionKind::Network,
        "example.com",
    );
    let block = rule(
        RememberedRuleSense::Block,
        ToolCallActionKind::Network,
        "example.com",
    );
    let command = allow_command("npm  test");

    for written in [&allow, &command, &block] {
        places
            .write_rule(Some(git_folder.path()), written)
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

    places
        .remove_rule(&block)
        .await
        .expect("the block is removed");
    assert_eq!(places.read_rules().await, [allow_command("npm test")]);

    places
        .remove_rule(&command)
        .await
        .expect("the last rule is removed");
    assert!(!rule_file(&project).exists());
}

// A revoke takes the rule out of each project and home file that makes it, every other call kept,
// and refuses, changing nothing, a rule a system file makes or one a call makes beside another
// rule. Killed by a revoke that edits only the daemon's own file, that edits a system file, that
// takes a loop's call and with it the loop's other rules, or that reads a rule no file makes as
// revoked.
#[tokio::test]
async fn a_revoke_takes_the_rule_out_of_each_home_and_project_file_and_never_a_system_one() {
    let places = Places::new();
    let own_file = places.write(
        "project/.codex/rules/sidekicks.rules",
        "prefix_rule(pattern=[\"ls\"])\nprefix_rule(pattern=[\"pnpm\", \"test\"])\n",
    );
    let team_file = places.write(
        "project/.codex/rules/team.rules",
        "prefix_rule(pattern=[\"pnpm\", \"test\"])\nprefix_rule(pattern=[\"make\"])\n",
    );
    let loop_text = "for tool in [\"npm\", \"yarn\"]:\n    prefix_rule(pattern=[tool, \"test\"])\n";
    let loop_file = places.write("project/.codex/rules/loop.rules", loop_text);
    let persons_file = places.write(
        "home/rules/default.rules",
        "prefix_rule(pattern=[\"cargo\", \"build\"], decision=\"allow\")\n\
         prefix_rule(pattern=[\"git\", \"status\"])\n",
    );
    let system_text = "prefix_rule(pattern=[\"go\", \"vet\"], decision=\"allow\")\n";
    let system_file = places.write("system/rules/base.rules", system_text);

    let in_project_files = places.remove_rule(&allow_command("pnpm test")).await;
    let in_persons_file = places.remove_rule(&allow_command("cargo build")).await;
    let in_a_loop = places.remove_rule(&allow_command("npm test")).await;
    let in_system_file = places.remove_rule(&allow_command("go vet")).await;
    let nowhere = places.remove_rule(&allow_command("make install")).await;

    assert!(in_project_files.is_ok(), "{in_project_files:?}");
    assert!(in_persons_file.is_ok(), "{in_persons_file:?}");
    assert!(
        matches!(
            &in_a_loop,
            Err(CodexRulesError::RevokeRefused { path, .. }) if *path == loop_file
        ),
        "{in_a_loop:?}"
    );
    assert!(matches!(
        in_system_file,
        Err(CodexRulesError::RuleInUneditedFile { path }) if path == system_file
    ));
    assert!(matches!(nowhere, Err(CodexRulesError::RuleNotFound)));
    let read = |file: &Path| fs::read_to_string(file).expect("the rule file reads");
    assert_eq!(read(&own_file), "prefix_rule(pattern=[\"ls\"])\n");
    assert_eq!(read(&team_file), "prefix_rule(pattern=[\"make\"])\n");
    assert_eq!(
        read(&persons_file),
        "prefix_rule(pattern=[\"git\", \"status\"])\n"
    );
    assert_eq!(read(&loop_file), loop_text);
    assert_eq!(read(&system_file), system_text);
}

// A revoke across two files whose second edit would leave a file Codex refuses writes neither, so
// the rule's copy in the home file is not lost while the project's still applies. Killed by
// writing each file before the next one's edit is checked.
#[tokio::test]
async fn a_revoke_one_of_whose_edits_would_break_its_file_changes_no_file() {
    let places = Places::new();
    let home_text = "prefix_rule(pattern=[\"cargo\", \"build\"])\n";
    let home_file = places.write("home/rules/default.rules", home_text);
    // The call is a loop's one statement, so taking it out leaves a loop with no body.
    let team_text = "for tool in [\"cargo\"]:\n    prefix_rule(pattern=[tool, \"build\"])\n";
    let team_file = places.write("project/.codex/rules/team.rules", team_text);

    let revoked = places.remove_rule(&allow_command("cargo build")).await;

    assert!(
        matches!(&revoked, Err(CodexRulesError::RevokeRefused { path, .. }) if *path == team_file),
        "{revoked:?}"
    );
    assert_eq!(
        fs::read_to_string(&home_file).expect("the home file reads"),
        home_text
    );
    assert_eq!(
        fs::read_to_string(&team_file).expect("the team file reads"),
        team_text
    );
}

// A block on a command stands in the daemon's own file. An allow for the same command lands in the
// first of two project folders, and while its write into the second is under way, a second
// approval's write to the same file waits. That write fails, the rollback, through the rule files'
// own take-back, puts the file back with the block in it, and only then does the second approval's
// allow land beside the block. Killed by a take-back that only takes the allow's lines out, by one
// that leaves the file as the write left it, and by a write that takes and lets go of the file's
// hold itself.
#[tokio::test]
async fn a_failed_writes_rollback_brings_back_the_rule_it_replaced_before_another_write_lands() {
    let places = Places::new();
    let block = rule(
        RememberedRuleSense::Block,
        ToolCallActionKind::Command,
        "rm",
    );
    places
        .write_rule(None, &block)
        .await
        .expect("the block is written");
    let (codex_home, project) = (places.path("home"), places.path("project"));
    let lock_key = resolve_lock_key(&rule_file(&project))
        .await
        .expect("the file's lock key resolves");
    let project_rules = Arc::new(CodexProjectRuleFiles {
        home_folder: places.path("person"),
        repositories: Arc::new(PortRegistration::new("repositories")),
    });
    let (second_write_began, second_write_fails) =
        (Arc::new(Notify::new()), Arc::new(Notify::new()));

    let first_approval = tokio::spawn({
        let project_rules = Arc::clone(&project_rules);
        let codex_home = codex_home.clone();
        let folders = vec![project.clone(), places.path("second")];
        let began = Arc::clone(&second_write_began);
        let fails = Arc::clone(&second_write_fails);
        async move {
            let holds = hold_codex_project_rule_files(&folders)
                .await
                .expect("the files are held");
            write_into_project_folders(
                &folders,
                &allow_command("rm"),
                |project_folder, rule| {
                    let project_rules = Arc::clone(&project_rules);
                    let codex_home = codex_home.clone();
                    let hold = holds.hold(project_folder);
                    let is_second = project_folder == folders[1];
                    let (began, fails) = (Arc::clone(&began), Arc::clone(&fails));
                    async move {
                        if is_second {
                            began.notify_one();
                            fails.notified().await;
                            return Err(CodexRulesError::ProjectIsCodexHome);
                        }
                        project_rules
                            .write(&codex_home, project_folder, rule, &hold)
                            .await
                    }
                    .boxed()
                },
                |project_folder, _rule, change| {
                    let project_rules = Arc::clone(&project_rules);
                    let hold = holds.hold(project_folder);
                    async move { project_rules.take_back(project_folder, change, &hold).await }
                        .boxed()
                },
                Vec::new(),
            )
            .await
        }
    });
    second_write_began.notified().await;
    // The first approval still holds the file between its write and its rollback.
    let handles = RULE_FILE_LOCK.queue_handle_count(lock_key.clone());
    assert!(handles > 0);
    let second_approval = tokio::spawn({
        let project_rules = Arc::clone(&project_rules);
        let (codex_home, project) = (codex_home.clone(), project.clone());
        async move {
            let holds = hold_codex_project_rule_files(std::slice::from_ref(&project)).await?;
            project_rules
                .write(
                    &codex_home,
                    &project,
                    &allow_command("ls"),
                    &holds.hold(&project),
                )
                .await
        }
    });
    RULE_FILE_LOCK.wait_for_queue_past(lock_key, handles).await;
    second_write_fails.notify_one();

    let failures = first_approval
        .await
        .expect("the first approval ran")
        .expect_err("the second folder's write fails");
    assert!(failures.cleanup_failures().is_empty());
    second_approval
        .await
        .expect("the second approval ran")
        .expect("the second approval's allow is written");
    let rules = places.read_rules().await;
    assert!(rules.contains(&block));
    assert!(rules.contains(&allow_command("ls")));
    assert!(!rules.contains(&allow_command("rm")));
}

#[rstest]
#[case::the_whole_of_git(ToolCallActionKind::Command, "git", None)]
#[case::a_push(ToolCallActionKind::Command, "git push", None)]
#[case::a_branch_change(ToolCallActionKind::Command, "git branch", None)]
#[case::no_word(
    ToolCallActionKind::Command,
    " \u{3000}",
    Some("a command rule names no word")
)]
#[case::a_url(
    ToolCallActionKind::Network,
    "https://x",
    Some(
        "Codex refuses this network rule's host: network_rule host must be a hostname or IP \
         literal (without scheme or path)"
    )
)]
#[case::a_wildcard(
    ToolCallActionKind::Network,
    "*.example.com",
    Some(
        "Codex refuses this network rule's host: network_rule host must be a specific host; \
         wildcards are not allowed"
    )
)]
#[case::a_file(
    ToolCallActionKind::FileChange,
    "src/a.rs",
    Some("Codex keeps no project rule on a fileChange ask")
)]
#[tokio::test]
async fn an_allow_codex_would_stretch_or_refuse_leaves_the_file_untouched(
    #[case] action: ToolCallActionKind,
    #[case] subject: &str,
    #[case] refusal: Option<&str>,
) {
    let places = Places::new();
    let project = places.path("project");
    let existing = "prefix_rule(pattern=[\"ls\"], decision=\"allow\")\n";
    fs::write(rule_file(&project), existing).expect("the rule file is written");

    let outcome = places
        .write_rule(None, &rule(RememberedRuleSense::Allow, action, subject))
        .await;

    assert_eq!(
        outcome
            .err()
            .map(|error: CodexRulesError| error.to_string())
            .as_deref(),
        refusal
    );
    assert_eq!(
        fs::read_to_string(rule_file(&project)).expect("the rule file reads"),
        existing
    );
}

#[tokio::test]
async fn the_rules_a_file_computes_are_read_as_codex_evaluates_them() {
    let places = Places::new();
    places.write(
        "system/rules/base.rules",
        "GIT = \"/usr/bin/git\"\nhost_executable(name = \"git\", paths = [GIT])\n",
    );
    places.write(
        "project/.codex/rules/team.rules",
        "\"\"\"The team's rules.\"\"\"\n\
         prefix_rule(pattern = [[\"npm\", \"pnpm\"], \"install\"], match = [\"pnpm install x\"])\n\
         prefix_rule([\"rm\"], \"forbidden\", not_match = [[\"rmdir\"]])\n\
         prefix_rule(pattern = [\"curl\"], decision = \"prompt\")\n\
         prefix_rule(pattern = [\"git\", \"status\"], match = [\"/usr/bin/git status\"])\n\
         network_rule(host = \"Example.COM:443\", protocol = \"https\", decision = \"deny\")\n\
         TOOL = \"cargo\"\n\
         for verb in [\"test\", \"check\"]:\n    prefix_rule(pattern = [TOOL, verb], \
         decision = \"forbidden\")\n\
         def allow(*words):\n    prefix_rule(pattern = list(words))\n\
         allow(\"ls\", \"-la\")\n",
    );
    // A file may define its own `prefix_rule`, which then makes no rule.
    places.write(
        "project/.codex/rules/z.rules",
        "def prefix_rule(*args, **kwargs):\n    pass\nprefix_rule(\"a\", decision = \"nope\")\n",
    );
    places.write("project/.codex/rules/notes.txt", "not a rule file");

    let block = |subject| {
        rule(
            RememberedRuleSense::Block,
            ToolCallActionKind::Command,
            subject,
        )
    };
    assert_eq!(
        places.read_rules().await,
        [
            allow_command("npm install"),
            allow_command("pnpm install"),
            block("rm"),
            allow_command("git status"),
            rule(
                RememberedRuleSense::Block,
                ToolCallActionKind::Network,
                "example.com"
            ),
            block("cargo test"),
            block("cargo check"),
            allow_command("ls -la"),
        ]
    );
}

#[tokio::test]
async fn a_pattern_of_more_alternatives_than_the_bound_is_listed_once_as_codex_renders_it() {
    let places = Places::new();
    places.write(
        "project/.codex/rules/a.rules",
        "prefix_rule(pattern = [\"a\"] + [[\"b\", \"c\"]] * 40)\n",
    );

    assert_eq!(
        places.read_rules().await,
        [allow_command(&format!("a{}", " [b|c]".repeat(40)))]
    );
}

// An example names its program by a path the system's `host_executable` must list: a path it does
// not list refuses the file, and a `~/` path is read in the person's home folder.
#[rstest]
#[case::a_path_the_system_does_not_list("/opt/bin/git", "/usr/bin/git status", false)]
#[case::a_path_in_the_home_folder("{home}/bin/git", "~/bin/git status", true)]
#[tokio::test]
async fn an_examples_program_path_is_held_to_the_host_executables_of_earlier_files(
    #[case] listed_path: &str,
    #[case] example: &str,
    #[case] is_loaded: bool,
) {
    let places = Places::new();
    let home = places.path("person");
    let listed_path = listed_path.replace("{home}", home.to_str().expect("a UTF-8 scratch path"));
    places.write(
        "system/rules/base.rules",
        &format!("host_executable(name = \"git\", paths = [\"{listed_path}\"])\n"),
    );
    let project_file = places.write(
        "project/.codex/rules/team.rules",
        &format!("prefix_rule(pattern = [\"git\", \"status\"], match = [\"{example}\"])\n"),
    );

    let outcome = places.read(true).await;

    if is_loaded {
        let rules: Vec<ProviderAskRule> = outcome
            .expect("the rules read")
            .into_iter()
            .map(|kept| kept.rule)
            .collect();
        assert_eq!(rules, [allow_command("git status")]);
    } else {
        assert!(
            matches!(
                &outcome,
                Err(CodexRulesError::Unloadable { path, .. }) if *path == project_file
            ),
            "{outcome:?}"
        );
    }
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
#[case::a_misspelled_value_beside_a_variable(
    "X = \"a\"\nprefix_rule(pattern = [X], decision = allw)"
)]
#[case::a_bare_unknown_name("foo")]
#[case::a_top_level_fail("fail(\"stop\")")]
#[case::a_name_another_file_binds("prefix_rule(pattern = [SHARED])")]
#[case::a_value_of_another_type("prefix_rule(pattern = [\"ls\"], decision = None)")]
#[case::a_load("load(\"other.star\", \"rule\")")]
#[tokio::test]
async fn a_file_codex_refuses_drops_every_rule(#[case] text: &str) {
    let places = Places::new();
    places.write(
        "project/.codex/rules/a.rules",
        "SHARED = \"ls\"\nprefix_rule(pattern = [SHARED])\n",
    );
    let refused = places.write("project/.codex/rules/b.rules", text);

    let outcome = places.read(true).await;

    assert!(
        matches!(&outcome, Err(CodexRulesError::Unloadable { path, .. }) if *path == refused),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn a_file_that_runs_past_the_time_limit_drops_every_rule() {
    let mut places = Places::new();
    places.evaluation_time_limit = Duration::from_millis(50);
    let endless = places.write(
        "project/.codex/rules/a.rules",
        "for i in range(2000000000):\n    for j in range(2000000000):\n        pass\n",
    );

    let outcome = tokio::time::timeout(Duration::from_secs(10), places.read(true))
        .await
        .expect("the read stops at the time limit");

    assert!(
        matches!(
            &outcome,
            Err(CodexRulesError::Unloadable { path, reason })
                if *path == endless && reason == "did not finish"
        ),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn a_broken_system_or_persons_file_drops_project_rules_and_an_untrusted_project_has_none() {
    let places = Places::new();
    places.write(
        "project/.codex/rules/a.rules",
        "prefix_rule(pattern = [\"ls\"])\n",
    );
    assert_eq!(places.read(false).await.expect("nothing is read"), []);

    let broken = places.write("home/rules/default.rules", "prefix_rule(pattern = [])\n");
    assert!(matches!(
        places.read(false).await,
        Err(CodexRulesError::Unloadable { path, .. }) if path == broken
    ));
    fs::remove_file(&broken).expect("the broken file goes");

    let broken = places.write("system/rules/base.rules", "prefix_rule(pattern = [])\n");
    assert!(matches!(
        places.read(true).await,
        Err(CodexRulesError::Unloadable { path, .. }) if path == broken
    ));
}

// The project folder is named as written and through a folder beside it, which only resolves to it.
#[rstest]
#[case::as_written("project")]
#[case::once_resolved("person/../project")]
#[tokio::test]
async fn a_project_whose_codex_folder_is_the_codex_home_reads_the_home_once_and_takes_no_rule(
    #[case] project_folder: &str,
) {
    let places = Places::new();
    let persons_file = places.write(
        "project/.codex/rules/sidekicks.rules",
        "prefix_rule(pattern = [\"ls\"])\n",
    );
    let paths = places.paths("project/.codex", project_folder);
    let sources = places.sources(&paths, true);

    assert_eq!(
        read_codex_project_rules(&sources)
            .await
            .expect("the rules read"),
        []
    );
    let holds = hold_codex_project_rule_files(std::slice::from_ref(&paths.2))
        .await
        .expect("the file is held");
    assert!(matches!(
        write_codex_project_rule(
            &sources,
            None,
            &allow_command("npm test"),
            &holds.hold(&paths.2)
        )
        .await,
        Err(CodexRulesError::ProjectIsCodexHome)
    ));
    assert!(matches!(
        remove_codex_project_rule(&sources, &allow_command("ls")).await,
        Err(CodexRulesError::ProjectIsCodexHome)
    ));
    assert_eq!(
        fs::read_to_string(persons_file).expect("the person's file reads"),
        "prefix_rule(pattern = [\"ls\"])\n"
    );
}
