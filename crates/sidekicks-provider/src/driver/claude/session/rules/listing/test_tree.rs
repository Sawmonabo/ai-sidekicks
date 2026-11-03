//! Claude Code's settings files for two account homes, the person's home, the managed folder and
//! one project under one scratch folder, which the rule listing's and the protected paths' tests
//! read.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::settings::PROVIDER_RULE_TEXT_MAX_LEN;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{ClaudeRuleAccountHome, ClaudeRuleHome, ClaudeRuleListingSources, ClaudeRuleProject};

const PROJECT_ID: &str = "0190f3c4-5b6a-7c8d-9e0f-1a2b3c4d5e6f";

/// The scratch folder, each home's settings file where Claude Code reads it with no
/// `CLAUDE_CONFIG_DIR` set.
pub(crate) struct Tree {
    scratch: tempfile::TempDir,
}

impl Tree {
    /// A tree with no file in it.
    pub(crate) fn new() -> Self {
        Self {
            scratch: tempfile::tempdir().expect("a scratch folder"),
        }
    }

    /// `name` under the scratch folder.
    pub(crate) fn path(&self, name: &str) -> PathBuf {
        self.scratch.path().join(name)
    }

    /// The settings file of the home `home`.
    pub(crate) fn home_settings(&self, home: &str) -> PathBuf {
        self.path(home).join(".claude").join("settings.json")
    }

    /// The managed settings' base file.
    pub(crate) fn managed_settings(&self) -> PathBuf {
        self.path("managed").join("managed-settings.json")
    }

    /// The project's shared settings file.
    pub(crate) fn shared_settings(&self) -> PathBuf {
        self.path("project").join(".claude").join("settings.json")
    }

    /// The project's local settings file.
    pub(crate) fn local_settings(&self) -> PathBuf {
        self.path("project")
            .join(".claude")
            .join("settings.local.json")
    }
}

/// Writes `settings` to `file`, its folder made.
pub(crate) fn write(file: &Path, settings: &Value) {
    fs::create_dir_all(file.parent().expect("a settings file sits in a folder"))
        .expect("the folder is made");
    fs::write(
        file,
        serde_json::to_string_pretty(settings).expect("the settings serialize"),
    )
    .expect("the settings file is written");
}

/// The account id `id`.
pub(crate) fn account(id: &str) -> ProviderAccountId {
    ProviderAccountId::new(id.to_owned()).expect("the test's account id")
}

/// The project's mount id.
pub(crate) fn project_id() -> RepoMountId {
    RepoMountId::new(PROJECT_ID).expect("the id is a UUID")
}

/// `file` as the list carries it.
pub(crate) fn wire_path(file: &Path) -> FilesystemPath {
    FilesystemPath::new(file.to_string_lossy().into_owned()).expect("the scratch path fits")
}

/// `text` as a protected path's pattern.
pub(crate) fn pattern(text: &str) -> FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN> {
    FreeFormText::new(text.to_owned()).expect("the test's pattern")
}

/// Account one's home at the first of `homes` and account two's at the second.
pub(crate) fn account_homes<'a>(
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

/// The sources of `account_homes`, the person's home, the managed folder and `projects`.
pub(crate) fn sources<'a>(
    managed_folder: &'a Path,
    account_homes: &'a [ClaudeRuleAccountHome<'a>],
    person_home: &'a Path,
    projects: &'a [ClaudeRuleProject<'a>],
    environment: &'a [(String, String)],
) -> ClaudeRuleListingSources<'a> {
    ClaudeRuleListingSources {
        managed_settings_folder: Some(managed_folder),
        account_homes,
        person: ClaudeRuleHome {
            home: person_home,
            environment,
        },
        projects,
        place: None,
    }
}
