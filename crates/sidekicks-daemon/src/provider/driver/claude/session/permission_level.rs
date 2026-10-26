//! The permission levels a Claude Code session can run at: the permission mode each runs in, the
//! level a new session starts at from Claude Code's own settings, and the live move between levels,
//! which sends the level's mode, then the session's whole permission rules and its command sandbox,
//! all from the process's next request, with no relaunch.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;
use sidekicks_contracts::provider::driver::capabilities::ProviderMode;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{PathRules, Spawner};
use strum::VariantArray;

use crate::ipc::domain_error::DomainError;
use crate::mutex_lock::lock;
use crate::policy::ask_rule::ProviderAskRule;
use crate::provider::driver::CommandSandboxAvailability;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::session::errors::record_unheard_claude_failure;
use crate::provider::driver::claude::session::ignored_settings::{
    ClaudeSettingsReadError, find_claude_setting, read_claude_managed_setting,
};
use crate::provider::driver::claude::session::permissions::{
    ClaudePermissionsError, compose_live_claude_permissions,
};
use crate::provider::driver::claude::session::rules::{
    CLAUDE_SHARED_SETTINGS_FILE, ClaudeProjectFolder, local_settings_path,
    resolve_claude_local_settings_file, settings_path,
};
use crate::provider::driver::claude::session::settings_file::read_claude_settings_file;
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings, ClaudePermissionMode,
};
use crate::provider::driver::claude::spawn::settings::compose_claude_sandbox_settings;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::diagnostics::DriverDiagnosticKind;
use crate::provider::driver::session_control::{
    UpdatePermissionLevelParams, permission_level_not_offered,
};
use crate::settle_all::{SettleFailures, settle_all};

// The key a session's starting mode is read from.
const DEFAULT_MODE_KEY_PATH: [&str; 2] = ["permissions", "defaultMode"];

/// Which settings file set the session's starting mode: Claude Code takes some modes only from a
/// file the person or an administrator controls, never from the project's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeSettingsSource {
    /// An administrator's managed file.
    Managed,
    /// The project's local or shared file.
    Project,
    /// The person's own file.
    Person,
}

/// The level and mode a new session starts at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the session create starts a session at this level and mode"
    )
)]
pub(crate) struct ClaudeStartingLevel {
    /// The level.
    pub(crate) level: PermissionLevel,
    /// Plan where Claude Code itself would start planning, else Build.
    pub(crate) session_mode: SessionMode,
}

/// Where a new session's starting mode is read from: the managed folder, the session's working
/// folder and the person's own home, never an account home the daemon made.
pub(crate) struct ClaudeStartingLevelSources<'a> {
    /// The folder Claude Code reads an administrator's settings from; `None` where it names none.
    pub(crate) managed_settings_folder: Option<&'a Path>,
    /// The session's working folder, with what Claude Code reads to place its local settings.
    pub(crate) project_folder: &'a ClaudeProjectFolder<'a>,
    /// The person's own home folder.
    pub(crate) home_folder: &'a Path,
    /// How the place the session runs in spells paths.
    pub(crate) path_rules: PathRules,
}

/// Why a live level move was refused or failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeLevelMoveError {
    /// Claude Code cannot run the session at the level on its model or this system
    /// (`session.permissionLevel.notOffered`); nothing was sent.
    #[error(transparent)]
    NotOffered(DomainError),
    /// The rules could not be composed, or Claude Code refused or did not answer a request.
    #[error(transparent)]
    Permissions(#[from] ClaudePermissionsError),
}

impl From<ClaudeLevelMoveError> for DriverError {
    /// A level the session cannot run keeps its refusal, and a failed composition or send its own
    /// answer.
    fn from(error: ClaudeLevelMoveError) -> Self {
        match error {
            ClaudeLevelMoveError::NotOffered(refusal) => Self::Refused(refusal),
            ClaudeLevelMoveError::Permissions(error) => error.into(),
        }
    }
}

/// The permission mode Claude Code runs a level in, `--permission-mode` at a start and
/// `set_permission_mode` on a move; a session with no level runs in Read-only's.
pub(crate) fn claude_permission_mode_for(level: Option<PermissionLevel>) -> ClaudePermissionMode {
    match level {
        None | Some(PermissionLevel::Readonly) => ClaudePermissionMode::Default,
        Some(PermissionLevel::Ask) => ClaudePermissionMode::AcceptEdits,
        Some(PermissionLevel::Reviewed) => ClaudePermissionMode::Auto,
        Some(PermissionLevel::Sandboxed) => ClaudePermissionMode::DontAsk,
        Some(PermissionLevel::Yolo) => ClaudePermissionMode::BypassPermissions,
    }
}

/// The levels a Claude Code session can run at on this system, each named by the mode it runs in;
/// Sandboxed only where `can_run_sandbox`, the descriptor's command-sandbox check, holds.
pub(crate) fn list_claude_modes(can_run_sandbox: bool) -> Vec<ProviderMode> {
    PermissionLevel::VARIANTS
        .iter()
        .filter(|&&level| is_offered_on_system(level, can_run_sandbox))
        .map(|&level| ProviderMode {
            id: FreeFormText::new(<&str>::from(level).to_owned())
                .expect("a level's name is a short word"),
            name: FreeFormText::new(claude_permission_mode_name(claude_permission_mode_for(
                Some(level),
            )))
            .expect("a permission mode's name is a short word"),
        })
        .collect()
}

/// Whether Claude Code's command sandbox runs in the place `spawn_environment` and
/// `working_folder` name, checked on the spawner thread, which the namespace check needs. A check
/// that fails is recorded, against `session_id` where one is named, and answers no, so Sandboxed is
/// never offered on a guess.
pub(crate) async fn read_claude_sandbox_support(
    spawner: &Spawner,
    spawn_environment: &[(String, String)],
    working_folder: &Path,
    session_id: Option<SessionId>,
) -> bool {
    let environment = spawn_environment.to_vec();
    let folder = working_folder.to_path_buf();
    let checked = spawner
        .run(move || DESCRIPTOR.can_run_command_sandbox(&environment, &folder, &[]))
        .await
        .and_then(|answer| answer);
    match checked {
        Ok(CommandSandboxAvailability::Runs) => true,
        // Claude Code has no service of its own to ask, so its descriptor never answers that.
        Ok(
            CommandSandboxAvailability::CannotRun(_) | CommandSandboxAvailability::AskTheService,
        ) => false,
        Err(error) => {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                session_id,
                "the command sandbox check",
                &error,
            );
            false
        }
    }
}

/// Whether a process on `running_model` can run at `level`: Reviewed only on a model whose
/// `initialize` reply offered auto mode, `auto_mode_models`, and Sandboxed only where
/// `can_run_sandbox`.
pub(crate) fn can_run_claude_level(
    level: PermissionLevel,
    running_model: &str,
    auto_mode_models: &HashSet<String>,
    can_run_sandbox: bool,
) -> bool {
    is_offered_on_system(level, can_run_sandbox)
        && (level != PermissionLevel::Reviewed || auto_mode_models.contains(running_model))
}

/// Moves a live session to the posture `params` names, at its level and writable roots: its
/// permission mode, unless the session plans, then its whole permission rules with `session_rules`
/// in force and its command sandbox, on at Sandboxed and removed at every other level, then the
/// posture it runs at. Refused before anything is sent for a level the model or system cannot
/// run.
pub(crate) async fn move_claude_permission_level(
    live: &LiveClaudeSession,
    params: &UpdatePermissionLevelParams,
    can_run_sandbox: bool,
    session_rules: &[ProviderAskRule],
    path_rules: PathRules,
) -> Result<(), ClaudeLevelMoveError> {
    let posture = &params.execution_posture;
    let level = posture.permission_level();
    let (session_mode, is_runnable) = {
        let settings = lock(&live.settings);
        let is_runnable = can_run_claude_level(
            level,
            &settings.running_model,
            &live.initialize.auto_mode_models,
            can_run_sandbox,
        );
        (settings.session_mode, is_runnable)
    };
    if !is_runnable {
        return Err(ClaudeLevelMoveError::NotOffered(
            permission_level_not_offered(level),
        ));
    }
    let permissions = compose_live_claude_permissions(
        live,
        posture.writable_roots(),
        Some(level),
        session_rules,
        path_rules,
    )
    .map_err(ClaudePermissionsError::Compose)?;
    // A planning session stays in plan mode; the level's own mode returns when it builds again.
    if session_mode == SessionMode::Build {
        live.channel
            .send_control_request(ClaudeControlRequest::SetPermissionMode {
                mode: claude_permission_mode_for(Some(level)),
            })
            .await
            .map_err(ClaudePermissionsError::from)?;
    }
    live.channel
        .send_control_request(ClaudeControlRequest::ApplyFlagSettings {
            settings: ClaudeFlagSettings {
                permissions: Some(permissions),
                // `null` removes the key from the flag-settings layer, so leaving Sandboxed turns
                // the sandbox off.
                sandbox: Some(
                    (level == PermissionLevel::Sandboxed)
                        .then(|| compose_claude_sandbox_settings(posture.writable_roots())),
                ),
                ..ClaudeFlagSettings::default()
            },
        })
        .await
        .map_err(ClaudePermissionsError::from)?;
    lock(&live.settings).execution_posture = Some(posture.clone());
    Ok(())
}

/// The level a new session starts at from `permissions.defaultMode`, read by Claude Code's own
/// precedence: the managed settings, then the project's local and shared files, then the person's
/// own; `can_run` answers whether the session's provider, account and model run a level. Fails
/// with every settings file that could not be read, since it may have set the mode.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the session create reads its starting level through it"
    )
)]
pub(crate) async fn read_claude_starting_level(
    sources: &ClaudeStartingLevelSources<'_>,
    can_run: impl Fn(PermissionLevel) -> bool,
) -> Result<ClaudeStartingLevel, SettleFailures<ClaudeSettingsReadError>> {
    if let Some(managed_settings_folder) = sources.managed_settings_folder {
        let managed =
            read_claude_managed_setting(managed_settings_folder, &DEFAULT_MODE_KEY_PATH, |value| {
                value.as_str().map(str::to_owned)
            })
            .await;
        settle_all(
            managed
                .failures
                .into_iter()
                .map(Err)
                .collect::<Vec<Result<(), _>>>(),
            "reading Claude Code's managed settings",
        )?;
        if let Some(setting) = managed.deciding {
            return Ok(claude_starting_level(
                Some((ClaudeSettingsSource::Managed, &setting.value)),
                can_run,
            ));
        }
    }
    let working_folder = sources.project_folder.working_folder;
    let local_settings = resolve_claude_local_settings_file(
        sources.project_folder,
        sources.home_folder,
        sources.path_rules,
    )
    .path;
    let working_local_settings = local_settings_path(working_folder);
    let mut files = vec![(ClaudeSettingsSource::Project, local_settings.clone())];
    // Claude Code reads the folder's own local file too where it keeps the project's elsewhere.
    if working_local_settings != local_settings {
        files.push((ClaudeSettingsSource::Project, working_local_settings));
    }
    files.push((
        ClaudeSettingsSource::Project,
        settings_path(working_folder, CLAUDE_SHARED_SETTINGS_FILE),
    ));
    files.push((
        ClaudeSettingsSource::Person,
        settings_path(sources.home_folder, CLAUDE_SHARED_SETTINGS_FILE),
    ));
    for (source, file) in files {
        let settings = read_claude_settings_file(&file).await.map_err(|failure| {
            SettleFailures::One(ClaudeSettingsReadError {
                path: file.clone(),
                failure,
            })
        })?;
        let mode = settings
            .as_ref()
            .and_then(|settings| find_claude_setting(settings, &DEFAULT_MODE_KEY_PATH))
            .and_then(Value::as_str);
        if let Some(mode) = mode {
            return Ok(claude_starting_level(Some((source, mode)), can_run));
        }
    }
    Ok(claude_starting_level(None, can_run))
}

// The level and mode `default_mode` starts a session at, from the file that set it, moved to the
// nearest more careful level `can_run` holds for: Claude Code ignores `auto` and
// `bypassPermissions` in a project's own files, starting as with nothing set and in its manual
// mode, and a mode no level matches starts at the most careful level.
fn claude_starting_level(
    default_mode: Option<(ClaudeSettingsSource, &str)>,
    can_run: impl Fn(PermissionLevel) -> bool,
) -> ClaudeStartingLevel {
    let (level, session_mode) = match default_mode {
        None => (PermissionLevel::Yolo, SessionMode::Build),
        Some((source, mode)) => match (mode, source) {
            ("acceptEdits", _) => (PermissionLevel::Ask, SessionMode::Build),
            ("auto", ClaudeSettingsSource::Project) => (PermissionLevel::Yolo, SessionMode::Build),
            ("auto", ClaudeSettingsSource::Managed | ClaudeSettingsSource::Person) => {
                (PermissionLevel::Reviewed, SessionMode::Build)
            }
            ("dontAsk", _) => (PermissionLevel::Sandboxed, SessionMode::Build),
            ("bypassPermissions", ClaudeSettingsSource::Managed | ClaudeSettingsSource::Person) => {
                (PermissionLevel::Yolo, SessionMode::Build)
            }
            ("plan", _) => (PermissionLevel::Readonly, SessionMode::Plan),
            // `default`, `manual`, a project's `bypassPermissions` and any unknown mode.
            (_, _) => (PermissionLevel::Readonly, SessionMode::Build),
        },
    };
    let rank = PermissionLevel::VARIANTS
        .iter()
        .position(|listed| *listed == level)
        .expect("every level is in the level list");
    ClaudeStartingLevel {
        // The list runs from the most careful level, so the nearest more careful is the last
        // runnable one at or before it.
        level: PermissionLevel::VARIANTS[..=rank]
            .iter()
            .rev()
            .copied()
            .find(|&candidate| can_run(candidate))
            .unwrap_or(PermissionLevel::Readonly),
        session_mode,
    }
}

// Whether this system offers `level` at all: Sandboxed needs Claude Code's command sandbox.
fn is_offered_on_system(level: PermissionLevel, can_run_sandbox: bool) -> bool {
    level != PermissionLevel::Sandboxed || can_run_sandbox
}

// The mode's name as Claude Code's wire spells it.
fn claude_permission_mode_name(mode: ClaudePermissionMode) -> String {
    serde_json::to_value(mode)
        .ok()
        .and_then(|name| name.as_str().map(str::to_owned))
        .expect("a permission mode serializes as its name")
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

    use super::{ClaudeSettingsSource, claude_starting_level};

    // Killed by honoring `bypassPermissions` or `auto` from a project's own files, which would
    // let a cloned repository start a session unasked, by dropping plan mode, by moving to a less
    // careful level than the one the model cannot run, or by starting at anything but YOLO with
    // nothing set.
    #[rstest]
    #[case::project_bypass(
        Some((ClaudeSettingsSource::Project, "bypassPermissions")),
        true,
        PermissionLevel::Readonly,
        SessionMode::Build,
    )]
    #[case::person_bypass(
        Some((ClaudeSettingsSource::Person, "bypassPermissions")),
        true,
        PermissionLevel::Yolo,
        SessionMode::Build,
    )]
    #[case::project_auto(
        Some((ClaudeSettingsSource::Project, "auto")),
        true,
        PermissionLevel::Yolo,
        SessionMode::Build,
    )]
    #[case::managed_auto(
        Some((ClaudeSettingsSource::Managed, "auto")),
        true,
        PermissionLevel::Reviewed,
        SessionMode::Build,
    )]
    #[case::auto_without_its_model(
        Some((ClaudeSettingsSource::Person, "auto")),
        false,
        PermissionLevel::Ask,
        SessionMode::Build,
    )]
    #[case::plan(
        Some((ClaudeSettingsSource::Project, "plan")),
        true,
        PermissionLevel::Readonly,
        SessionMode::Plan,
    )]
    #[case::unknown_mode(
        Some((ClaudeSettingsSource::Person, "delegate")),
        true,
        PermissionLevel::Readonly,
        SessionMode::Build,
    )]
    #[case::nothing_set(None, true, PermissionLevel::Yolo, SessionMode::Build)]
    fn a_new_session_starts_at_the_level_claude_code_would_start_in(
        #[case] default_mode: Option<(ClaudeSettingsSource, &str)>,
        #[case] can_run_reviewed: bool,
        #[case] level: PermissionLevel,
        #[case] session_mode: SessionMode,
    ) {
        let starting = claude_starting_level(default_mode, |candidate| {
            candidate != PermissionLevel::Reviewed || can_run_reviewed
        });

        assert_eq!(starting.level, level);
        assert_eq!(starting.session_mode, session_mode);
    }
}
