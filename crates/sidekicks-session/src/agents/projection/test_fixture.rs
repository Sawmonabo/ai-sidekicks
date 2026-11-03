//! The agents' events as tests write them, the projection's statements run on a test's own
//! connection as the writer runs them, and a log row written as a test spells it.

use rusqlite::{Connection, params, params_from_iter};
use serde_json::{Value, json};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, named_bindings};
use sidekicks_store::database::writer::test_file::test_envelope;

use crate::agents::projection::agents_projection_statements;

/// A binding on `provider` and `model` that follows the provider's current account.
pub(crate) fn binding(provider: &str, model: &str) -> Value {
    json!({
        "providerName": provider,
        "modelId": model,
        "effort": null,
        "providerAccountId": null,
    })
}

/// `session_id`'s birth with its lead `agent_id` on `binding`.
pub(crate) fn session_created(
    session_id: SessionId,
    agent_id: &str,
    binding: &Value,
) -> SessionEvent {
    event(
        "session.created",
        &json!({
            "sessionId": session_id,
            "shape": "chat",
            "mainAgent": {
                "agentId": agent_id,
                "name": "lead",
                "binding": binding,
                "ancestry": [],
                "createdAt": "2026-10-28T09:00:00.000Z",
            },
        }),
    )
}

/// The run `run_id` queued for `agent_id`, minted on `binding` from a saved definition.
pub(crate) fn resolved_run_queued(
    session_id: SessionId,
    run_id: &str,
    agent_id: &str,
    binding: &Value,
) -> SessionEvent {
    event(
        "agent.run.queued",
        &json!({
            "sessionId": session_id,
            "runId": run_id,
            "runVersion": 0,
            "newState": "queued",
            "resolvedAgent": {
                "agentId": agent_id,
                "name": "reviewer",
                "binding": binding,
                "resolvedConfiguration": {
                    "resolvedFromDefinitionId": "019a0000-0000-7000-8000-000000000001",
                    "resolvedBinding": binding,
                    "accentHue": null,
                    "toolAllowlist": null,
                    "instructions": "Review the change.",
                    "goal": null,
                },
                "ancestry": [],
                "createdAt": "2026-10-28T09:01:00.000Z",
            },
            "admittedProviderAccountId": "account-1",
        }),
    )
}

/// The switch `switch_id` of `agent_id` applied in place, from `from` to `to`, landing on
/// `landed`.
pub(crate) fn binding_changed(
    session_id: SessionId,
    agent_id: &str,
    switch_id: &str,
    from: &Value,
    to: &Value,
    landed: &str,
) -> SessionEvent {
    event(
        "agent.providerBinding.changed",
        &json!({
            "switchId": switch_id,
            "declaredLosses": [],
            "continuity": "inPlace",
            "sessionId": session_id,
            "agentId": agent_id,
            "actor": "device-1",
            "from": from,
            "to": to,
            "landedProviderAccountId": landed,
        }),
    )
}

/// The switch `switch_id` of `agent_id`, which stays on `from`, failed for want of its effort.
pub(crate) fn binding_change_failed(
    session_id: SessionId,
    agent_id: &str,
    switch_id: &str,
    from: &Value,
) -> SessionEvent {
    event(
        "agent.providerBinding.changeFailed",
        &json!({
            "switchId": switch_id,
            "reason": "effortUnavailable",
            "sessionId": session_id,
            "agentId": agent_id,
            "actor": "device-1",
            "from": from,
            "attempted": { "effort": "max" },
        }),
    )
}

/// Runs the statements an append of `event` to `session_id`'s log takes for the agents.
pub(crate) fn project(connection: &Connection, session_id: SessionId, event: &SessionEvent) {
    let statements = agents_projection_statements(&test_envelope(session_id, event))
        .expect("the test's event reads as its type's");
    run_statements(connection, &statements);
}

/// Runs `statements` in order, each held to the rows it must change.
pub(crate) fn run_statements(connection: &Connection, statements: &[WriteStatement]) {
    for statement in statements {
        let mut prepared = connection
            .prepare(&statement.sql)
            .expect("the statement prepares");
        let changed = match &statement.bindings {
            StatementBindings::None => prepared.execute([]),
            StatementBindings::Positional(values) => prepared.execute(params_from_iter(values)),
            StatementBindings::Named(values) => prepared.execute(named_bindings(values).as_slice()),
        }
        .expect("the statement runs");
        if let Some(expected) = statement.expected_row_count {
            assert_eq!(changed, expected, "{}", statement.sql);
        }
    }
}

/// Writes one row of `session_id`'s log at `sequence`, an `event_type` event with `payload` as the
/// test spells it, filed under `run_id` where it names one and occurring at `occurred_at`.
pub(crate) fn write_log_row(
    connection: &Connection,
    session_id: SessionId,
    sequence: i64,
    event: (SessionEventType, &Value),
    run_id: Option<RunId>,
    occurred_at: &str,
) {
    let (event_type, payload) = event;
    connection
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload,
                run_id)
             VALUES (?1, ?2, ?3, ?4, ?3, ?5, ?6, ?7, ?8)",
            params![
                mint_uuid_v7().to_string(),
                session_id.text().as_str(),
                sequence,
                occurred_at,
                event_type.category().as_str(),
                event_type.as_str(),
                payload.to_string(),
                run_id.map(|run_id| run_id.text().as_str().to_owned()),
            ],
        )
        .expect("the test writes the row");
}

fn event(event_type: &str, payload: &Value) -> SessionEvent {
    serde_json::from_value(json!({ "type": event_type, "payload": payload }))
        .expect("the test writes a well-formed event")
}
