//! A session's controls and the reads of Claude Code itself: the starting level and a level move,
//! a revoked rule, the models, modes, capabilities and sign-in, the Settings rows and the session
//! options, the mode, the commands the daemon answers, a side question, a review, the command list
//! a screen follows, and each session's inbox address.

use std::collections::HashSet;
use std::error::Error;
use std::sync::{Arc, OnceLock};

use futures::FutureExt;
use futures::future::ready;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::declaration::{
    ObservedProviderOptions, ProviderRow, ProviderSessionOption,
};
use sidekicks_contracts::provider::driver::capabilities::{ProviderMode, ProviderModel};
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;
use sidekicks_std::mutex_lock::lock;

use super::{ClaudeDriver, internal, person_settings_folder};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::capabilities::resolve_claude_model_catalog;
use crate::driver::claude::delivery::requests::answers::claude_project_folder;
use crate::driver::claude::inbox_address::{ClaudeSessionInboxAddresser, PlaceInboxEnvironment};
use crate::driver::claude::session::controls::{
    ClaudeSideQuestionCopy, claude_full_model_id, one_turn_legs,
};
use crate::driver::claude::session::errors::{ClaudeSessionError, record_unheard_claude_failure};
use crate::driver::claude::session::establishment::ClaudeSpawnSources;
use crate::driver::claude::session::establishment::context::resolve_claude_spawn_context;
use crate::driver::claude::session::permission_level::{
    ClaudeStartingLevelSources, can_run_claude_level, list_claude_modes,
    move_claude_permission_level, read_claude_sandbox_support, read_claude_starting_level,
};
use crate::driver::claude::session::permissions::{
    ClaudeProjectRuleRemoval, read_claude_session_rules, resend_claude_permissions,
    revoke_claude_project_rule,
};
use crate::driver::claude::session::settings_file::read_claude_settings_file;
use crate::driver::claude::session::transport::readings::ClaudeSessionFolderReadRequest;
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::session::ultracode::{claude_session_options, observe_claude_options};
use crate::driver::claude::settings_rows::compose_claude_rows;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::claude::spawn::launch::{
    ClaudeLaunchError, initialize_reply::read_claude_initialize_declaration,
};
use crate::driver::claude::spawn::legs::{
    ClaudeSpawnLegServices, ClaudeSpawnLegsRequest, build_claude_spawn_bound_legs,
};
use crate::driver::contract::ProviderCommandsSubscription;
use crate::driver::contract::{DriverError, GetCapabilitiesResult, ListModelsParams};
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::ports::SessionPlace;
use crate::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, DriverAuthProbeResult,
    DriverAuthProbeStatus, ProviderCommandsListener, ResumeSessionParams, RevokeRuleParams,
    SessionCommandAnswer, StartReviewParams, StartingLevel, StartingLevelParams,
    SubscribeProviderCommandsParams, UpdatePermissionLevelParams, UpdateSessionModeParams,
    build_auth_probe_result,
};
use crate::port::session_inbox_address::SessionInboxAddresser;
use sidekicks_std::port_registration::PortRegistration;

/// The model a read of the build's own choices runs on: Claude Code's pointer to its recommended
/// model, which every account's catalog lists.
const CLAUDE_DEFAULT_MODEL: &str = "default";

/// The key of the person's own output style in Claude Code's settings.
const OUTPUT_STYLE_KEY: &str = "outputStyle";

/// The key of the person's own advisor in Claude Code's settings, empty for none.
const ADVISOR_MODEL_KEY: &str = "advisorModel";

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
            .account_environment(params.provider_account_id.as_ref())
            .await?;
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
    /// when it opens. A project rule is looked for in the config folder of the home the session
    /// ran on last, the person's own where no process of it is known. Fails as the removal, the
    /// rules' read or the resend fails.
    pub(crate) async fn revoke_rule(&self, params: RevokeRuleParams) -> Result<(), DriverError> {
        let parts = self.composed_parts();
        let live = parts.and_then(|parts| parts.slots().live_session(params.session_id));
        if let Some(project_folder) = &params.project_folder {
            let spawn_environment = match &live {
                Some(live) => Some(live.spawn_bound_legs.spawn_environment.clone()),
                None => parts
                    .and_then(|parts| parts.restarts.ended_conversation(params.session_id))
                    .map(|ended| ended.spawn_environment),
            };
            let config_folder = spawn_environment
                .and_then(|environment| claude_config_folder(&environment, PathRules::NATIVE))
                .unwrap_or_else(|| person_settings_folder(&self.sources.home_folder));
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

    /// The models Claude Code offers on the account the params name, read from a process that
    /// keeps nothing in the session's own place and account home, or the account's home where no
    /// session is named. Fails as the account's folders, the read or the catalog fails.
    pub(crate) async fn list_models(
        &self,
        params: ListModelsParams,
    ) -> Result<Vec<ProviderModel>, DriverError> {
        let environment = match params.session_id {
            Some(session_id) => {
                let context = self
                    .sources
                    .ports
                    .spawn_contexts
                    .require_port()
                    .map_err(internal)?
                    .resolve_spawn_context(session_id, params.provider_account_id.clone())
                    .await
                    .map_err(DriverError::Internal)?;
                let account = context
                    .account_folders
                    .zip(params.provider_account_id.as_ref());
                self.process_environment(account, &[], &[])?
            }
            None => {
                self.account_environment(params.provider_account_id.as_ref())
                    .await?
            }
        };
        let reading = self.starts.read_model_catalog(environment.clone()).await?;
        resolve_claude_model_catalog(reading, &self.figures.current(), &environment)
    }

    /// The levels Claude Code runs on this system, as modes.
    pub(crate) async fn list_modes(&self) -> Result<Vec<ProviderMode>, DriverError> {
        let environment = self.process_environment(None, &[], &[])?;
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
        let environment = self.process_environment(None, &[], &[])?;
        let result = self.starts.read_capabilities(environment).await?;
        self.figures.note_build(&result.cli_version.raw_version);
        Ok(result)
    }

    /// How the person's own Claude Code is signed in, read from a process that takes no turn.
    pub(crate) async fn probe_auth(&self) -> Result<DriverAuthProbeResult, DriverError> {
        let environment = self.process_environment(None, &[], &[])?;
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
    /// session runs with, the choices read from the installed build in the person's own home once
    /// per build and held, so a later read starts no process.
    pub(crate) async fn read_rows(
        &self,
        app_values: ProviderRowValues,
    ) -> Result<Vec<ProviderRow>, DriverError> {
        let environment = self.process_environment(None, &[], &[])?;
        let place = ClaudeSessionFolderReadRequest {
            spawn_environment: environment,
            working_directory: self.sources.home_folder.clone(),
            model: CLAUDE_DEFAULT_MODEL.to_owned(),
        };
        let settings_file = person_settings_folder(&self.sources.home_folder).join("settings.json");
        let (choices, settings) = tokio::join!(
            self.figures.read_command_choices(&place),
            read_claude_settings_file(&settings_file),
        );
        let settings = settings.map_err(internal)?;
        let person_setting = |key: &str| {
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
            person_setting(OUTPUT_STYLE_KEY),
            person_setting(ADVISOR_MODEL_KEY),
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

    /// Asks a side question on a copy of the conversation: the live process's own, else the one
    /// the session's resume material names; resolves once it is asked. Fails `NoLiveSession` for a
    /// session at rest asked with no resume material.
    pub(crate) fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        let copy = match parts.run_start.live_session(session_id) {
            Ok(live) => ready(Ok(ClaudeSideQuestionCopy {
                legs: one_turn_legs(&live, None),
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
        parts.session_controls.ask_side_question(
            session_id,
            params.side_question_id,
            params.question,
            copy,
            Arc::clone(&self.sources.ports.usage),
        );
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

    /// Each session's inbox address in every place the daemon runs sessions in, which Claude
    /// Code's sessions always answer: composed from the places the daemon's start registers, and
    /// until it does, every place answered as one the start did not list.
    #[expect(
        clippy::unnecessary_wraps,
        reason = "the driver interface answers an option, none for a provider with no session inbox"
    )]
    pub(crate) fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>> {
        Some(Arc::new(ClaudeRegisteredPlacesAddresser {
            places: Arc::clone(&self.sources.ports.session_places),
            addresser: OnceLock::new(),
        }))
    }
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
            context,
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
            ..legs
        },
        provider_account_id: resume.provider_account_id,
        parent_provider_session_id: resume.resume_handle,
    })
}

// Claude Code's inbox addresses over the places the daemon's start registers, composed once they
// are; a POSIX place carries the user id its socket folder names, a native Windows place's pipe
// needs none.
struct ClaudeRegisteredPlacesAddresser {
    places: Arc<PortRegistration<Arc<[SessionPlace]>>>,
    addresser: OnceLock<ClaudeSessionInboxAddresser>,
}

impl ClaudeRegisteredPlacesAddresser {
    fn answer<T>(&self, answer: impl FnOnce(&ClaudeSessionInboxAddresser) -> T) -> T {
        if let Some(addresser) = self.addresser.get() {
            return answer(addresser);
        }
        let Some(places) = self.places.port() else {
            return answer(&ClaudeSessionInboxAddresser::new(std::iter::empty()));
        };
        answer(self.addresser.get_or_init(|| {
            ClaudeSessionInboxAddresser::new(places.iter().filter_map(|place| {
                let user_id = place.user_id?;
                Some((
                    place.place.clone(),
                    PlaceInboxEnvironment {
                        login_shell: &place.login_shell,
                        user_id,
                    },
                ))
            }))
        }))
    }
}

impl SessionInboxAddresser for ClaudeRegisteredPlacesAddresser {
    fn session_inbox_address(
        &self,
        session_id: &SessionId,
        place: Option<&Place>,
    ) -> FilesystemPath {
        self.answer(|addresser| addresser.session_inbox_address(session_id, place))
    }

    fn daemon_inbox_address(&self, place: Option<&Place>) -> FilesystemPath {
        self.answer(|addresser| addresser.daemon_inbox_address(place))
    }
}
