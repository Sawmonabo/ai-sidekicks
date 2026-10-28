//! A Codex session's controls and the driver's reads: a level or mode move, a side question, a
//! compaction, its goal, a revoked rule, its command list and declared speed; the models, modes,
//! capabilities, sign-in and starting level read on a service; the terminal-reach row; and the
//! expiry of an account home's log rows.

use std::collections::BTreeMap;
use std::error::Error;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::SystemTime;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::{ProviderRowValue, ProviderRowValues};
use sidekicks_contracts::provider::declaration::{
    ProviderDeclarationId, ProviderDeclarationText, ProviderPlaceSwitch, ProviderPlaceSwitches,
    ProviderRow, ProviderSettingControl, ProviderValue,
};
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::provider::driver::commands::ProviderCommandBindingGroup;
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::Record;
use sidekicks_ipc::domain_error::DomainError;

use super::CodexDriver;
use crate::driver::codex::auth_status::{CODEX_AUTH_PROBE_TIMEOUT, read_codex_auth_status};
use crate::driver::codex::capabilities::read_codex_service_model_catalog;
use crate::driver::codex::capability_probe::probe_codex_service_capabilities;
use crate::driver::codex::compaction::{CodexCompactionTarget, dispatch_codex_compaction};
use crate::driver::codex::lifecycle::intake::call_codex_lifecycle;
use crate::driver::codex::model_windows::{
    join_codex_model_windows, read_codex_service_model_windows,
};
use crate::driver::codex::service::command::read_codex_model_catalog_dump;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::lifecycle_call::CodexLifecycleCall;
use crate::driver::codex::session::starting_level::read_codex_starting_level;
use crate::driver::contract::{
    ApplyRowValueParams, CompactContextParams, DriverError, GetCapabilitiesResult,
    ListModelsParams, ListProviderCommandsParams, ProviderCommandsSubscription,
};
use crate::driver::session_control::{
    AskSideQuestionParams, ClearSessionGoalParams, DriverAuthProbeResult, DriverAuthProbeStatus,
    DriverGoalResult, ProviderCommandsListener, RevokeRuleParams, SetSessionGoalParams,
    StartingLevel, StartingLevelParams, SubscribeProviderCommandsParams,
    UpdatePermissionLevelParams, UpdateSessionModeParams, build_auth_probe_result,
};

/// The id of the switch that runs a Codex service on the person's own folder.
const TERMINAL_REACH_ROW_ID: &str = "terminalReach";

/// Its label.
const TERMINAL_REACH_ROW_LABEL: &str = "Reach Codex sessions started in a terminal";

/// The line under it.
const TERMINAL_REACH_ROW_LINE: &str = "Runs one Codex service while it is on, so sidekicks can \
                                       message a Codex session you typed in a terminal.";

impl CodexDriver {
    /// Moves the live conversation to another level from its next turn, once a fork onto its
    /// changed config and a conversation coming back settled. Fails with `CodexError::Transport`
    /// with no live record, and as the move fails.
    pub(crate) async fn update_permission_level(
        &self,
        params: UpdatePermissionLevelParams,
    ) -> Result<(), DriverError> {
        self.config_forks.join(params.session_id).await;
        let inbound = self.slots.require_live_settled(params.session_id).await?;
        call_codex_lifecycle(&inbound, |reply| CodexLifecycleCall::MoveLevel {
            params,
            reply,
        })
        .await??;
        Ok(())
    }

    /// Moves the live conversation between Build and Plan from its next turn. Fails as the level's
    /// move does.
    pub(crate) async fn update_session_mode(
        &self,
        params: UpdateSessionModeParams,
    ) -> Result<(), DriverError> {
        self.config_forks.join(params.session_id).await;
        let inbound = self.slots.require_live_settled(params.session_id).await?;
        call_codex_lifecycle(&inbound, |reply| CodexLifecycleCall::MoveMode {
            mode: params.mode,
            reply,
        })
        .await??;
        Ok(())
    }

    /// Asks a side question on a read-only copy of the session's conversation: the live one, else
    /// the stored one `params.resume` names, forked on the account's service. Fails with
    /// `CodexError::Transport` with neither a live record nor a resume handle, and as the ask
    /// fails.
    pub(crate) async fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> Result<(), DriverError> {
        let inbound = match (self.slots.require_live(params.session_id), &params.resume) {
            (Ok(inbound), _) => inbound,
            (Err(_no_live_record), Some(resume)) => {
                let parts = self.parts()?;
                parts
                    .side_questions
                    .ask_at_rest(
                        &parts.establishment,
                        resume,
                        &params,
                        Arc::clone(&parts.ports.usage),
                    )
                    .await?;
                return Ok(());
            }
            (Err(refusal), None) => return Err(refusal.into()),
        };
        call_codex_lifecycle(&inbound, |reply| CodexLifecycleCall::AskSideQuestion {
            params: Box::new(params),
            reply,
        })
        .await??;
        Ok(())
    }

    /// Compacts the live conversation, settling on Codex's own compaction frame.
    pub(crate) async fn compact_context(
        &self,
        params: CompactContextParams,
    ) -> Result<AgentRunContextCompactResponse, DriverError> {
        let inbound = self.slots.require_live(params.session_id)?;
        let reading = call_codex_lifecycle(&inbound, |reply| CodexLifecycleCall::ReadCompaction {
            reply,
        })
        .await?;
        let connection = reading.connection?;
        Ok(dispatch_codex_compaction(
            &connection,
            &self.pending_compactions,
            CodexCompactionTarget {
                session_id: params.session_id,
                provider_account_id: reading.provider_account_id.as_ref(),
                thread_id: &reading.thread_id,
                wait_key: &reading.wait_key,
            },
        )
        .await)
    }

    /// Sets the session's goal on its conversation.
    pub(crate) async fn set_session_goal(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, DriverError> {
        Ok(self.parts()?.goals.set(params).await?)
    }

    /// Clears the session's goal on its conversation.
    pub(crate) async fn clear_session_goal(
        &self,
        params: ClearSessionGoalParams,
    ) -> Result<DriverGoalResult, DriverError> {
        Ok(self.parts()?.goals.clear(params).await?)
    }

    /// Takes a revoked project rule out of the project's own rule file. A rule the session made
    /// needs nothing here: the call checks read each revocation at the next call it covers.
    pub(crate) async fn revoke_rule(&self, params: RevokeRuleParams) -> Result<(), DriverError> {
        let Some(project_folder) = &params.project_folder else {
            return Ok(());
        };
        self.project_rules
            .revoke(project_folder, &params.rule)
            .await
            .map_err(|error| DriverError::Internal(Box::new(error)))
    }

    /// The models of the account the params name, each with its windows from the catalog dump.
    /// A catalog read that asks for a restart restarts the service and reads once more. Fails as
    /// the service's start or the catalog read fails.
    pub(crate) async fn list_models(
        &self,
        params: ListModelsParams,
    ) -> Result<Vec<ProviderModel>, DriverError> {
        let service = self
            .registry
            .service_for(params.provider_account_id.as_ref())
            .await?;
        let models = match read_service_models(&service).await {
            Err(DriverError::Internal(error))
                if error
                    .downcast_ref::<CodexError>()
                    .is_some_and(CodexError::asks_for_restart) =>
            {
                self.parts()?
                    .recovery
                    .restart_service(&service, None)
                    .await?;
                read_service_models(&service).await?
            }
            read => read?,
        };
        let windows = read_codex_service_model_windows(
            read_codex_model_catalog_dump(&service),
            service.home(),
        )
        .await;
        Ok(join_codex_model_windows(models, &windows))
    }

    /// The capabilities, tools and version of the build the person's own home runs, read live.
    pub(crate) async fn get_capabilities(&self) -> Result<GetCapabilitiesResult, DriverError> {
        let service = self.registry.service_for(None).await?;
        probe_codex_service_capabilities(&service).await
    }

    /// How the person's own Codex is signed in, read without a refresh; a read that fails is
    /// indeterminate.
    pub(crate) async fn probe_auth(&self) -> DriverAuthProbeResult {
        let read = async {
            let service = self.registry.service_for(None).await?;
            service
                .ensure_started(service.dependencies().startup_timeout)
                .await?;
            let connection = service.connection()?;
            Ok::<_, DriverError>(
                read_codex_auth_status(&connection, CODEX_AUTH_PROBE_TIMEOUT).await?,
            )
        };
        match read.await {
            Ok(result) => result,
            Err(error) => {
                build_auth_probe_result(DriverAuthProbeStatus::Indeterminate, &error.to_string())
            }
        }
    }

    /// The level and mode a new session starts at, as the person's own Codex settings for the
    /// folder set them.
    pub(crate) async fn read_starting_level(
        &self,
        params: StartingLevelParams,
    ) -> Result<StartingLevel, DriverError> {
        let service = self.registry.service_for(None).await?;
        Ok(read_codex_starting_level(&service, &params.working_folder).await?)
    }

    /// The live session's command list, as one group carrying the params' run and binding. Fails
    /// with `CodexError::Transport` with no live record, and as the list's read fails.
    pub(crate) async fn list_provider_commands(
        &self,
        params: ListProviderCommandsParams,
    ) -> Result<ProviderCommandBindingGroup, DriverError> {
        let source = self
            .views
            .command_source(params.session_id)
            .ok_or_else(|| CodexError::Transport {
                detail: format!("No live Codex session for \"{}\".", params.session_id),
                cause: None,
            })?;
        let listed = self
            .provider_commands
            .compose_provider_command_list(&source)
            .await?;
        let entries = listed
            .bindings
            .into_vec()
            .into_iter()
            .flat_map(|group| group.entries)
            .collect();
        Ok(ProviderCommandBindingGroup {
            run_id: params.run_id,
            binding: params.binding,
            entries,
        })
    }

    /// Follows the session's live command list until the subscription drops.
    pub(crate) fn subscribe_provider_commands(
        &self,
        params: &SubscribeProviderCommandsParams,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        self.provider_commands
            .subscribe(params.session_id, listener)
    }

    /// The tier the session's live conversation last declared, as sent.
    pub(crate) fn observed_output_speed_for(
        &self,
        session_id: SessionId,
    ) -> Option<ProviderOutputSpeedState> {
        self.views.declared_output_speed(session_id)
    }

    /// The terminal-reach switch, one per place the computer has, each read from that place's
    /// terminal service: on while it is up or on its way back up. The computer has one place, the
    /// one a computer without a WSL 2 distribution names none for.
    pub(crate) fn read_rows(&self, _app_values: &ProviderRowValues) -> Vec<ProviderRow> {
        let switch = ProviderPlaceSwitch {
            place: None,
            enabled: self.registry.is_terminal_service_on(),
        };
        vec![ProviderRow::Setting {
            id: terminal_reach_row_id(),
            label: written_text(TERMINAL_REACH_ROW_LABEL),
            line: Some(written_text(TERMINAL_REACH_ROW_LINE)),
            control: ProviderSettingControl::Switch {
                places: ProviderPlaceSwitches::new(vec![switch])
                    .expect("one place is within the bounds"),
            },
        }]
    }

    /// Terminal reach on in the computer's own place, where the app stored no value.
    pub(crate) fn row_defaults() -> ProviderRowValues {
        let switches = ProviderPlaceSwitches::new(vec![ProviderPlaceSwitch {
            place: None,
            enabled: true,
        }])
        .expect("one place is within the bounds");
        Record::new(BTreeMap::from([(
            terminal_reach_row_id(),
            ProviderRowValue::Places(switches),
        )]))
        .expect("a row id is never the prototype key")
    }

    /// Turns terminal reach on or off in `params.place`: on starts the terminal service on the
    /// person's own folder unless it is on already, and the switch reads on only once it started;
    /// off answers once the service left the folder, which retires it once no terminal session is
    /// inside it. Another row is none of Codex's. Fails with `provider.place.notOffered` for a
    /// place the computer does not have, and as the start or the home's resolve fails.
    pub(crate) async fn apply_row_value(
        &self,
        params: ApplyRowValueParams,
    ) -> Result<(), DriverError> {
        if params.row_id != terminal_reach_row_id() {
            return Ok(());
        }
        if params.place.is_some() {
            return Err(DomainError::new(
                "Codex reaches terminals in no other place on this computer.".to_owned(),
                RefusalCode::ProviderPlaceNotOffered,
            )
            .into());
        }
        if !matches!(params.value, Some(ProviderValue::Switch(true))) {
            self.is_terminal_reach_on.store(false, Ordering::Release);
            self.registry.stop_terminal_service().await?;
            return Ok(());
        }
        if self.registry.is_terminal_service_on() {
            return Ok(());
        }
        let started = self.registry.start_terminal_service().await;
        self.is_terminal_reach_on
            .store(started.is_ok(), Ordering::Release);
        started
    }

    /// Deletes the account home's log rows from before `cutoff`, and, while no service holds the
    /// home, compacts the log database so no deleted row's text stays in its free space; a failed
    /// compaction is logged. Blocking. Fails as the delete fails.
    pub(crate) fn expire_account_home_diagnostics(
        &self,
        home: &Path,
        cutoff: SystemTime,
    ) -> Result<u64, Box<dyn Error + Send + Sync>> {
        self.log_expiry
            .expire(home, cutoff, || self.registry.is_home_quiet(home))
    }
}

// The service's catalog, the service started first.
async fn read_service_models(service: &CodexService) -> Result<Vec<ProviderModel>, DriverError> {
    service
        .ensure_started(service.dependencies().startup_timeout)
        .await?;
    let connection = service.connection()?;
    read_codex_service_model_catalog(&connection).await
}

fn terminal_reach_row_id() -> ProviderDeclarationId {
    ProviderDeclarationId::new(TERMINAL_REACH_ROW_ID.to_owned()).expect("the row's id fits")
}

// The driver's own words, which fit a declaration's text.
fn written_text(text: &str) -> ProviderDeclarationText {
    ProviderDeclarationText::new(text.to_owned()).expect("the driver's own words fit")
}
