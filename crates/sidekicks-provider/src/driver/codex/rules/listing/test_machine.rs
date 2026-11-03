//! A machine's Codex folders under one scratch folder, which the rule listing's and the protected
//! paths' tests read.

use std::fs;
use std::path::{Path, PathBuf};

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::settings::PROVIDER_RULE_TEXT_MAX_LEN;
use sidekicks_contracts::provider::settings::rules::{
    ProviderStandingRule, ProviderStandingRuleScope,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::PathRules;

use super::{
    CodexRuleAccountHome, CodexRuleListingSources, CodexRuleProject, list_codex_standing_rules,
};
use crate::driver::codex::rules::RULE_EVALUATION_TIME_LIMIT;

/// A call written across lines with a comment inside and odd spacing, which a rendering would not
/// give back as written.
pub(crate) const COMMENTED_CALL: &str = "prefix_rule(\n    # the person's own note\n    pattern = [\"git\",   \
                              \"status\"],\n    decision = \"prompt\",\n)";
/// An allow of `ls`.
pub(crate) const LS_CALL: &str = "prefix_rule(pattern = [\"ls\"])";
/// A forbid of `cat`.
pub(crate) const CAT_CALL: &str = "prefix_rule(pattern = [\"cat\"], decision = \"forbidden\")";
/// An allow of `npm test`.
pub(crate) const NPM_CALL: &str =
    "prefix_rule(pattern = [\"npm\", \"test\"], decision = \"allow\")";
const RM_CALL: &str = "prefix_rule(pattern = [\"rm\"], decision = \"forbidden\")";

/// The trusted project's mount.
pub(crate) const TRUSTED_MOUNT: &str = "01920000-0000-7000-8000-000000000001";
const UNTRUSTED_MOUNT: &str = "01920000-0000-7000-8000-000000000002";

/// A system folder, two account homes, the person's own Codex folder and two projects, the first
/// trusted, all under one scratch folder.
pub(crate) struct Machine {
    scratch: tempfile::TempDir,
    system_folder: PathBuf,
    personal_codex_home: PathBuf,
    account_homes: Vec<CodexRuleAccountHome>,
    projects: Vec<CodexRuleProject>,
}

impl Machine {
    /// The machine with its folders made and no file in them.
    pub(crate) fn new() -> Self {
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

    /// `path` under the scratch folder.
    pub(crate) fn path(&self, path: &str) -> PathBuf {
        self.scratch.path().join(path)
    }

    /// Writes `text` to `file` under the scratch folder and gives its path.
    pub(crate) fn write(&self, file: &str, text: &str) -> PathBuf {
        let path = self.path(file);
        fs::write(&path, text).expect("the file is written");
        path
    }

    /// The text of `file` under the scratch folder.
    pub(crate) fn read(&self, file: &str) -> String {
        fs::read_to_string(self.path(file)).expect("the file is read")
    }

    /// The machine's folders as the listing reads them.
    pub(crate) fn sources(&self) -> CodexRuleListingSources<'_> {
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

    /// A rule file in each layer: the system's holding the commented call and `ls`, each home's
    /// `ls`, the trusted project's `npm test` and the untrusted one's `rm`.
    pub(crate) fn write_rule_files(&self) {
        self.write(
            "system/rules/system.rules",
            &format!("{COMMENTED_CALL}\n{LS_CALL}\n"),
        );
        self.write("home-a/codex/rules/default.rules", &format!("{LS_CALL}\n"));
        self.write("home-b/codex/rules/default.rules", &format!("{LS_CALL}\n"));
        self.write("trusted/.codex/rules/team.rules", &format!("{NPM_CALL}\n"));
        self.write("untrusted/.codex/rules/team.rules", &format!("{RM_CALL}\n"));
    }

    /// The machine's standing rules.
    pub(crate) async fn list(&self) -> Vec<ProviderStandingRule> {
        list_codex_standing_rules(&self.sources())
            .await
            .expect("the rules list")
    }
}

fn account(name: &str) -> ProviderAccountId {
    ProviderAccountId::new(format!("account-{name}")).expect("a valid account id")
}

/// The mount id `id`.
pub(crate) fn mount(id: &str) -> RepoMountId {
    RepoMountId::new(id).expect("a valid mount id")
}

/// The scope of account `name`'s home.
pub(crate) fn home_scope(name: &str) -> ProviderStandingRuleScope {
    ProviderStandingRuleScope::AccountHome {
        account_id: account(name),
    }
}

/// `path` as the list carries it.
pub(crate) fn file_path(path: &Path) -> FilesystemPath {
    FilesystemPath::new(path.to_string_lossy().into_owned()).expect("a valid path")
}

/// `text` as a protected path's pattern.
pub(crate) fn pattern(text: &str) -> FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN> {
    FreeFormText::new(text.to_owned()).expect("a valid pattern")
}
