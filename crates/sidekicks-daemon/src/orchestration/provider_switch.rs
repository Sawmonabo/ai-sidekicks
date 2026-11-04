//! The acceptance of a switch of an agent's provider binding: every axis it names is checked
//! against the target driver before anything is written, then, under the agent's lock, a pick back
//! to the binding the agent is on cancels any pending switch, and any other switch is stored as the
//! agent's one pending switch, replacing the one before, before the answer returns. No event
//! records an accepted switch; its application settles it.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the agent config binder calls it")
)]

use std::sync::Arc;

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::AgentProviderBinding;
use sidekicks_contracts::agent::methods::{AgentConfigUpdateRequest, AgentConfigUpdateResponse};
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingSwitchDisposition, AgentBindingSwitchPending, AgentBindingSwitchTarget,
    PendingSwitchStatus, SwitchId,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::agent::agent_not_found;
use sidekicks_provider::driver::binding_switch::check_binding_switch;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::agents::projection::{
    AgentRow, InterruptDispatch, StoredPendingSwitch, clear_pending_switch, read_agent_row,
    write_pending_switch,
};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

/// The acceptance of agents' binding switches, one for the daemon; see the module doc.
pub(crate) struct ProviderSwitches {
    /// The daemon's read connections, which read the agent's row.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The one writer, which stores or clears the pending switch.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The drivers, whose declared vocabulary each axis is checked against.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// One lock per agent, held from the second read of its row until its write commits.
    pub(crate) locks: KeyedLock<AgentId>,
}

/// Why a switch was not accepted: refused, or its row could not be read or written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ProviderSwitchError {
    /// The agent names no row.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The target driver refused an axis, or its catalog could not be read.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// No read connection could be had.
    #[error("no connection could read the agent")]
    Read(#[from] DatabaseReadError),
    /// The agent's row could not be read.
    #[error("the agent's row could not be read")]
    Query(#[from] rusqlite::Error),
    /// The pending switch could not be written or cleared.
    #[error("the agent's pending switch could not be written")]
    Write(#[from] WriteError),
    /// The row's stored change time does not read as an instant.
    #[error("the agent's row holds no readable change time")]
    UpdatedAt(#[from] NotAnInstant),
}

impl ProviderSwitches {
    /// Accepts `request` from `actor`'s device: refused `agent.notFound` for an agent with no
    /// row, and as the target driver refuses an axis, with nothing written. A pick back answers
    /// `unchanged`, naming the pending switch it canceled; any other switch answers `pending` once
    /// stored, naming the one it replaced.
    pub(crate) async fn accept(
        &self,
        request: AgentConfigUpdateRequest,
        actor: DeviceId,
    ) -> Result<AgentConfigUpdateResponse, ProviderSwitchError> {
        let agent_id = request.agent_id;
        let checked = self.read_row(agent_id).await?;
        let interrupt_requested = request.interrupt_and_switch == Some(true);
        let target = AgentBindingSwitchTarget {
            provider_name: request.provider_name,
            model_id: request.model_id,
            provider_account_id: None,
            effort: request.effort,
            output_speed: request.output_speed,
            options: request.options,
            larger_window: request.larger_window,
        };
        // Checked before the lock, so a slow catalog read holds no other switch of the agent.
        let applies_at = check_binding_switch(
            &self.providers,
            agent_id,
            checked.session_id,
            &checked.binding,
            &target,
        )
        .await?;

        let _hold = self.locks.acquire(agent_id).await;
        let row = self.read_row(agent_id).await?;
        let replaced_switch_id = row.pending_switch.map(|pending| pending.switch.switch_id);
        let switch = if is_pick_back(&row.binding, &target) {
            let Some(canceled) = replaced_switch_id else {
                return Ok(AgentConfigUpdateResponse {
                    agent_id,
                    updated_at: WireInstant::try_from(row.updated_at)?,
                    switch: AgentBindingSwitchDisposition::Unchanged {
                        replaced_switch_id: None,
                    },
                });
            };
            self.writer
                .write(vec![clear_pending_switch(&agent_id, &canceled)])
                .await?;
            AgentBindingSwitchDisposition::Unchanged {
                replaced_switch_id: Some(canceled),
            }
        } else {
            let record = StoredPendingSwitch {
                switch: AgentBindingSwitchPending {
                    status: PendingSwitchStatus::Value,
                    switch_id: SwitchId::new(mint_uuid_v7().to_string())
                        .expect("a minted UUID is a switch id"),
                    applies_at,
                    interrupt_requested,
                    pending_axes: target,
                    replaced_switch_id,
                },
                actor,
                interrupt_dispatch: interrupt_requested.then_some(InterruptDispatch::Requested),
            };
            self.writer
                .write(vec![write_pending_switch(&agent_id, &record)])
                .await?;
            let AgentBindingSwitchPending {
                status: _,
                switch_id,
                applies_at,
                interrupt_requested,
                pending_axes,
                replaced_switch_id,
            } = record.switch;
            AgentBindingSwitchDisposition::Pending {
                switch_id,
                applies_at,
                interrupt_requested,
                pending_axes,
                replaced_switch_id,
            }
        };
        // The row as the write left it, still under the lock, for the time it recorded.
        let written = self.read_row(agent_id).await?;
        Ok(AgentConfigUpdateResponse {
            agent_id,
            updated_at: WireInstant::try_from(written.updated_at)?,
            switch,
        })
    }

    // The row of `agent_id`, refused `agent.notFound` when it has none.
    async fn read_row(&self, agent_id: AgentId) -> Result<AgentRow, ProviderSwitchError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                read_agent_row(connection, &agent_id).map_err(ProviderSwitchError::from)
            })
            .await?
            .ok_or_else(|| agent_not_found(&agent_id).into())
    }
}

// Whether every member `target` names already holds its value on `binding`: an option matches the
// binding's own setting of that id, since an option left out does not move, and a window of `null`
// matches the default window.
fn is_pick_back(binding: &AgentProviderBinding, target: &AgentBindingSwitchTarget) -> bool {
    target
        .provider_name
        .as_ref()
        .is_none_or(|provider| *provider == binding.provider_name)
        && target
            .model_id
            .as_ref()
            .is_none_or(|model| *model == binding.model_id)
        && target
            .effort
            .as_ref()
            .is_none_or(|effort| binding.effort.as_ref() == Some(effort))
        && target
            .output_speed
            .as_ref()
            .is_none_or(|speed| binding.output_speed.as_ref() == Some(speed))
        && target
            .larger_window
            .is_none_or(|window| window == binding.larger_window)
        && target.options.as_ref().is_none_or(|options| {
            options.as_slice().iter().all(|setting| {
                binding
                    .options
                    .as_ref()
                    .is_some_and(|current| current.as_slice().contains(setting))
            })
        })
}

#[cfg(test)]
mod tests;
