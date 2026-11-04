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
    PendingSwitchStatus,
};
use sidekicks_contracts::trust_statement::DeviceId;
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

use crate::orchestration::account_switch::mint_switch_id;

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
        let mut applies_at = check_binding_switch(
            &self.providers,
            agent_id,
            checked.session_id,
            &checked.binding,
            &target,
        )
        .await?;

        let _hold = self.locks.acquire(agent_id).await;
        let row = self.read_row(agent_id).await?;
        // A binding that moved since the first read is checked again before anything is written.
        if row.binding != checked.binding {
            applies_at = check_binding_switch(
                &self.providers,
                agent_id,
                row.session_id,
                &row.binding,
                &target,
            )
            .await?;
        }
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
                    switch_id: mint_switch_id(),
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
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::FutureExt as _;
    use rstest::rstest;
    use rusqlite::Connection;
    use serde_json::{Value, json};
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::agent::provider_binding::{AgentBindingSwitchDisposition, SwitchId};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::test_registry::registry_of_first_provider;
    use sidekicks_session::agents::projection::test_fixture::{
        binding, binding_changed, project, session_created,
    };
    use sidekicks_session::agents::projection::{AgentRow, read_agent_row};
    use sidekicks_std::keyed_lock::KeyedLock;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{ProviderSwitchError, ProviderSwitches};
    use crate::daemon::schema::schema_parts;

    /// The model the agent's binding names.
    const MODEL: &str = "model-a";

    /// The agent a fixture's driver is built for, and the database file its rows are in.
    pub(super) struct SeededAgent {
        /// The database file, which a driver's own write opens.
        pub(super) path: PathBuf,
        /// The agent's session.
        pub(super) session_id: SessionId,
        /// The agent.
        pub(super) agent_id: AgentId,
    }

    /// One agent on the first provider, as the lead of its session.
    pub(super) struct Fixture {
        pub(super) database: TestDatabase,
        pub(super) switches: ProviderSwitches,
        pub(super) session_id: SessionId,
        pub(super) agent_id: AgentId,
    }

    impl Fixture {
        // Over a driver whose catalog lists no model, so every effort is accepted.
        async fn new() -> Self {
            Self::with_driver(|_| {
                let mut driver = MockProviderDriver::new();
                driver
                    .expect_list_models()
                    .returning(|_| async { Ok(Vec::new()) }.boxed());
                driver
            })
            .await
        }

        /// Over the driver `driver_of` builds for the seeded agent.
        pub(super) async fn with_driver(
            driver_of: impl FnOnce(SeededAgent) -> MockProviderDriver,
        ) -> Self {
            let database = TestDatabase::new(schema_parts());
            let writer = Arc::new(
                DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                    .await
                    .expect("the writer opens its database"),
            );
            let session_id = test_session_id();
            let agent_id = mint_uuid_v7().to_string();
            project(
                &database.reader(),
                session_id,
                &session_created(session_id, &agent_id, &binding(PROVIDERS[0].id, MODEL)),
            );
            let agent_id = AgentId::new(&agent_id).expect("a minted UUID is an agent id");
            let driver = driver_of(SeededAgent {
                path: database.path(),
                session_id,
                agent_id,
            });
            let switches = ProviderSwitches {
                // The one statement it prepares reads the agent's row.
                pool: Arc::new(DatabaseReadPool::new(database.path(), 1)),
                writer,
                providers: Arc::new(registry_of_first_provider(Arc::new(driver))),
                locks: KeyedLock::new(),
            };
            Self {
                database,
                switches,
                session_id,
                agent_id,
            }
        }

        async fn accept(
            &self,
            members: Value,
        ) -> Result<AgentBindingSwitchDisposition, ProviderSwitchError> {
            let mut request = json!({ "agentId": self.agent_id });
            request
                .as_object_mut()
                .expect("the request is an object")
                .extend(
                    members
                        .as_object()
                        .expect("the members are an object")
                        .clone(),
                );
            let request = serde_json::from_value(request).expect("the test writes a request");
            let actor = serde_json::from_value(json!("device-1")).expect("the test names a device");
            Ok(self.switches.accept(request, actor).await?.switch)
        }

        pub(super) fn row(&self) -> AgentRow {
            read_agent_row(&self.database.reader(), &self.agent_id)
                .expect("the row reads")
                .expect("the agent has a row")
        }

        fn pending_id(&self) -> Option<SwitchId> {
            self.row()
                .pending_switch
                .map(|pending| pending.switch.switch_id)
        }
    }

    fn pending_ids(disposition: AgentBindingSwitchDisposition) -> (SwitchId, Option<SwitchId>) {
        match disposition {
            AgentBindingSwitchDisposition::Pending {
                switch_id,
                replaced_switch_id,
                ..
            } => (switch_id, replaced_switch_id),
            other @ (AgentBindingSwitchDisposition::Unchanged { .. }
            | AgentBindingSwitchDisposition::Applied { .. }
            | AgentBindingSwitchDisposition::Degraded { .. }
            | AgentBindingSwitchDisposition::Failed { .. }) => {
                unreachable!("a switch off the binding is pending: {other:?}")
            }
        }
    }

    // A second switch replaces the first and names it, and a switch the check refuses leaves the
    // second standing. Killed by the replaced id dropped, and by the write moved before the check.
    #[tokio::test]
    async fn a_later_switch_replaces_the_pending_one_and_a_refused_one_writes_nothing() {
        let fixture = Fixture::new().await;

        let (first, replaced) = pending_ids(
            fixture
                .accept(json!({ "effort": "high" }))
                .await
                .expect("the switch is accepted"),
        );
        assert_eq!(replaced, None);
        let (second, replaced) = pending_ids(
            fixture
                .accept(json!({ "effort": "low" }))
                .await
                .expect("the switch is accepted"),
        );
        assert_eq!(replaced, Some(first));
        assert_eq!(fixture.pending_id(), Some(second.clone()));

        let refused = fixture
            .accept(json!({ "providerName": PROVIDERS[1].id }))
            .await;
        assert!(
            matches!(
                &refused,
                Err(ProviderSwitchError::Driver(
                    DriverError::ProviderAxisInvalid(_)
                ))
            ),
            "a provider no driver answers is refused: {refused:?}"
        );
        assert_eq!(fixture.pending_id(), Some(second));
    }

    // A pick back to the binding the agent is on cancels the pending switch and names it, and with
    // nothing pending writes nothing. Killed by a pick back writing a pending record.
    #[tokio::test]
    async fn a_pick_back_cancels_the_pending_switch_and_otherwise_writes_nothing() {
        let fixture = Fixture::new().await;
        let pick_back = json!({ "modelId": MODEL, "largerWindow": null });

        let (pending, _) = pending_ids(
            fixture
                .accept(json!({ "effort": "high" }))
                .await
                .expect("the switch is accepted"),
        );
        assert_eq!(
            fixture
                .accept(pick_back.clone())
                .await
                .expect("the switch is accepted"),
            AgentBindingSwitchDisposition::Unchanged {
                replaced_switch_id: Some(pending),
            }
        );
        assert_eq!(fixture.pending_id(), None);

        let before = fixture.row().updated_at;
        assert_eq!(
            fixture
                .accept(pick_back)
                .await
                .expect("the switch is accepted"),
            AgentBindingSwitchDisposition::Unchanged {
                replaced_switch_id: None,
            }
        );
        let after = fixture.row();
        assert_eq!(after.pending_switch, None);
        assert_eq!(after.updated_at, before);
    }

    // A binding moved between the first read and the one under the lock is checked again, and an
    // unmoved one is not. Killed by the second check dropped, and by it always run.
    #[rstest]
    #[case::binding_moved(true, 2)]
    #[case::binding_unmoved(false, 1)]
    #[tokio::test]
    async fn accept_checks_again_only_a_binding_moved_since_its_first_check(
        #[case] is_moved: bool,
        #[case] catalog_reads: usize,
    ) {
        let reads = Arc::new(AtomicUsize::new(0));
        let fixture = Fixture::with_driver(|seeded| {
            let reads = Arc::clone(&reads);
            let mut driver = MockProviderDriver::new();
            driver.expect_list_models().returning(move |_| {
                // Another switch lands between the two reads of the row.
                if reads.fetch_add(1, Ordering::SeqCst) == 0 && is_moved {
                    project(
                        &Connection::open(&seeded.path).expect("the test opens the database"),
                        seeded.session_id,
                        &binding_changed(
                            seeded.session_id,
                            seeded.agent_id.text().as_str(),
                            &mint_uuid_v7().to_string(),
                            &binding(PROVIDERS[0].id, MODEL),
                            &binding(PROVIDERS[0].id, "model-b"),
                            "account-1",
                        ),
                    );
                }
                async { Ok(Vec::new()) }.boxed()
            });
            driver
        })
        .await;

        pending_ids(
            fixture
                .accept(json!({ "effort": "high" }))
                .await
                .expect("the switch is accepted"),
        );
        assert_eq!(reads.load(Ordering::SeqCst), catalog_reads);
    }
}
