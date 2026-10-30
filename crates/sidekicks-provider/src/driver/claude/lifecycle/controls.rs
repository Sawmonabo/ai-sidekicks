//! A session's controls and the reads of Claude Code itself: the starting level and a level move,
//! a revoked rule, the models, modes, capabilities and sign-in, the Settings rows and the session
//! options, the mode, the commands the daemon answers, a side question, a review, the command list
//! a screen follows, and each session's inbox addresser.

use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt;
use futures::future::ready;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ObservedProviderOptions, ProviderRow, ProviderSessionOption,
};
use sidekicks_contracts::provider::driver::capabilities::{ProviderMode, ProviderModel};
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;
use sidekicks_std::mutex_lock::lock;

use super::{ClaudeDriver, internal};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::capabilities::resolve_claude_model_catalog;
use crate::driver::claude::delivery::requests::answers::claude_project_folder;
use crate::driver::claude::run::start::claude_session_unavailable;
use crate::driver::claude::session::controls::{
    ClaudeSideQuestionCopy, claude_full_model_id, one_turn_legs, without_credential_prompts,
};
use crate::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, record_unheard_claude_failure,
};
use crate::driver::claude::session::establishment::context::resolve_claude_spawn_context;
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSpawnSources;
use crate::driver::claude::session::permission_level::{
    ClaudeStartingLevelSources, can_run_claude_level, is_offered_on_system, list_claude_modes,
    move_claude_permission_level, read_claude_sandbox_support, read_claude_starting_level,
};
use crate::driver::claude::session::permissions::{
    ClaudeProjectRuleRemoval, read_claude_session_rules, resend_claude_permissions,
    revoke_claude_project_rule,
};
use crate::driver::claude::session::restart::ClaudeSessionStanding;
use crate::driver::claude::session::settings_file::read_claude_settings_file;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::readings::ClaudeSessionFolderReadRequest;
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::session::ultracode::{claude_session_options, observe_claude_options};
use crate::driver::claude::settings_rows::compose_claude_rows;
use crate::driver::claude::spawn::environment::{ClaudeProcessHome, claude_config_folder};
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::claude::spawn::launch::{
    ClaudeLaunchError, initialize_reply::read_claude_initialize_declaration,
};
use crate::driver::claude::spawn::legs::{
    ClaudeSpawnLegServices, ClaudeSpawnLegsRequest, build_claude_spawn_bound_legs,
};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::ProviderCommandsSubscription;
use crate::driver::contract::params_and_results::{
    GetCapabilitiesResult, ListModelsParams, ListModesParams, ProviderReportedLevel,
};
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::read_current_account;
use crate::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, DriverAuthProbeResult,
    DriverAuthProbeStatus, ProviderCommandsListener, ResumeSessionParams, RevokeRuleParams,
    SessionCommandAnswer, StartingLevel, StartingLevelParams, SubscribeProviderCommandsParams,
    UpdatePermissionLevelParams, UpdateSessionModeParams, build_auth_probe_result,
    permission_level_not_offered,
};
use crate::port::session_inbox_address::SessionInboxAddresser;

/// The model a read of the build's own choices runs on: Claude Code's pointer to its recommended
/// model, which every account's catalog lists.
const CLAUDE_DEFAULT_MODEL: &str = "default";

/// The key of an account home's own output style in Claude Code's settings.
const OUTPUT_STYLE_KEY: &str = "outputStyle";

/// The key of an account home's own advisor in Claude Code's settings, empty for none.
const ADVISOR_MODEL_KEY: &str = "advisorModel";

/// The file of an account home's own settings, in its config folder.
const SETTINGS_FILE_NAME: &str = "settings.json";

/// The folder under the daemon's data folder the capability read runs on.
const CLAUDE_CAPABILITY_READ_FOLDER: &str = "claude-capability-read";

/// Which levels one account and this system run, read once for a starting level or a level list.
struct ClaudeOfferedLevels {
    /// The models the account's catalog runs auto mode on; empty where the catalog was not read.
    auto_mode_models: HashSet<String>,
    /// Whether Claude Code's command sandbox runs here.
    can_run_sandbox: bool,
}

impl ClaudeOfferedLevels {
    // Whether a process on `model` runs at `level` on this account and system.
    fn offers(&self, level: PermissionLevel, model: &str) -> bool {
        can_run_claude_level(level, model, &self.auto_mode_models, self.can_run_sandbox)
    }
}

impl ClaudeDriver {
    /// The level and mode a new session starts at, as Claude Code's own settings for the folder set
    /// them, moved to the nearest more careful level the model and this system run. A catalog that
    /// cannot be read offers no Reviewed and is recorded; fails when a settings file that may set
    /// the mode cannot be read.
    pub(crate) async fn read_starting_level(
        &self,
        params: StartingLevelParams,
    ) -> Result<StartingLevel, DriverError> {
        let environment = self
            .sources
            .account_environment(&params.provider_account_id)
            .await?;
        let (offered, repository) = tokio::join!(
            self.read_offered_levels(&environment, &params.working_folder),
            self.read_repository(&params.working_folder),
        );
        let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
        let project_folder = claude_project_folder(&params.working_folder, repository.as_ref());
        let account_settings_file = account_config_folder(&environment).join(SETTINGS_FILE_NAME);
        let starting = read_claude_starting_level(
            &ClaudeStartingLevelSources {
                managed_settings_folder: managed_settings_folder.as_deref(),
                project_folder: &project_folder,
                home_folder: &self.sources.home_folder,
                account_settings_file: &account_settings_file,
                path_rules: PathRules::NATIVE,
            },
            |level| offered.offers(level, params.model.as_str()),
        )
        .await
        .map_err(internal)?;
        Ok(StartingLevel {
            level: starting.level,
            session_mode: starting.session_mode,
        })
    }

    /// Moves the session to another level from its next request, with its rules in force: a live
    /// process at once, and one the driver brings back from the settings it starts with. Refused
    /// `session.permissionLevel.notOffered` for a level the model or this system cannot run,
    /// unless Claude Code reported running it, and `NoLiveSession` when no process serves the
    /// session or comes back; fails as the move fails.
    pub(crate) async fn update_permission_level(
        &self,
        params: UpdatePermissionLevelParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let level = params.execution_posture.permission_level();
        let params = &params;
        self.move_session_setting(
            params.session_id,
            |live| async move {
                let legs = &live.spawn_bound_legs;
                let (can_run_sandbox, session_rules) = tokio::join!(
                    read_claude_sandbox_support(
                        &self.sources,
                        &legs.spawn_environment,
                        &legs.working_directory,
                        Some(params.session_id),
                    ),
                    read_claude_session_rules(&self.sources.ports.session_rules, params.session_id),
                );
                let session_rules = session_rules.map_err(DriverError::Internal)?;
                if params.is_provider_reported {
                    return parts
                        .session_controls
                        .follow_reported_level(&live, params, can_run_sandbox, &session_rules)
                        .await;
                }
                move_claude_permission_level(
                    &live,
                    params,
                    can_run_sandbox,
                    &session_rules,
                    PathRules::NATIVE,
                )
                .await?;
                Ok(())
            },
            |ended| async move {
                // The process reported running the level, so a later process starts in it.
                if !params.is_provider_reported {
                    let legs = &ended.spawn_bound_legs;
                    let can_run_sandbox = read_claude_sandbox_support(
                        &self.sources,
                        &legs.spawn_environment,
                        &legs.working_directory,
                        Some(params.session_id),
                    )
                    .await;
                    let is_runnable = can_run_claude_level(
                        level,
                        &lock(&ended.settings).running_model,
                        &ended.initialize.auto_mode_models,
                        can_run_sandbox,
                    );
                    if !is_runnable {
                        return Err(DriverError::from(permission_level_not_offered(level)));
                    }
                }
                Ok(parts.restarts.write_held_settings(&ended, |settings| {
                    settings.execution_posture = Some(params.execution_posture.clone());
                }))
            },
        )
        .await
    }

    // Moves the session's level or mode wherever its process stands: `move_live` on a live
    // process, and again on the one a relaunch begun meanwhile brings up; `write_held` into the
    // settings a restart composes its start from, answering `false` once it composed; a bring-up
    // in flight is waited out first. Refuses `NoLiveSession` when no process serves the session or
    // comes back.
    async fn move_session_setting<MoveLive, WriteHeld>(
        &self,
        session_id: SessionId,
        move_live: impl Fn(Arc<LiveClaudeSession>) -> MoveLive,
        write_held: impl Fn(Arc<LiveClaudeSession>) -> WriteHeld,
    ) -> Result<(), DriverError>
    where
        MoveLive: Future<Output = Result<(), DriverError>>,
        WriteHeld: Future<Output = Result<bool, DriverError>>,
    {
        let parts = self.parts()?;
        let mut moved: Option<Arc<LiveClaudeSession>> = None;
        loop {
            match parts.restarts.standing(session_id) {
                ClaudeSessionStanding::Live(live) => {
                    if moved.as_ref().is_some_and(|done| Arc::ptr_eq(done, &live)) {
                        return Ok(());
                    }
                    move_live(Arc::clone(&live)).await?;
                    moved = Some(live);
                }
                ClaudeSessionStanding::Held { ended, .. } => {
                    if write_held(ended).await? {
                        return Ok(());
                    }
                }
                ClaudeSessionStanding::Settling(settled) => {
                    settled.wait().await;
                }
                // A process moved before it went down took the move with it.
                ClaudeSessionStanding::Down if moved.is_some() => return Ok(()),
                ClaudeSessionStanding::Down => {
                    return Err(claude_session_unavailable(
                        ClaudeSessionUnavailableReason::NoLiveSession,
                        session_id,
                        None,
                    )
                    .into());
                }
            }
        }
    }

    /// Takes a revoked rule out of force: a project rule out of the folder's local settings, a
    /// session rule out of the live process's permissions, which a session at rest reads again
    /// when it opens. A project rule is looked for in the config folder of the home the session
    /// ran on last, else of the account its stored leg names, else of the provider's current
    /// account. Fails as the account, the removal, the rules' read or the resend fails.
    pub(crate) async fn revoke_rule(&self, params: RevokeRuleParams) -> Result<(), DriverError> {
        let parts = self.composed_parts();
        let live = parts.and_then(|parts| parts.slots().live_session(params.session_id));
        if let Some(project_folder) = &params.project_folder {
            let ended =
                parts.and_then(|parts| parts.restarts.ended_conversation(params.session_id));
            let spawn_environment = match (&live, ended) {
                (Some(live), _) => live.spawn_bound_legs.spawn_environment.clone(),
                (None, Some(ended)) => ended.spawn_environment,
                (None, None) => {
                    let account = self.resting_account(params.session_id).await?;
                    self.sources.account_environment(&account).await?
                }
            };
            let config_folder = account_config_folder(&spawn_environment);
            let repository = self.read_repository(project_folder).await;
            let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
            revoke_claude_project_rule(
                &params.rule,
                &ClaudeProjectRuleRemoval {
                    project_folder: &claude_project_folder(project_folder, repository.as_ref()),
                    managed_settings_folder: managed_settings_folder.as_deref(),
                    config_folder: &config_folder,
                    home_folder: &self.sources.home_folder,
                },
                PathRules::NATIVE,
            )
            .await?;
            return Ok(());
        }
        let Some(live) = live else {
            return Ok(());
        };
        let in_force: Vec<_> =
            read_claude_session_rules(&self.sources.ports.session_rules, params.session_id)
                .await
                .map_err(DriverError::Internal)?
                .into_iter()
                .filter(|rule| *rule != params.rule)
                .collect();
        resend_claude_permissions(&live, &in_force, PathRules::NATIVE).await?;
        Ok(())
    }

    /// The models Claude Code offers on the account the params name, else on the provider's
    /// current account, read from a process that keeps nothing in the session's own place and
    /// account home, or the account's home where no session is named. Fails as the account, its
    /// folders, the read or the catalog fails.
    pub(crate) async fn list_models(
        &self,
        params: ListModelsParams,
    ) -> Result<Vec<ProviderModel>, DriverError> {
        let provider_account_id = match params.provider_account_id {
            Some(provider_account_id) => provider_account_id,
            None => {
                read_current_account(
                    &self.sources.ports.provider_accounts,
                    DESCRIPTOR.provider_id(),
                )
                .await?
            }
        };
        let environment = match params.session_id {
            Some(session_id) => {
                let context = self
                    .sources
                    .ports
                    .spawn_contexts
                    .require_port()
                    .map_err(internal)?
                    .resolve_spawn_context(session_id, provider_account_id.clone())
                    .await
                    .map_err(DriverError::Internal)?;
                self.sources.account_process_environment(
                    &context.account_folders,
                    &provider_account_id,
                    &[],
                    &[],
                )?
            }
            None => {
                self.sources
                    .account_environment(&provider_account_id)
                    .await?
            }
        };
        let reading = self.starts.read_model_catalog(environment.clone()).await?;
        resolve_claude_model_catalog(reading, &self.figures.current(), &environment)
    }

    /// The levels Claude Code runs for a session's level control, as modes: with a model named,
    /// the levels that model runs on the named account and this system, in the session's own place
    /// where a session is named; with none, the levels this system runs. With no account named, a
    /// live session's levels are read on the account it was admitted on, and any other list on the
    /// current account. A live session's process already read its catalog, so only a session with
    /// no process, or one listed on another account than its process runs on, starts a
    /// control-only read. A catalog that cannot be read offers no Reviewed and is recorded; fails
    /// as the current account, the session's place or the account's environment cannot be read.
    pub(crate) async fn list_modes(
        &self,
        params: ListModesParams,
    ) -> Result<Vec<ProviderMode>, DriverError> {
        let Some(model) = params.model else {
            // The check only finds the sandbox's programs and starts no Claude Code, so the folder
            // it names is never made.
            let folder = self.capability_read_folder();
            let environment = self.sources.process_environment(
                ClaudeProcessHome::Throwaway { folder: &folder },
                &[],
                &[],
            )?;
            let can_run_sandbox = read_claude_sandbox_support(
                &self.sources,
                &environment,
                &self.sources.home_folder,
                None,
            )
            .await;
            return Ok(list_claude_modes(|level| {
                is_offered_on_system(level, can_run_sandbox)
            }));
        };
        // A live process read only its own account's catalog.
        let live = params
            .session_id
            .and_then(|session_id| {
                self.composed_parts()
                    .and_then(|parts| parts.slots().live_session(session_id))
            })
            .filter(|live| {
                params
                    .provider_account_id
                    .as_ref()
                    .is_none_or(|named| *named == live.admitted_provider_account_id)
            });
        let offered = if let Some(live) = live {
            let legs = &live.spawn_bound_legs;
            ClaudeOfferedLevels {
                auto_mode_models: live.initialize.auto_mode_models.clone(),
                can_run_sandbox: read_claude_sandbox_support(
                    &self.sources,
                    &legs.spawn_environment,
                    &legs.working_directory,
                    Some(live.session_id),
                )
                .await,
            }
        } else {
            let provider_account_id = match params.provider_account_id {
                Some(provider_account_id) => provider_account_id,
                None => {
                    read_current_account(
                        &self.sources.ports.provider_accounts,
                        DESCRIPTOR.provider_id(),
                    )
                    .await?
                }
            };
            if let Some(session_id) = params.session_id {
                let context = self
                    .sources
                    .ports
                    .spawn_contexts
                    .require_port()
                    .map_err(internal)?
                    .resolve_spawn_context(session_id, provider_account_id.clone())
                    .await
                    .map_err(DriverError::Internal)?;
                let environment = self.sources.account_process_environment(
                    &context.account_folders,
                    &provider_account_id,
                    &[],
                    &[],
                )?;
                self.read_offered_levels(&environment, &context.working_directory)
                    .await
            } else {
                let environment = self
                    .sources
                    .account_environment(&provider_account_id)
                    .await?;
                self.read_offered_levels(&environment, &self.sources.home_folder)
                    .await
            }
        };
        Ok(list_claude_modes(|level| {
            offered.offers(level, model.as_str())
        }))
    }

    /// Which levels the account `environment` composes and this system run in `working_folder`:
    /// the account's catalog and the command sandbox, read at once. A catalog that cannot be read
    /// offers no Reviewed and is recorded.
    async fn read_offered_levels(
        &self,
        environment: &[(String, String)],
        working_folder: &Path,
    ) -> ClaudeOfferedLevels {
        let (catalog, can_run_sandbox) = tokio::join!(
            self.starts.read_model_catalog(environment.to_vec()),
            read_claude_sandbox_support(&self.sources, environment, working_folder, None),
        );
        let auto_mode_models = match catalog {
            Ok(catalog) => {
                read_claude_initialize_declaration(catalog.initialize.as_deref()).auto_mode_models
            }
            Err(error) => {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ControlOnlyReadFailed,
                    None,
                    "the model catalog read for a session's levels",
                    &error,
                );
                HashSet::new()
            }
        };
        ClaudeOfferedLevels {
            auto_mode_models,
            can_run_sandbox,
        }
    }

    /// The installed build's capabilities, version and tools, read live on a configuration folder
    /// the daemon makes empty for the read and removes after it, whether the read succeeded or
    /// not, so the read runs on no account and with no one's settings; the figures held for an
    /// older build are dropped once another is read. One read runs at a time. Fails as the folder
    /// cannot be made, the environment cannot be composed, or the read fails.
    pub(crate) async fn get_capabilities(&self) -> Result<GetCapabilitiesResult, DriverError> {
        let _only_read = self.capability_read.lock().await;
        let folder = self.capability_read_folder();
        // A read the daemon's stop cut short left its folder behind.
        remove_capability_read_folder(&folder)
            .await
            .map_err(internal)?;
        tokio::fs::create_dir_all(&folder).await.map_err(internal)?;
        let read = async {
            let environment = self.sources.process_environment(
                ClaudeProcessHome::Throwaway { folder: &folder },
                &[],
                &[],
            )?;
            self.starts.read_capabilities(environment).await
        }
        .await;
        // The next read removes a folder this removal leaves, so the read's answer stands.
        if let Err(error) = remove_capability_read_folder(&folder).await {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ControlOnlyReadFailed,
                None,
                "removing the capability read's configuration folder",
                &error,
            );
        }
        let result = read?;
        self.figures.note_build(&result.cli_version.raw_version);
        Ok(result)
    }

    /// How `provider_account_id`'s account is signed in, read from a process that takes no turn
    /// on that account's home. Fails as the account's folders cannot be resolved.
    pub(crate) async fn probe_auth(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> Result<DriverAuthProbeResult, DriverError> {
        let environment = self
            .sources
            .account_environment(&provider_account_id)
            .await?;
        Ok(match self.starts.probe_sign_in(environment).await {
            Ok(detail) => build_auth_probe_result(DriverAuthProbeStatus::Authenticated, &detail),
            Err(error) => {
                let is_signed_out = matches!(
                    &error,
                    ClaudeLaunchError::Session(ClaudeSessionError::AuthenticationRequired { .. })
                );
                let status = if is_signed_out {
                    DriverAuthProbeStatus::Unauthenticated
                } else {
                    DriverAuthProbeStatus::Indeterminate
                };
                build_auth_probe_result(status, &error.to_string())
            }
        })
    }

    /// `Output style` and `Advisor`, each with the app's pick in `app_values` or what a new
    /// session runs with, on the provider's current account: the choices read from the installed
    /// build in that account's home once per build and held, so a later read starts no process,
    /// and Claude Code's own values from that home's settings. Fails as the account cannot be
    /// resolved or its settings cannot be read.
    pub(crate) async fn read_rows(
        &self,
        app_values: ProviderRowValues,
    ) -> Result<Vec<ProviderRow>, DriverError> {
        let provider_account_id = read_current_account(
            &self.sources.ports.provider_accounts,
            DESCRIPTOR.provider_id(),
        )
        .await?;
        let environment = self
            .sources
            .account_environment(&provider_account_id)
            .await?;
        let settings_file = account_config_folder(&environment).join(SETTINGS_FILE_NAME);
        let place = ClaudeSessionFolderReadRequest {
            spawn_environment: environment,
            working_directory: self.sources.home_folder.clone(),
            model: CLAUDE_DEFAULT_MODEL.to_owned(),
        };
        let (choices, settings) = tokio::join!(
            self.figures.read_command_choices(&place),
            read_claude_settings_file(&settings_file),
        );
        let settings = settings.map_err(internal)?;
        let home_setting = |key: &str| {
            settings
                .as_ref()?
                .get(key)?
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let offers = choices.map_err(|error| error.to_string());
        Ok(compose_claude_rows(
            offers,
            &app_values,
            home_setting(OUTPUT_STYLE_KEY),
            home_setting(ADVISOR_MODEL_KEY),
        ))
    }

    /// The Ultracode switch, in the effort menu.
    pub(crate) fn session_options() -> Vec<ProviderSessionOption> {
        claude_session_options()
    }

    /// Ultracode as the live process last read it back.
    pub(crate) fn observed_options_for(
        &self,
        session_id: SessionId,
    ) -> Option<ObservedProviderOptions> {
        let live = self.composed_parts()?.slots().live_session(session_id)?;
        let reading = lock(&live.settings).ultracode?;
        Some(observe_claude_options(reading))
    }

    /// The fast-mode state the live process last declared.
    pub(crate) fn observed_output_speed_for(
        &self,
        session_id: SessionId,
    ) -> Option<ProviderOutputSpeedState> {
        let parts = self.composed_parts()?;
        let live = parts.slots().live_session(session_id)?;
        parts
            .run_start
            .handshakes
            .observed_output_speed_for(session_id, &live.provider_session_id)
    }

    /// The level and session mode Claude Code itself moved the live process to, from its newest
    /// report; `None` with no live process or while the report is the daemon's own.
    pub(crate) fn reported_level(&self, session_id: SessionId) -> Option<ProviderReportedLevel> {
        self.composed_parts()?
            .slots()
            .live_session(session_id)?
            .permission_mode
            .reported_level()
    }

    /// Moves the session between Build and Plan from its next turn: a live process at once, and
    /// one the driver brings back from the settings it starts with. Refused
    /// `session.mode.notOffered` when Claude Code refuses the mode, and `NoLiveSession` when no
    /// process serves the session or comes back.
    pub(crate) async fn update_session_mode(
        &self,
        params: UpdateSessionModeParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let mode = params.mode;
        let params = &params;
        self.move_session_setting(
            params.session_id,
            |live| async move {
                parts
                    .session_controls
                    .update_session_mode(&live, params)
                    .await
            },
            |ended| async move {
                Ok(parts.restarts.write_held_settings(&ended, |settings| {
                    settings.session_mode = mode;
                }))
            },
        )
        .await
    }

    /// Answers `/output-style`, `/advisor` and an owned `/config` for this session alone.
    pub(crate) async fn answer_session_command(
        &self,
        params: AnswerSessionCommandParams,
    ) -> Result<SessionCommandAnswer, DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        Ok(parts
            .session_controls
            .answer_session_command(&live, &params.text)
            .await?)
    }

    /// Asks a side question on a copy of the conversation: the live process's own, else the one
    /// the session's resume material names; resolves once it is answered. Fails `NoLiveSession`
    /// for a session at rest asked with no resume material, and as the question's turn fails.
    pub(crate) async fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        let copy = match parts.run_start.live_session(session_id) {
            Ok(live) => ready(Ok(ClaudeSideQuestionCopy {
                legs: without_credential_prompts(one_turn_legs(&live, None, None)),
                provider_account_id: live.admitted_provider_account_id.clone(),
                parent_provider_session_id: live.provider_session_id.clone(),
            }))
            .boxed(),
            Err(no_live_session) => match params.resume {
                Some(resume) => compose_resting_side_question_copy(
                    Arc::clone(&self.sources),
                    Arc::clone(&self.starts),
                    resume,
                )
                .boxed(),
                None => return Err(no_live_session.into()),
            },
        };
        let hold = parts
            .establishment
            .task_services
            .idle_sleep
            .hold_side_question(session_id);
        parts
            .session_controls
            .ask_side_question(
                session_id,
                params.binding_id,
                params.side_question_id,
                params.question,
                copy,
                &self.sources.ports.usage,
                hold,
            )
            .await
    }

    /// Follows the session's live command list; while the session pieces cannot be composed no
    /// session is live, so the failure is recorded and the follow, which gets nothing, ends.
    pub(crate) fn subscribe_provider_commands(
        &self,
        params: &SubscribeProviderCommandsParams,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        match self.parts() {
            Ok(parts) => parts
                .session_controls
                .subscribe_provider_commands(params.session_id, listener),
            Err(error) => {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    params.session_id,
                    "following the command list",
                    &error,
                );
                ProviderCommandsSubscription::new(|| {})
            }
        }
    }

    /// Each session's inbox address in every place the daemon runs sessions in, which Claude
    /// Code's sessions always answer: composed from the places the daemon's start registers, and
    /// until it does, every place answered as one the start did not list.
    #[expect(
        clippy::unnecessary_wraps,
        reason = "the driver interface answers an option, none for a provider with no session inbox"
    )]
    pub(crate) fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>> {
        Some(Arc::clone(&self.inbox_addresser) as Arc<dyn SessionInboxAddresser>)
    }
}

impl ClaudeDriver {
    // The folder the capability read makes and removes, under the daemon's data folder.
    fn capability_read_folder(&self) -> PathBuf {
        self.sources.data_folder.join(CLAUDE_CAPABILITY_READ_FOLDER)
    }

    // The account a session with no process here runs on: the one its stored leg names, else,
    // for a session that never ran, the provider's current account.
    async fn resting_account(
        &self,
        session_id: SessionId,
    ) -> Result<ProviderAccountId, DriverError> {
        match self.read_session_leg(session_id).await? {
            Some(leg) => Ok(leg.spawn_config.provider_account_id),
            None => {
                read_current_account(
                    &self.sources.ports.provider_accounts,
                    DESCRIPTOR.provider_id(),
                )
                .await
            }
        }
    }
}

// Removes the capability read's folder and everything in it; one already gone is removed.
async fn remove_capability_read_folder(folder: &Path) -> io::Result<()> {
    match tokio::fs::remove_dir_all(folder).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
}

// The config folder of a Claude Code process's environment, which every home the driver starts a
// process on names.
fn account_config_folder(environment: &[(String, String)]) -> PathBuf {
    claude_config_folder(environment, PathRules::NATIVE)
        .expect("every Claude Code home names its config folder")
}

// The copy of a session at rest, from its resume material: the legs a resume starts with, with no
// callback tools and on the full id of its model, which the build's catalog resolves since no
// process of the session declared it. Fails as the context, the legs or the catalog cannot be read.
async fn compose_resting_side_question_copy(
    sources: Arc<ClaudeSpawnSources>,
    starts: Arc<dyn ClaudeProcessStarts>,
    resume: ResumeSessionParams,
) -> Result<ClaudeSideQuestionCopy, Box<dyn Error + Send + Sync>> {
    let context = resolve_claude_spawn_context(
        &sources.ports.spawn_contexts,
        &sources.pool,
        resume.session_id,
        resume.provider_account_id.clone(),
        &resume.row_values,
    )
    .await?;
    let legs = build_claude_spawn_bound_legs(
        ClaudeSpawnLegsRequest {
            session_id: resume.session_id,
            model: resume.model.as_str().to_owned(),
            execution_posture: resume.execution_posture,
            subagent_policy: resume.subagent_policy,
            tool_servers: resume.tool_servers,
            output_schema: None,
            on_mcp_server_status: None,
            provider_account_id: resume.provider_account_id.clone(),
            command_channel: None,
            context,
            continues_interrupted_turn: false,
        },
        &ClaudeSpawnLegServices::of(&sources),
    )
    .await?;
    let catalog = starts
        .read_model_catalog(legs.spawn_environment.clone())
        .await?;
    let declaration = read_claude_initialize_declaration(catalog.initialize.as_deref());
    Ok(ClaudeSideQuestionCopy {
        legs: ClaudeSpawnBoundLegs {
            model: claude_full_model_id(&declaration, &legs.model),
            ..without_credential_prompts(legs)
        },
        provider_account_id: resume.provider_account_id,
        parent_provider_session_id: resume.resume_handle,
    })
}
