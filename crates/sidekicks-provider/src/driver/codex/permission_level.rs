//! What each permission level sends Codex: the permission profile a conversation runs under, who
//! reviews its asks, when it asks at all, and how connector tools ask by default. Below YOLO every
//! profile is the daemon's own, defined inline in each conversation's `config` under a name unique
//! to the repository; YOLO is Codex's own full access, never the legacy sandbox member, which
//! leaves the conversation with no active profile.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use sidekicks_contracts::provider::driver::capabilities::ProviderMode;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::text::FreeFormText;
use strum::VariantArray;

/// Codex's own full-access profile, which YOLO selects.
const CODEX_FULL_ACCESS_PROFILE: &str = ":danger-full-access";

/// Hex digits of the repository root's SHA-256 a profile name keeps: enough that two repositories
/// the person works in never share a name.
const REPOSITORY_HASH_LENGTH: usize = 16;

/// Who Codex routes an ask to (`ApprovalsReviewer`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CodexApprovalsReviewer {
    /// The person, through the daemon's approvals.
    User,
    /// Codex's own automatic reviewer.
    AutoReview,
}

/// When Codex asks before acting (`AskForApproval`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CodexApprovalPolicy {
    /// It asks when a call needs approval.
    OnRequest,
    /// It never asks; a refused call fails.
    Never,
}

/// How Codex approves a connector's tool calls (`AppToolApproval`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CodexConnectorApprovalMode {
    /// A tool not marked read-only asks.
    Writes,
    /// Every tool runs unasked.
    Approve,
}

/// One filesystem entry's access, as Codex's profiles spell it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CodexFilesystemAccess {
    /// Readable only.
    Read,
    /// Readable and writable.
    Write,
    /// Neither.
    Deny,
}

/// The built-in profile a daemon profile extends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum CodexProfileBase {
    /// Reads anywhere, writes nowhere.
    #[serde(rename = ":read-only")]
    ReadOnly,
    /// Writes inside the workspace.
    #[serde(rename = ":workspace")]
    Workspace,
}

/// One profile as a conversation's `config.permissions` defines it. Each path appears once, the
/// last entry written for it winning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct CodexPermissionProfile {
    /// The built-in profile it extends.
    pub(crate) extends: CodexProfileBase,
    /// Each entry's access, by its absolute path or Codex's own folder name.
    pub(crate) filesystem: BTreeMap<String, CodexFilesystemAccess>,
}

/// The folders and denies one conversation's profiles are built from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexProfileFolders {
    /// The conversation's working folder: its worktree, absolute.
    pub(crate) working_directory: PathBuf,
    /// The repository's git folder, absolute: the common one for a linked worktree. `None`
    /// outside a repository.
    pub(crate) git_common_folder: Option<PathBuf>,
    /// The credential paths no level may read, absolute.
    pub(crate) deny_paths: Vec<PathBuf>,
}

/// The thread members one level sets on start, resume, fork and a level move.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexLevelSettings {
    /// The profile id the thread selects.
    pub(crate) permissions: String,
    /// When Codex asks.
    pub(crate) approval_policy: CodexApprovalPolicy,
    /// Who answers its asks.
    pub(crate) approvals_reviewer: CodexApprovalsReviewer,
}

/// The connectors' defaults a level sets, as `apps._default` members only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct CodexConnectorDefaults {
    /// How a connector's tools ask by default.
    #[serde(rename = "apps._default.default_tools_approval_mode")]
    pub(crate) default_tools_approval_mode: CodexConnectorApprovalMode,
    /// Who answers a connector's ask by default.
    #[serde(rename = "apps._default.approvals_reviewer")]
    pub(crate) approvals_reviewer: CodexApprovalsReviewer,
}

/// The `config` members that define every daemon profile and select one level's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct CodexPermissionConfig {
    /// Every daemon profile, by its id.
    pub(crate) permissions: BTreeMap<String, CodexPermissionProfile>,
    /// The id of the profile the level selects.
    pub(crate) default_permissions: String,
}

/// The profile id a level selects for one repository: `sidekicks-<level>-<hash of the repository
/// root>` below YOLO, so a profile the person defined never collides with it, and Codex's full
/// access at YOLO.
pub(crate) fn compose_codex_profile_name(
    level: PermissionLevel,
    folders: &CodexProfileFolders,
) -> String {
    match level {
        PermissionLevel::Yolo => CODEX_FULL_ACCESS_PROFILE.to_owned(),
        PermissionLevel::Readonly
        | PermissionLevel::Ask
        | PermissionLevel::Reviewed
        | PermissionLevel::Sandboxed => {
            // The repository root is the common git folder's parent, so every worktree of one
            // repository shares its profiles; outside a repository it is the working folder.
            let repository_root = folders
                .git_common_folder
                .as_deref()
                .map_or(folders.working_directory.as_path(), |git_common_folder| {
                    git_common_folder.parent().unwrap_or(git_common_folder)
                });
            let mut hash = base16ct::lower::encode_string(&Sha256::digest(
                repository_root.to_string_lossy().as_bytes(),
            ));
            hash.truncate(REPOSITORY_HASH_LENGTH);
            format!("sidekicks-{}-{hash}", <&'static str>::from(level))
        }
    }
}

/// Who answers Codex's asks at a level: Codex's own automatic reviewer at Reviewed, which is what
/// that level means, and the person, through the daemon's approvals, at every other level.
pub(crate) fn compose_codex_approvals_reviewer(level: PermissionLevel) -> CodexApprovalsReviewer {
    match level {
        PermissionLevel::Reviewed => CodexApprovalsReviewer::AutoReview,
        PermissionLevel::Readonly
        | PermissionLevel::Ask
        | PermissionLevel::Sandboxed
        | PermissionLevel::Yolo => CodexApprovalsReviewer::User,
    }
}

/// The members a level sends on a thread for one repository.
pub(crate) fn compose_codex_level_settings(
    level: PermissionLevel,
    folders: &CodexProfileFolders,
) -> CodexLevelSettings {
    // Sandboxed never asks: a command the profile refuses fails with Codex's own sentence. YOLO
    // asks on request so Codex's own forced-removal check still reaches the person.
    let approval_policy = match level {
        PermissionLevel::Sandboxed => CodexApprovalPolicy::Never,
        PermissionLevel::Readonly
        | PermissionLevel::Ask
        | PermissionLevel::Reviewed
        | PermissionLevel::Yolo => CodexApprovalPolicy::OnRequest,
    };
    CodexLevelSettings {
        permissions: compose_codex_profile_name(level, folders),
        approval_policy,
        approvals_reviewer: compose_codex_approvals_reviewer(level),
    }
}

/// The connectors' defaults a level sets, only as `apps._default`, so a reviewer or approval mode
/// the person set for one app or tool keeps its own: `writes` below YOLO, so a tool not marked
/// read-only asks, and `approve` at YOLO. Codex reads a connector ask's reviewer from the `apps`
/// table before the conversation's, so it carries the level's too.
pub(crate) fn compose_codex_connector_defaults(level: PermissionLevel) -> CodexConnectorDefaults {
    let default_tools_approval_mode = match level {
        PermissionLevel::Yolo => CodexConnectorApprovalMode::Approve,
        PermissionLevel::Readonly
        | PermissionLevel::Ask
        | PermissionLevel::Reviewed
        | PermissionLevel::Sandboxed => CodexConnectorApprovalMode::Writes,
    };
    CodexConnectorDefaults {
        default_tools_approval_mode,
        approvals_reviewer: compose_codex_approvals_reviewer(level),
    }
}

/// The `config` members that define every daemon profile and select the level's. All four are
/// defined on every conversation, so a later level move selects one its config already holds;
/// `default_permissions` sits in `config` too, since a profile selected only through the thread
/// member breaks a service-wide tool-server reload.
pub(crate) fn compose_codex_permission_config(
    level: PermissionLevel,
    folders: &CodexProfileFolders,
) -> CodexPermissionConfig {
    CodexPermissionConfig {
        permissions: PermissionLevel::VARIANTS
            .iter()
            .filter_map(|&profile_level| {
                let profile = compose_codex_daemon_profile(profile_level, folders)?;
                Some((compose_codex_profile_name(profile_level, folders), profile))
            })
            .collect(),
        default_permissions: compose_codex_profile_name(level, folders),
    }
}

/// The daemon's own profile for a level, or `None` at YOLO, which runs under Codex's full access.
/// The deny paths are written last, so a deny wins over every other entry for its path.
fn compose_codex_daemon_profile(
    level: PermissionLevel,
    folders: &CodexProfileFolders,
) -> Option<CodexPermissionProfile> {
    // `:workspace` makes both temporary folders writable by itself; they stay readable only, so
    // nothing outside the worktree is written where the daemon's own data could stand.
    let workspace_base = [
        (":tmpdir".to_owned(), CodexFilesystemAccess::Read),
        (":slash_tmp".to_owned(), CodexFilesystemAccess::Read),
    ];
    let (extends, entries) = match level {
        PermissionLevel::Readonly => (CodexProfileBase::ReadOnly, Vec::new()),
        PermissionLevel::Ask | PermissionLevel::Reviewed => {
            (CodexProfileBase::Workspace, workspace_base.to_vec())
        }
        // The one root a posture names, the git folder, is the repository entries' own.
        PermissionLevel::Sandboxed => {
            let mut entries = workspace_base.to_vec();
            entries.extend(compose_repository_entries(folders));
            (CodexProfileBase::Workspace, entries)
        }
        PermissionLevel::Yolo => return None,
    };
    let denies = folders
        .deny_paths
        .iter()
        .map(|denied| (compose_path_key(denied), CodexFilesystemAccess::Deny));
    let mut filesystem = BTreeMap::new();
    for (path, access) in entries.into_iter().chain(denies) {
        filesystem.insert(path, access);
    }
    Some(CodexPermissionProfile {
        extends,
        filesystem,
    })
}

/// The per-repository entries at Sandboxed: the git folder is writable so a commit lands without
/// asking, while its `hooks` and `config`, and a linked worktree's `.git` pointer, stay read-only,
/// so no agent plants a hook or repoints the hooks path.
fn compose_repository_entries(
    folders: &CodexProfileFolders,
) -> Vec<(String, CodexFilesystemAccess)> {
    let Some(git_common_folder) = folders.git_common_folder.as_deref() else {
        return Vec::new();
    };
    let pointer = folders.working_directory.join(".git");
    let mut entries = vec![
        (
            compose_path_key(git_common_folder),
            CodexFilesystemAccess::Write,
        ),
        (
            compose_path_key(&git_common_folder.join("hooks")),
            CodexFilesystemAccess::Read,
        ),
        (
            compose_path_key(&git_common_folder.join("config")),
            CodexFilesystemAccess::Read,
        ),
    ];
    // In a plain checkout the `.git` folder is the git folder itself and stays writable.
    if pointer != git_common_folder {
        entries.push((compose_path_key(&pointer), CodexFilesystemAccess::Read));
    }
    entries
}

fn compose_path_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The levels a Codex session can run at, each named by the profile it selects: Codex's full
/// access at YOLO, and below it the daemon's profile name, which each repository's hash completes.
pub(crate) fn list_codex_modes() -> Vec<ProviderMode> {
    PermissionLevel::VARIANTS
        .iter()
        .map(|&level| {
            let name = match level {
                PermissionLevel::Yolo => CODEX_FULL_ACCESS_PROFILE.to_owned(),
                PermissionLevel::Readonly
                | PermissionLevel::Ask
                | PermissionLevel::Reviewed
                | PermissionLevel::Sandboxed => {
                    format!("sidekicks-{}", <&'static str>::from(level))
                }
            };
            ProviderMode {
                id: FreeFormText::new(<&'static str>::from(level).to_owned())
                    .expect("a level's name is a short word"),
                name: FreeFormText::new(name).expect("a level's profile name is a short word"),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use sidekicks_contracts::session::controls::methods::PermissionLevel;

    use super::{
        CodexFilesystemAccess, CodexProfileFolders, compose_codex_permission_config,
        compose_codex_profile_name,
    };

    const DAEMON_PROFILE_LEVELS: [PermissionLevel; 4] = [
        PermissionLevel::Readonly,
        PermissionLevel::Ask,
        PermissionLevel::Reviewed,
        PermissionLevel::Sandboxed,
    ];

    fn key(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn folders(working_directory: &Path, deny_paths: Vec<PathBuf>) -> CodexProfileFolders {
        CodexProfileFolders {
            working_directory: working_directory.to_path_buf(),
            git_common_folder: Some(PathBuf::from("/work/repo/.git")),
            deny_paths,
        }
    }

    #[test]
    fn worktrees_of_one_repository_share_a_profile_name() {
        let checkout = folders(Path::new("/work/repo"), Vec::new());
        let worktree = folders(Path::new("/work/worktrees/feature"), Vec::new());

        assert_eq!(
            compose_codex_profile_name(PermissionLevel::Ask, &checkout),
            compose_codex_profile_name(PermissionLevel::Ask, &worktree)
        );
    }

    #[test]
    fn sandboxed_keeps_the_hook_paths_read_only_and_a_plain_checkouts_git_folder_writable() {
        let git_common_folder = Path::new("/work/repo/.git");
        let worktree_directory = Path::new("/work/worktrees/feature");
        let linked = folders(worktree_directory, Vec::new());
        let plain = folders(Path::new("/work/repo"), Vec::new());
        let sandboxed = |profile_folders: &CodexProfileFolders| {
            let name = compose_codex_profile_name(PermissionLevel::Sandboxed, profile_folders);
            compose_codex_permission_config(PermissionLevel::Sandboxed, profile_folders)
                .permissions
                .remove(&name)
                .unwrap()
                .filesystem
        };

        let linked = sandboxed(&linked);
        assert_eq!(
            linked[&key(git_common_folder)],
            CodexFilesystemAccess::Write
        );
        assert_eq!(
            linked[&key(&git_common_folder.join("hooks"))],
            CodexFilesystemAccess::Read
        );
        assert_eq!(
            linked[&key(&git_common_folder.join("config"))],
            CodexFilesystemAccess::Read
        );
        assert_eq!(
            linked[&key(&worktree_directory.join(".git"))],
            CodexFilesystemAccess::Read
        );

        let plain = sandboxed(&plain);
        assert_eq!(plain[&key(git_common_folder)], CodexFilesystemAccess::Write);
        assert_eq!(
            plain[&key(&git_common_folder.join("hooks"))],
            CodexFilesystemAccess::Read
        );
    }

    #[test]
    fn every_daemon_profile_denies_every_deny_path_even_one_a_repository_entry_names() {
        let git_common_folder = PathBuf::from("/work/repo/.git");
        let deny_paths = vec![
            PathBuf::from("/home/person/.ssh"),
            git_common_folder.join("config"),
            git_common_folder.clone(),
        ];
        let worktree = folders(Path::new("/work/worktrees/feature"), deny_paths.clone());

        let config = compose_codex_permission_config(PermissionLevel::Yolo, &worktree);

        assert_eq!(config.permissions.len(), DAEMON_PROFILE_LEVELS.len());
        for level in DAEMON_PROFILE_LEVELS {
            let filesystem =
                &config.permissions[&compose_codex_profile_name(level, &worktree)].filesystem;
            for denied in &deny_paths {
                assert_eq!(
                    filesystem[&key(denied)],
                    CodexFilesystemAccess::Deny,
                    "{level:?} lets {} through",
                    denied.display()
                );
            }
        }
    }
}
