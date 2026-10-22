//! A session's controls and the reads of Claude Code itself: the starting level and a level move,
//! a revoked rule, the models, modes, capabilities and sign-in, the Settings rows and the session
//! options, the mode, the commands the daemon answers, a side question, a review, the command list
//! a screen follows, and each session's inbox address.

use std::collections::HashSet;
use std::sync::Arc;

use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::declaration::{
    ObservedProviderOptions, ProviderRow, ProviderSessionOption,
};
use sidekicks_contracts::provider::driver::capabilities::{ProviderMode, ProviderModel};
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;

use super::{ClaudeDriver, internal, lock, person_settings_folder};
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::capabilities::resolve_claude_model_catalog;
use crate::provider::driver::claude::delivery::requests::answers::claude_project_folder;
use crate::provider::driver::claude::inbox_address::{
    ClaudeSessionInboxAddresser, PlaceInboxEnvironment,
};
use crate::provider::driver::claude::session::answered_commands::read_claude_command_choices;
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, record_unheard_claude_failure,
};
use crate::provider::driver::claude::session::ignored_settings::MANAGED_SETTINGS_FILE;
use crate::provider::driver::claude::session::permission_level::{
    ClaudeStartingLevelSources, can_run_claude_level, list_claude_modes,
    move_claude_permission_level, read_claude_sandbox_support, read_claude_starting_level,
};
use crate::provider::driver::claude::session::permissions::{
    ClaudeProjectRuleRemoval, read_claude_session_rules, resend_claude_permissions,
    revoke_claude_project_rule,
};
use crate::provider::driver::claude::session::settings_file::read_claude_settings_file;
use crate::provider::driver::claude::session::transport::readings::ClaudeSessionFolderReadRequest;
use crate::provider::driver::claude::session::ultracode::{
    claude_session_options, observe_claude_options,
};
use crate::provider::driver::claude::settings_rows::{ClaudeRowOffers, compose_claude_rows};
use crate::provider::driver::claude::spawn::environment::{
    ClaudeAccountFolders, claude_config_folder,
};
use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::provider::driver::claude::spawn::launch::initialize_reply::read_claude_initialize_declaration;
use crate::provider::driver::contract::ProviderCommandsSubscription;
use crate::provider::driver::contract::{DriverError, GetCapabilitiesResult, ListModelsParams};
use crate::provider::driver::diagnostics::DriverDiagnosticKind;
use crate::provider::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, DriverAuthProbeResult,
    DriverAuthProbeStatus, ProviderCommandsListener, RevokeRuleParams, SessionCommandAnswer,
    StartReviewParams, StartingLevel, StartingLevelParams, SubscribeProviderCommandsParams,
    UpdatePermissionLevelParams, UpdateSessionModeParams, build_auth_probe_result,
};
use crate::provider::port::session_inbox_address::SessionInboxAddresser;

/// The model a read of the build's own choices runs on: Claude Code's pointer to its recommended
/// model, which every account's catalog lists.
const CLAUDE_DEFAULT_MODEL: &str = "default";

/// The key of the person's own output style in Claude Code's settings.
const OUTPUT_STYLE_KEY: &str = "outputStyle";

impl ClaudeDriver {
    /// The level and mode a new session starts at, as Claude Code's own settings for the folder set
    /// them, moved to the nearest more careful level the model and this system run. A catalog that
    /// cannot be read offers no Reviewed and is recorded; fails when a settings file that may set
    /// the mode cannot be read.
    pub(crate) async fn read_starting_level(
        &self,
        params: StartingLevelParams,
    ) -> Result<StartingLevel, DriverError> {
        let environment = self.process_environment(None)?;
        let (catalog, can_run_sandbox, repository) = tokio::join!(
            self.starts.read_model_catalog(environment.clone()),
            read_claude_sandbox_support(
                &self.sources.spawner,
                &environment,
                &params.working_folder,
                None,
            ),
            self.read_repository(&params.working_folder),
        );
        let auto_mode_models = match catalog {
            Ok(catalog) => {
                read_claude_initialize_declaration(catalog.initialize.as_deref()).auto_mode_models
            }
            Err(error) => {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ControlOnlyReadFailed,
                    None,
                    "the model catalog read for a session's starting level",
                    &error,
                );
                HashSet::new()
            }
        };
        let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
        let project_folder = claude_project_folder(&params.working_folder, repository.as_ref());
        let starting = read_claude_starting_level(
            &ClaudeStartingLevelSources {
                managed_settings_folder: managed_settings_folder.as_deref(),
                project_folder: &project_folder,
                home_folder: &self.sources.home_folder,
                path_rules: PathRules::NATIVE,
            },
            |level| {
                can_run_claude_level(
                    level,
                    params.model.as_str(),
                    &auto_mode_models,
                    can_run_sandbox,
                )
            },
        )
        .await
        .map_err(internal)?;
        Ok(StartingLevel {
            level: starting.level,
            session_mode: starting.session_mode,
        })
    }

    /// Moves the live session to another level from its next request, with its rules in force.
    pub(crate) async fn update_permission_level(
        &self,
        params: UpdatePermissionLevelParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        let legs = &live.spawn_bound_legs;
        let (can_run_sandbox, session_rules) = tokio::join!(
            read_claude_sandbox_support(
                &self.sources.spawner,
                &legs.spawn_environment,
                &legs.working_directory,
                Some(params.session_id),
            ),
            read_claude_session_rules(&self.sources.ports.session_rules, params.session_id),
        );
        let session_rules = session_rules.map_err(DriverError::Internal)?;
        move_claude_permission_level(
            &live,
            &params,
            can_run_sandbox,
            &session_rules,
            PathRules::NATIVE,
        )
        .await?;
        Ok(())
    }

    /// Takes a revoked rule out of force: a project rule out of the folder's local settings, a
    /// session rule out of the live process's permissions, which a session at rest reads again
    /// when it opens. Fails as the removal, the rules' read or the resend fails.
    pub(crate) async fn revoke_rule(&self, params: RevokeRuleParams) -> Result<(), DriverError> {
        let live = self
            .composed_parts()
            .and_then(|parts| parts.slots().live_session(params.session_id));
        if let Some(project_folder) = &params.project_folder {
            let config_folder = match &live {
                Some(live) => claude_config_folder(
                    &live.spawn_bound_legs.spawn_environment,
                    PathRules::NATIVE,
                ),
                None => None,
            }
            .unwrap_or_else(|| person_settings_folder(&self.sources.home_folder));
            let repository = self.read_repository(project_folder).await;
            let managed_settings_file = DESCRIPTOR
                .managed_settings_folder()
                .map(|folder| folder.join(MANAGED_SETTINGS_FILE))
                .unwrap_or_default();
            revoke_claude_project_rule(
                &params.rule,
                &ClaudeProjectRuleRemoval {
                    project_folder: &claude_project_folder(project_folder, repository.as_ref()),
                    managed_settings_file: &managed_settings_file,
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

    /// The models Claude Code offers on the account the params name, read from a process that
    /// keeps nothing in the session's own place and account home, or the person's own home where
    /// no session is named. Fails as the read or the catalog fails.
    pub(crate) async fn list_models(
        &self,
        params: ListModelsParams,
    ) -> Result<Vec<ProviderModel>, DriverError> {
        let environment = match params.session_id {
            Some(session_id) => {
                let context = self
                    .sources
                    .spawn_contexts
                    .resolve_spawn_context(session_id, params.provider_account_id.clone())
                    .await
                    .map_err(DriverError::Internal)?;
                let folders = context.account_folders.map(|folders| ClaudeAccountFolders {
                    config_folder: folders.configuration_folder.to_string_lossy().into_owned(),
                    credential_store_folder: folders
                        .credential_store_folder
                        .to_string_lossy()
                        .into_owned(),
                });
                let account = folders.as_ref().zip(params.provider_account_id.as_ref());
                self.process_environment(account)?
            }
            None => self.process_environment(None)?,
        };
        let reading = self.starts.read_model_catalog(environment.clone()).await?;
        resolve_claude_model_catalog(reading, &self.figures.current(), &environment)
    }

    /// The levels Claude Code runs on this system, as modes.
    pub(crate) async fn list_modes(&self) -> Result<Vec<ProviderMode>, DriverError> {
        let environment = self.process_environment(None)?;
        let can_run_sandbox = read_claude_sandbox_support(
            &self.sources.spawner,
            &environment,
            &self.sources.home_folder,
            None,
        )
        .await;
        Ok(list_claude_modes(can_run_sandbox))
    }

    /// The installed build's capabilities, version and tools, read live; the figures held for an
    /// older build are dropped once another is read.
    pub(crate) async fn get_capabilities(&self) -> Result<GetCapabilitiesResult, DriverError> {
        let environment = self.process_environment(None)?;
        let result = self.starts.read_capabilities(environment).await?;
        self.figures.note_build(&result.cli_version.raw_version);
        Ok(result)
    }

    /// How the person's own Claude Code is signed in, read from a process that takes no turn.
    pub(crate) async fn probe_auth(&self) -> Result<DriverAuthProbeResult, DriverError> {
        let environment = self.process_environment(None)?;
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
    /// session runs with, the choices read from the installed build in the person's own home.
    pub(crate) async fn read_rows(
        &self,
        app_values: ProviderRowValues,
    ) -> Result<Vec<ProviderRow>, DriverError> {
        let environment = self.process_environment(None)?;
        let place = ClaudeSessionFolderReadRequest {
            spawn_environment: environment,
            working_directory: self.sources.home_folder.clone(),
            model: CLAUDE_DEFAULT_MODEL.to_owned(),
        };
        let settings_file = person_settings_folder(&self.sources.home_folder).join("settings.json");
        let (reading, settings) = tokio::join!(
            self.starts.read_creation_figures(place, HashSet::new()),
            read_claude_settings_file(&settings_file),
        );
        let person_output_style = settings.map_err(internal)?.and_then(|settings| {
            settings
                .get(OUTPUT_STYLE_KEY)
                .and_then(|style| style.as_str())
                .map(str::to_owned)
        });
        let offers = reading
            .map(|reading| {
                let choices = read_claude_command_choices(&reading);
                ClaudeRowOffers {
                    output_styles: reading.output_style_names,
                    output_style_descriptions: choices.output_styles,
                    advisors: choices.advisor,
                }
            })
            .map_err(|error| error.to_string());
        Ok(compose_claude_rows(
            offers,
            &app_values,
            person_output_style,
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

    /// Moves the live session between Build and Plan from its next turn.
    pub(crate) async fn update_session_mode(
        &self,
        params: UpdateSessionModeParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        Ok(parts
            .session_controls
            .update_session_mode(&live, params.mode)
            .await?)
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

    /// Asks a side question on a copy of the live conversation; resolves once it is asked.
    pub(crate) fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        parts
            .session_controls
            .ask_side_question(&live, params.side_question_id, params.question);
        Ok(())
    }

    /// Starts Claude Code's own review; resolves once it has started.
    pub(crate) async fn start_review(&self, params: StartReviewParams) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        parts
            .session_controls
            .start_review(&live, params.target)
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

    /// Each session's inbox address in every place the daemon runs sessions in; `None` before the
    /// daemon registers its places.
    pub(crate) fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>> {
        let places = self.sources.ports.session_places.port()?;
        Some(Arc::new(ClaudeSessionInboxAddresser::new(
            places.iter().map(|place| {
                (
                    place.place.clone(),
                    PlaceInboxEnvironment {
                        login_shell: &place.login_shell,
                        user_id: place.user_id,
                    },
                )
            }),
        )))
    }
}
