use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingSwitchBoundary, AgentBindingSwitchPending, AgentBindingSwitchTarget,
    PendingSwitchStatus, SwitchId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_store::events::test_log::stored_envelope;

use super::test_fixture::{
    binding, binding_change_failed, binding_changed, project, resolved_run_queued, run_statements,
    session_created,
};
use super::{
    AgentRow, AgentsProjection, InterruptDispatch, StoredPendingSwitch, read_agent_row,
    read_session_agents, write_pending_switch,
};
use crate::agents::schema::schema_parts;

// A database on the agents' schema, and one session in it.
struct Agents {
    _database: TestDatabase,
    connection: Connection,
    session_id: SessionId,
}

impl Agents {
    fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let connection = database.opener()().expect("the test creates its database");
        Self {
            _database: database,
            connection,
            session_id: test_session_id(),
        }
    }

    fn row(&self, agent_id: &str) -> AgentRow {
        read_agent_row(&self.connection, &agent_id_of(agent_id))
            .expect("the row reads")
            .expect("the agent has a row")
    }
}

fn agent_id_of(text: &str) -> AgentId {
    AgentId::new(text).expect("a minted UUID is an agent id")
}

fn pending_switch(switch_id: &str, dispatch: Option<InterruptDispatch>) -> StoredPendingSwitch {
    StoredPendingSwitch {
        switch: AgentBindingSwitchPending {
            status: PendingSwitchStatus::Value,
            switch_id: SwitchId::new(switch_id.to_owned()).expect("the test's switch id is text"),
            applies_at: AgentBindingSwitchBoundary::TurnBoundary,
            interrupt_requested: dispatch.is_some(),
            pending_axes: serde_json::from_value::<AgentBindingSwitchTarget>(json!({
                "effort": "high",
                "outputSpeed": "fast",
            }))
            .expect("the test writes a switch's target"),
            replaced_switch_id: None,
        },
        actor: serde_json::from_value(json!("device-1")).expect("the test names a device"),
        interrupt_dispatch: dispatch,
    }
}

// Killed by the id check dropped from a minted agent's birth: the second fold of the same
// `agent.run.queued` then refuses on the agent's key.
#[test]
fn the_lead_and_a_minted_agent_fold_to_one_row_each() {
    let agents = Agents::new();
    let provider = PROVIDERS[0].id;
    let (lead, helper) = (mint_uuid_v7().to_string(), mint_uuid_v7().to_string());
    let created = session_created(agents.session_id, &lead, &binding(provider, "model-a"));
    let queued = resolved_run_queued(
        agents.session_id,
        &mint_uuid_v7().to_string(),
        &helper,
        &binding(provider, "model-b"),
    );
    project(&agents.connection, agents.session_id, &created);
    project(&agents.connection, agents.session_id, &queued);
    project(&agents.connection, agents.session_id, &queued);

    let rows = read_session_agents(&agents.connection, &agents.session_id).expect("the rows read");
    let named: Vec<(String, &str, &str)> = rows
        .iter()
        .map(|row| {
            (
                row.agent_id.text().as_str().to_owned(),
                row.name.as_str(),
                row.binding.model_id.as_str(),
            )
        })
        .collect();
    assert_eq!(
        named,
        [
            (lead, "lead", "model-a"),
            (helper.clone(), "reviewer", "model-b"),
        ]
    );
    let minted = agents.row(&helper);
    assert_eq!(minted.instructions.as_deref(), Some("Review the change."));
    assert!(minted.resolved_from_definition_id.is_some());
}

// Killed by the binding columns moved on a failed switch, by the pending switch left standing
// after either settlement, and by the account a switch landed on written as the one it pins.
#[test]
fn a_landed_switch_moves_the_binding_and_a_failed_one_only_clears() {
    let agents = Agents::new();
    let (first, second) = (PROVIDERS[0].id, PROVIDERS[1].id);
    let lead = mint_uuid_v7().to_string();
    let born = binding(first, "model-a");
    project(
        &agents.connection,
        agents.session_id,
        &session_created(agents.session_id, &lead, &born),
    );

    run_statements(
        &agents.connection,
        &[write_pending_switch(
            &agent_id_of(&lead),
            &pending_switch("switch-1", None),
        )],
    );
    let mut landed: Value = binding(second, "model-b");
    landed["effort"] = json!("high");
    landed["outputSpeed"] = json!("fast");
    landed["options"] = json!([{ "id": "fastMode", "value": true }]);
    landed["largerWindow"] = json!(1_000_000);
    project(
        &agents.connection,
        agents.session_id,
        &binding_changed(
            agents.session_id,
            &lead,
            "switch-1",
            &born,
            &landed,
            "account-1",
        ),
    );
    let switched = agents.row(&lead);
    assert_eq!(
        serde_json::to_value(&switched.binding).expect("a binding writes as JSON"),
        landed
    );
    assert_eq!(
        switched.pending_switch, None,
        "the landed switch is cleared"
    );

    run_statements(
        &agents.connection,
        &[write_pending_switch(
            &agent_id_of(&lead),
            &pending_switch("switch-2", None),
        )],
    );
    project(
        &agents.connection,
        agents.session_id,
        &binding_change_failed(agents.session_id, &lead, "switch-2", &landed),
    );
    let failed = agents.row(&lead);
    assert_eq!(
        failed.binding, switched.binding,
        "a failure moves no column"
    );
    assert_eq!(failed.pending_switch, None, "the failed switch is cleared");
}

// Killed by `interruptDispatch` dropped from the stored record, and by the record read back
// without the device or the shared members it flattens.
#[test]
fn a_pending_switch_reads_back_as_it_was_written() {
    let agents = Agents::new();
    let lead = mint_uuid_v7().to_string();
    project(
        &agents.connection,
        agents.session_id,
        &session_created(
            agents.session_id,
            &lead,
            &binding(PROVIDERS[0].id, "model-a"),
        ),
    );
    let record = pending_switch("switch-1", Some(InterruptDispatch::Dispatched));
    run_statements(
        &agents.connection,
        &[write_pending_switch(&agent_id_of(&lead), &record)],
    );
    assert_eq!(agents.row(&lead).pending_switch, Some(record));
}

// A rebuild keeps a pending switch on a row whose birth it replays, and drops a kept row whose
// birth it never read, as one in a range of the log it skipped. Killed by no closing delete (the
// unborn row kept), and by a closing delete of every kept row (the lead's switch lost).
#[test]
fn a_rebuild_keeps_a_born_agents_switch_and_drops_an_unborn_one() {
    let agents = Agents::new();
    let provider = PROVIDERS[0].id;
    let (lead, helper) = (mint_uuid_v7().to_string(), mint_uuid_v7().to_string());
    let created = session_created(agents.session_id, &lead, &binding(provider, "model-a"));
    project(&agents.connection, agents.session_id, &created);
    project(
        &agents.connection,
        agents.session_id,
        &resolved_run_queued(
            agents.session_id,
            &mint_uuid_v7().to_string(),
            &helper,
            &binding(provider, "model-b"),
        ),
    );
    let record = pending_switch("switch-1", None);
    run_statements(
        &agents.connection,
        &[
            write_pending_switch(&agent_id_of(&lead), &record),
            write_pending_switch(&agent_id_of(&helper), &pending_switch("switch-2", None)),
        ],
    );

    run_statements(
        &agents.connection,
        &AgentsProjection.clear_statements(&agents.session_id),
    );
    let mut fold = AgentsProjection.fold(&agents.session_id);
    let mut statements = Vec::new();
    fold.apply(
        &stored_envelope(&test_envelope(agents.session_id, &created), 0),
        &created,
        &mut statements,
    )
    .expect("the lead's birth folds");
    statements.extend(fold.closing_statements());
    run_statements(&agents.connection, &statements);

    let rows = read_session_agents(&agents.connection, &agents.session_id).expect("the rows read");
    let kept: Vec<String> = rows
        .iter()
        .map(|row| row.agent_id.text().as_str().to_owned())
        .collect();
    assert_eq!(kept, [lead.clone()]);
    assert_eq!(agents.row(&lead).pending_switch, Some(record));
}
