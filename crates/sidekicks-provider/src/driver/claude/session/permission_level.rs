//! The permission levels a Claude Code session can run at: the permission mode each runs in, the
//! level a new session starts at from Claude Code's own settings, and the live move between levels,
//! which sends the level's mode, then the session's whole permission rules and its command sandbox,
//! all from the process's next request, with no relaunch.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::capabilities::ProviderMode;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_platforms::PathRules;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::settle_all::SettleFailures;
use strum::VariantArray;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::errors::{ClaudeSessionError, record_unheard_claude_failure};
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSpawnSources;
use crate::driver::claude::session::permissions::{
    ClaudePermissionsError, compose_live_claude_permissions,
};
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsReadError, ClaudeSettingsSource, ClaudeSettingsSources, read_claude_setting,
};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings, ClaudePermissionMode,
};
use crate::driver::claude::spawn::settings::compose_claude_sandbox_settings;
use crate::driver::command_sandbox::CommandSandboxAvailability;
use crate::driver::contract::error::DriverError;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::session_control::{UpdatePermissionLevelParams, permission_level_not_offered};

// The key a session's starting mode is read from.
const DEFAULT_MODE_KEY_PATH: [&str; 2] = ["permissions", "defaultMode"];

/// The level and mode a new session starts at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeStartingLevel {
    /// The level.
    pub(crate) level: PermissionLevel,
    /// Plan where Claude Code itself would start planning, else Build.
    pub(crate) session_mode: SessionMode,
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
            ClaudeLevelMoveError::NotOffered(refusal) => Self::from(refusal),
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

/// The level and session mode a permission mode runs, the inverse of
/// [`claude_permission_mode_for`]: `plan` runs no level of its own and plans.
pub(crate) fn claude_level_of_mode(
    mode: ClaudePermissionMode,
) -> (Option<PermissionLevel>, SessionMode) {
    match mode {
        ClaudePermissionMode::Default => (Some(PermissionLevel::Readonly), SessionMode::Build),
        ClaudePermissionMode::AcceptEdits => (Some(PermissionLevel::Ask), SessionMode::Build),
        ClaudePermissionMode::Auto => (Some(PermissionLevel::Reviewed), SessionMode::Build),
        ClaudePermissionMode::DontAsk => (Some(PermissionLevel::Sandboxed), SessionMode::Build),
        ClaudePermissionMode::BypassPermissions => {
            (Some(PermissionLevel::Yolo), SessionMode::Build)
        }
        ClaudePermissionMode::Plan => (None, SessionMode::Plan),
    }
}

/// The levels a Claude Code session is offered, each named by the mode it runs in: those `offers`
/// holds for.
pub(crate) fn list_claude_modes(offers: impl Fn(PermissionLevel) -> bool) -> Vec<ProviderMode> {
    PermissionLevel::VARIANTS
        .iter()
        .filter(|&&level| offers(level))
        .map(|&level| ProviderMode {
            id: FreeFormText::new(<&str>::from(level).to_owned())
                .expect("a level's name is a short word"),
            name: FreeFormText::new(
                <&str>::from(claude_permission_mode_for(Some(level))).to_owned(),
            )
            .expect("a permission mode's name is a short word"),
        })
        .collect()
}

/// How the driver checks whether Claude Code's command sandbox runs where a process environment
/// and a working folder name; production's is [`check_claude_command_sandbox`].
pub(crate) type ClaudeCommandSandboxCheck =
    fn(&[(String, String)], &Path) -> io::Result<CommandSandboxAvailability>;

/// The descriptor's check of Claude Code's command sandbox, which the driver runs in production.
pub(crate) fn check_claude_command_sandbox(
    environment: &[(String, String)],
    working_folder: &Path,
) -> io::Result<CommandSandboxAvailability> {
    DESCRIPTOR.can_run_command_sandbox(environment, working_folder, &[])
}

/// Whether Claude Code's command sandbox runs in the place `spawn_environment` and
/// `working_folder` name, by the check `sources` carry, run on their spawner thread, which the
/// namespace check needs. A check that fails is recorded, against `session_id` where one is named,
/// and answers no, so Sandboxed is never offered on a guess.
pub(crate) async fn read_claude_sandbox_support(
    sources: &ClaudeSpawnSources,
    spawn_environment: &[(String, String)],
    working_folder: &Path,
    session_id: Option<SessionId>,
) -> bool {
    let environment = spawn_environment.to_vec();
    let folder = working_folder.to_path_buf();
    let check = sources.command_sandbox_check;
    let checked = sources
        .spawner
        .run(move || check(&environment, &folder))
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

/// What a live level move left to tell the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeLevelMoved {
    /// Claude Code reported running Sandboxed where the sandbox cannot start, so its commands
    /// fail rather than run unsandboxed.
    pub(crate) sandbox_unavailable: bool,
}

/// Moves a live session to the posture `params` names, at its level and writable roots: its
/// permission mode, unless the session plans, then its whole permission rules with `session_rules`
/// in force and its command sandbox, on at Sandboxed and removed at every other level, then the
/// posture it runs at. Refused before anything is sent for a level the model or system cannot
/// run. A move that follows a mode Claude Code reported running sends no mode and is never
/// refused, since Claude Code runs it already; it takes that mode as the one the process runs,
/// and at Sandboxed where the sandbox cannot start it answers `sandbox_unavailable`.
pub(crate) async fn move_claude_permission_level(
    live: &LiveClaudeSession,
    params: &UpdatePermissionLevelParams,
    can_run_sandbox: bool,
    session_rules: &[ProviderAskRule],
    path_rules: PathRules,
) -> Result<ClaudeLevelMoved, ClaudeLevelMoveError> {
    let posture = &params.execution_posture;
    let level = posture.permission_level();
    let (session_mode, is_runnable) = {
        let settings = lock(&live.settings);
        let is_runnable = params.is_provider_reported
            || can_run_claude_level(
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
    if session_mode == SessionMode::Build && !params.is_provider_reported {
        let mode = claude_permission_mode_for(Some(level));
        // Held until the reply, so the report the send causes is known as the daemon's own.
        let send = live.permission_mode.begin_send(mode);
        live.channel
            .send_control_request(ClaudeControlRequest::SetPermissionMode { mode })
            .await
            .map_err(level_request_failure)?;
        send.acknowledge();
    }
    live.channel
        .send_control_request(ClaudeControlRequest::ApplyFlagSettings {
            settings: ClaudeFlagSettings {
                permissions: Some(permissions),
                // `null` removes the key from the flag-settings layer, so leaving Sandboxed turns
                // the sandbox off.
                sandbox: Some((level == PermissionLevel::Sandboxed).then(|| {
                    compose_claude_sandbox_settings(
                        posture.writable_roots(),
                        live.spawn_bound_legs.command_channel.as_deref(),
                    )
                })),
                ..ClaudeFlagSettings::default()
            },
        })
        .await
        .map_err(level_request_failure)?;
    lock(&live.settings).execution_posture = Some(posture.clone());
    if !params.is_provider_reported {
        return Ok(ClaudeLevelMoved {
            sandbox_unavailable: false,
        });
    }
    live.permission_mode
        .adopt_report(claude_permission_mode_for(Some(level)));
    Ok(ClaudeLevelMoved {
        sandbox_unavailable: level == PermissionLevel::Sandboxed && !can_run_sandbox,
    })
}

// Claude Code's own refusal of a level's request refuses the level as not offered, in its words;
// any other failure is the request's.
fn level_request_failure(error: ClaudeSessionError) -> ClaudeLevelMoveError {
    match error.into_refusal_as(
        RefusalCode::SessionPermissionLevelNotOffered,
        "Claude Code refused the permission level",
    ) {
        Ok(refusal) => ClaudeLevelMoveError::NotOffered(refusal),
        Err(error) => ClaudePermissionsError::from(error).into(),
    }
}

/// The level a new session starts at from `permissions.defaultMode`, read by Claude Code's own
/// precedence: the managed settings, then the project's local and shared files, then the person's
/// own; `can_run` answers whether the session's provider, account and model run a level. Fails
/// with every settings file that could not be read, since it may have set the mode.
pub(crate) async fn read_claude_starting_level(
    sources: &ClaudeSettingsSources<'_>,
    can_run: impl Fn(PermissionLevel) -> bool,
) -> Result<ClaudeStartingLevel, SettleFailures<ClaudeSettingsReadError>> {
    let default_mode = read_claude_setting(sources, &DEFAULT_MODE_KEY_PATH, |value| {
        value.as_str().map(str::to_owned)
    })
    .await?;
    Ok(claude_starting_level(
        default_mode
            .as_ref()
            .map(|(source, mode)| (*source, mode.as_str())),
        can_run,
    ))
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
        Some((source, mode)) => match (mode.parse::<ClaudePermissionMode>(), source) {
            (Ok(ClaudePermissionMode::Auto), ClaudeSettingsSource::Project) => {
                (PermissionLevel::Yolo, SessionMode::Build)
            }
            // A project's `bypassPermissions` and any unknown mode start in the manual mode.
            (Ok(ClaudePermissionMode::BypassPermissions), ClaudeSettingsSource::Project)
            | (Err(_), _) => (PermissionLevel::Readonly, SessionMode::Build),
            (Ok(mode), _) => {
                let (level, session_mode) = claude_level_of_mode(mode);
                // Plan runs no level of its own, so its session starts at the most careful.
                (level.unwrap_or(PermissionLevel::Readonly), session_mode)
            }
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

/// Whether this system offers `level` at all: Sandboxed needs Claude Code's command sandbox, which
/// runs here where `can_run_sandbox`.
pub(crate) fn is_offered_on_system(level: PermissionLevel, can_run_sandbox: bool) -> bool {
    level != PermissionLevel::Sandboxed || can_run_sandbox
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

    use super::claude_starting_level;
    use crate::driver::claude::session::settings_file::ClaudeSettingsSource;

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
