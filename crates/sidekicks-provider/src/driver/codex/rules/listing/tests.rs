use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::settings::{
    PROVIDER_RULE_TEXT_MAX_LEN, ProviderProtectedPath, ProviderStandingRule,
    ProviderStandingRuleRevokeOutcome, ProviderStandingRuleScope,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::PathRules;

use super::{
    CodexRuleAccountHome, CodexRuleListingSources, CodexRuleProject, list_codex_standing_rules,
    read_codex_protected_paths, revoke_codex_standing_rule,
};
use crate::driver::codex::rules::{CodexRulesError, RULE_EVALUATION_TIME_LIMIT};

// A call written across lines with a comment inside and odd spacing, which a rendering would not
// give back as written.
const COMMENTED_CALL: &str = "prefix_rule(\n    # the person's own note\n    pattern = [\"git\",   \
                              \"status\"],\n    decision = \"prompt\",\n)";
const LS_CALL: &str = "prefix_rule(pattern = [\"ls\"])";
const CAT_CALL: &str = "prefix_rule(pattern = [\"cat\"], decision = \"forbidden\")";
const NPM_CALL: &str = "prefix_rule(pattern = [\"npm\", \"test\"], decision = \"allow\")";
const RM_CALL: &str = "prefix_rule(pattern = [\"rm\"], decision = \"forbidden\")";

const TRUSTED_MOUNT: &str = "01920000-0000-7000-8000-000000000001";
const UNTRUSTED_MOUNT: &str = "01920000-0000-7000-8000-000000000002";

// A system folder, two account homes, the person's own Codex folder and two projects, the first
// trusted, all under one scratch folder.
struct Machine {
    scratch: tempfile::TempDir,
    system_folder: PathBuf,
    personal_codex_home: PathBuf,
    account_homes: Vec<CodexRuleAccountHome>,
    projects: Vec<CodexRuleProject>,
}

impl Machine {
    fn new() -> Self {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let root = scratch.path();
        for folder in [
            "system/rules",
            "home-a/codex/rules",
            "home-b/codex/rules",
            "personal",
            "trusted/.codex/rules",
            "untrusted/.codex/rules",
        ] {
            fs::create_dir_all(root.join(folder)).expect("the folder is made");
        }
        let account_homes = ["a", "b"]
            .into_iter()
            .map(|name| CodexRuleAccountHome {
                account_id: account(name),
                codex_home: root.join(format!("home-{name}/codex")),
                home_folder: root.join(format!("home-{name}")),
            })
            .collect();
        let projects = vec![
            CodexRuleProject {
                repo_mount_id: mount(TRUSTED_MOUNT),
                project_folder: root.join("trusted"),
                is_trusted: true,
            },
            CodexRuleProject {
                repo_mount_id: mount(UNTRUSTED_MOUNT),
                project_folder: root.join("untrusted"),
                is_trusted: false,
            },
        ];
        Self {
            system_folder: root.join("system"),
            personal_codex_home: root.join("personal"),
            scratch,
            account_homes,
            projects,
        }
    }

    fn path(&self, path: &str) -> PathBuf {
        self.scratch.path().join(path)
    }

    fn write(&self, file: &str, text: &str) -> PathBuf {
        let path = self.path(file);
        fs::write(&path, text).expect("the file is written");
        path
    }

    fn read(&self, file: &str) -> String {
        fs::read_to_string(self.path(file)).expect("the file is read")
    }

    fn sources(&self) -> CodexRuleListingSources<'_> {
        CodexRuleListingSources {
            system_folder: &self.system_folder,
            account_homes: &self.account_homes,
            personal_codex_home: &self.personal_codex_home,
            projects: &self.projects,
            place: None,
            path_rules: PathRules::NATIVE,
            evaluation_time_limit: RULE_EVALUATION_TIME_LIMIT,
        }
    }

    // A rule file in each layer: the system's holding the commented call and `ls`, each home's
    // `ls`, the trusted project's `npm test` and the untrusted one's `rm`.
    fn write_rule_files(&self) {
        self.write(
            "system/rules/system.rules",
            &format!("{COMMENTED_CALL}\n{LS_CALL}\n"),
        );
        self.write("home-a/codex/rules/default.rules", &format!("{LS_CALL}\n"));
        self.write("home-b/codex/rules/default.rules", &format!("{LS_CALL}\n"));
        self.write("trusted/.codex/rules/team.rules", &format!("{NPM_CALL}\n"));
        self.write("untrusted/.codex/rules/team.rules", &format!("{RM_CALL}\n"));
    }

    async fn list(&self) -> Vec<ProviderStandingRule> {
        list_codex_standing_rules(&self.sources())
            .await
            .expect("the rules list")
    }
}

fn account(name: &str) -> ProviderAccountId {
    ProviderAccountId::new(format!("account-{name}")).expect("a valid account id")
}

fn mount(id: &str) -> RepoMountId {
    RepoMountId::new(id).expect("a valid mount id")
}

fn home_scope(name: &str) -> Option<ProviderStandingRuleScope> {
    Some(ProviderStandingRuleScope::AccountHome {
        account_id: account(name),
    })
}

fn file_path(path: &Path) -> FilesystemPath {
    FilesystemPath::new(path.to_string_lossy().into_owned()).expect("a valid path")
}

fn pattern(text: &str) -> FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN> {
    FreeFormText::new(text.to_owned()).expect("a valid pattern")
}

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
            expected(home_scope("a"), &home_a.to_string_lossy(), "allow", LS_CALL),
            expected(home_scope("b"), &home_b.to_string_lossy(), "allow", LS_CALL),
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
            rule.scope == home_scope("a")
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
            .find(|rule| rule.scope == home_scope("a") && rule.text.as_str() == revoked_text)
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

// The protected paths are the deny entries of the profile each config file selects, a scoped
// entry's subpath joined to its root, from the homes, the person's own folder and the trusted
// project; a profile no file selects and the untrusted project give none.
#[tokio::test]
async fn reads_the_denies_of_the_selected_profile_from_each_trusted_config() {
    let machine = Machine::new();
    let strict = "[permissions.strict.filesystem]\n\"~/.ssh\" = \"deny\"\n\":minimal\" = \
                  \"read\"\n\n[permissions.strict.filesystem.\":workspace_roots\"]\n\".\" = \
                  \"write\"\n\"**/*.env\" = \"deny\"\n\n[permissions.loose.filesystem]\n\"~/.aws\" \
                  = \"deny\"\n";
    let home_a = machine.write(
        "home-a/codex/config.toml",
        &format!("default_permissions = \"strict\"\n{strict}"),
    );
    machine.write(
        "home-b/codex/config.toml",
        &format!("default_permissions = \"other\"\n{strict}"),
    );
    let personal = machine.write(
        "personal/config.toml",
        "default_permissions = \"strict\"\n[permissions.strict.filesystem]\n\"~/.gnupg\" = \
         \"deny\"\n",
    );
    let project_config = "default_permissions = \"strict\"\n[permissions.strict.filesystem]\n\
                          \"secrets\" = \"deny\"\n";
    let trusted = machine.write("trusted/.codex/config.toml", project_config);
    machine.write("untrusted/.codex/config.toml", project_config);

    let entries = read_codex_protected_paths(&machine.sources())
        .await
        .expect("the protected paths read");

    let global = |text: &str, path: &Path| ProviderProtectedPath::Global {
        pattern: pattern(text),
        place: None,
        source_path: file_path(path),
    };
    let expected = [
        global("~/.ssh", &home_a),
        global(":workspace_roots/**/*.env", &home_a),
        global("~/.gnupg", &personal),
        ProviderProtectedPath::Project {
            pattern: pattern("secrets"),
            source_path: file_path(&trusted),
            repo_mount_id: mount(TRUSTED_MOUNT),
        },
    ];
    assert_eq!(entries.len(), expected.len(), "{entries:?}");
    for entry in &expected {
        assert!(
            entries.contains(entry),
            "{entry:?} is listed in {entries:?}"
        );
    }
}
