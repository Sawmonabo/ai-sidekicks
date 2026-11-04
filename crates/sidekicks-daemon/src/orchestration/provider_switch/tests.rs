use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::provider_binding::{AgentBindingSwitchDisposition, SwitchId};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_session::agents::projection::test_fixture::{binding, project, session_created};
use sidekicks_session::agents::projection::{AgentRow, read_agent_row};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::{ProviderSwitchError, ProviderSwitches};
use crate::daemon::schema::schema_parts;

/// The model the agent's binding names.
const MODEL: &str = "model-a";

// One agent on the first provider, whose catalog lists no model, so every effort is accepted.
struct Fixture {
    database: TestDatabase,
    switches: ProviderSwitches,
    agent_id: AgentId,
}

impl Fixture {
    async fn new() -> Self {
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
        let mut driver = MockProviderDriver::new();
        driver
            .expect_list_models()
            .returning(|_| async { Ok(Vec::new()) }.boxed());
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
            agent_id: AgentId::new(&agent_id).expect("a minted UUID is an agent id"),
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

    fn row(&self) -> AgentRow {
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
