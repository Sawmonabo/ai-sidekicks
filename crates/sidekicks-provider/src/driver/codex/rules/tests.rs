use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rstest::rstest;
use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_platforms::PathRules;
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};

use super::{
    CodexProjectRule, CodexRuleSources, CodexRulesError, RULE_EVALUATION_TIME_LIMIT,
    read_codex_project_rules, remove_codex_project_rule, write_codex_project_rule,
};

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
    ) -> Result<(), CodexRulesError> {
        let paths = self.paths("home", "project");
        write_codex_project_rule(&self.sources(&paths, true), git_folder, rule).await
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

#[tokio::test]
async fn a_revoke_of_a_rule_the_daemons_file_lacks_names_where_it_is_kept() {
    let places = Places::new();
    let own_text = "prefix_rule(pattern=[\"ls\"])\nprefix_rule(pattern=[\"pnpm\", \"test\"])\n";
    let own_file = places.write("project/.codex/rules/sidekicks.rules", own_text);
    let team_file = places.write(
        "project/.codex/rules/team.rules",
        "for tool in [\"npm\", \"pnpm\"]:\n    prefix_rule(pattern=[tool, \"test\"])\n",
    );
    let persons_file = places.write(
        "home/rules/default.rules",
        "prefix_rule(pattern=[\"cargo\", \"build\"], decision=\"allow\")\n",
    );

    // The team's file keeps the rule the daemon's file also holds, so the revoke changes nothing.
    let in_team_file = places.remove_rule(&allow_command("pnpm test")).await;
    let in_persons_file = places.remove_rule(&allow_command("cargo build")).await;
    let nowhere = places.remove_rule(&allow_command("make")).await;

    assert!(matches!(
        in_team_file,
        Err(CodexRulesError::RuleInUneditedFile { path }) if path == team_file
    ));
    assert!(matches!(
        in_persons_file,
        Err(CodexRulesError::RuleInUneditedFile { path }) if path == persons_file
    ));
    assert!(matches!(nowhere, Err(CodexRulesError::RuleNotFound)));

    // A file Codex refuses still keeps the rule its text spells out.
    let refused_file = places.write(
        "system/rules/base.rules",
        "prefix_rule(pattern=[\"go\", \"vet\"], decision=\"allow\")\nundefined_name\n",
    );
    let in_refused_file = places.remove_rule(&allow_command("go vet")).await;
    assert!(matches!(
        in_refused_file,
        Err(CodexRulesError::RuleInUneditedFile { path }) if path == refused_file
    ));
    assert_eq!(
        fs::read_to_string(own_file).expect("the daemon's file reads"),
        own_text
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
    Some(
        "Codex refuses this network rule's host: network_rule host must be a hostname or IP \
         literal (without scheme or path)"
    )
)]
#[case::a_wildcard(
    ProviderAskActionKind::Network,
    "*.example.com",
    Some(
        "Codex refuses this network rule's host: network_rule host must be a specific host; \
         wildcards are not allowed"
    )
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
         for verb in [\"test\", \"check\"]:\n    prefix_rule(pattern = [TOOL, verb], decision = \"forbidden\")\n\
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
            ProviderAskActionKind::Command,
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
                ProviderAskActionKind::Network,
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
            matches!(&outcome, Err(CodexRulesError::Unloadable { path, .. }) if *path == project_file),
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
async fn a_broken_system_or_persons_file_drops_the_projects_rules_and_an_untrusted_project_has_none()
 {
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
    assert!(matches!(
        write_codex_project_rule(&sources, None, &allow_command("npm test")).await,
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
