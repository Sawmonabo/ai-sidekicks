//! The `agents` rows as the log keeps them in step: the lead from `session.created`, an agent
//! minted from a saved definition from the `agent.run.queued` that mints it, the binding an
//! applied switch lands from `agent.providerBinding.changed`, and the settled switch's clear from
//! either binding event. The daemon's own writes of the pending switch, the typed row and its
//! reads sit beside them. A rebuild writes every row through the live write's own statements and
//! keeps a pending switch, which no event carries.

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::LazyLock;

use rusqlite::types::{Type, Value as SqlValue};
use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::binding::{AgentProviderBinding, ProviderToken};
use sidekicks_contracts::agent::definition::{AgentDefinitionId, AgentId, ToolName};
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingSwitchPending, AgentProviderBindingChangedPayload, SwitchId,
};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{
    StoredJsonFault, optional_text_column, text_column,
};
use sidekicks_store::events::log_service::ProjectionError;
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;

#[cfg(test)]
pub(crate) mod test_fixture;
#[cfg(test)]
mod tests;

// Every type the fold reads: the lead's birth, a minted agent's, and a switch's two settlements.
const AGENTS_EVENT_TYPES: [SessionEventType; 4] = [
    SessionEventType::SessionCreated,
    SessionEventType::AgentRunQueued,
    SessionEventType::AgentProviderBindingChanged,
    SessionEventType::AgentProviderBindingChangeFailed,
];

const INSERT_AGENT_SQL: &str = "INSERT INTO agents
  (id, session_id, name, provider_name, model_id, provider_account_id, effort, options,
   output_speed, larger_window, instructions, resolved_from_definition_id, created_at, updated_at)
  VALUES (@agentId, @sessionId, @name, @providerName, @modelId, @providerAccountId, @effort,
          @options, @outputSpeed, @largerWindow, @instructions, @resolvedFromDefinitionId,
          @createdAt, @updatedAt)";

// An agent's birth when its id is new; an agent already in the table keeps its row.
static INSERT_NEW_AGENT_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{INSERT_AGENT_SQL}\n  ON CONFLICT(id) DO NOTHING"));

// An agent's birth over the row a rebuild kept for its pending switch, which it leaves standing.
static REFRESH_AGENT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{INSERT_AGENT_SQL}
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id, name = excluded.name,
    provider_name = excluded.provider_name, model_id = excluded.model_id,
    provider_account_id = excluded.provider_account_id, effort = excluded.effort,
    options = excluded.options, output_speed = excluded.output_speed,
    larger_window = excluded.larger_window, instructions = excluded.instructions,
    resolved_from_definition_id = excluded.resolved_from_definition_id,
    created_at = excluded.created_at, updated_at = excluded.updated_at"
    )
});

// An applied switch's binding, which clears the pending switch it settles.
const LAND_BINDING_SQL: &str = "UPDATE agents SET
    provider_name = @providerName, model_id = @modelId, provider_account_id = @providerAccountId,
    effort = @effort, options = @options, output_speed = @outputSpeed,
    larger_window = @largerWindow,
    pending_switch = CASE WHEN json_extract(pending_switch, '$.switchId') = @switchId
                          THEN NULL ELSE pending_switch END,
    updated_at = @updatedAt
  WHERE id = @agentId";

const WRITE_PENDING_SWITCH_SQL: &str = "UPDATE agents SET pending_switch = @pendingSwitch, updated_at = @updatedAt WHERE id = @agentId";

// Clears the pending switch `@switchId` names; a switch replaced since is left standing.
const CLEAR_PENDING_SWITCH_SQL: &str =
    "UPDATE agents SET pending_switch = NULL, updated_at = @updatedAt
  WHERE id = @agentId AND json_extract(pending_switch, '$.switchId') = @switchId";

// A rebuild keeps the rows holding a pending switch, which the log cannot write again.
const CLEAR_SESSION_AGENTS_SQL: &str =
    "DELETE FROM agents WHERE session_id = ? AND pending_switch IS NULL";

const AGENT_COLUMNS: &str = "id, session_id, name, provider_name, model_id, provider_account_id,
  effort, options, output_speed, larger_window, instructions, resolved_from_definition_id,
  pending_switch, created_at, updated_at";

static SELECT_AGENT_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT {AGENT_COLUMNS} FROM agents WHERE id = @agentId"));

static SELECT_SESSION_AGENTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {AGENT_COLUMNS} FROM agents WHERE session_id = @sessionId
  ORDER BY created_at, rowid"
    )
});

/// Whether an interrupt a pending switch asked for has gone out: `requested` until the run
/// accepted it, then `dispatched`, so a restart sends it again only when it never went out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InterruptDispatch {
    /// Asked for and not yet accepted by the run.
    Requested,
    /// Accepted by the run.
    Dispatched,
}

/// The switch an agent has pending as its row stores it: the record its acknowledgment and
/// `agent.subscribe` carry, with the device that asked for it and, on a switch that interrupts,
/// how far the interrupt went, neither of which a caller is ever sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPendingSwitch {
    /// The record a caller is sent.
    #[serde(flatten)]
    pub switch: AgentBindingSwitchPending,
    /// The device whose connection carried the switch, which its settlement names.
    pub actor: DeviceId,
    /// How far the interrupt went, present exactly when the switch asked for one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupt_dispatch: Option<InterruptDispatch>,
}

/// An agent of a session as its row holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRow {
    /// The agent.
    pub agent_id: AgentId,
    /// Its session.
    pub session_id: SessionId,
    /// Its name.
    pub name: ToolName,
    /// The binding it runs on now, its account the one the binding pins, `None` for one that
    /// follows the provider's current account.
    pub binding: AgentProviderBinding,
    /// The instructions as applied, from the saved definition it was resolved from.
    pub instructions: Option<String>,
    /// The saved definition it was resolved from.
    pub resolved_from_definition_id: Option<AgentDefinitionId>,
    /// The switch it has pending.
    pub pending_switch: Option<StoredPendingSwitch>,
    /// When it joined the session, in the stored form.
    pub created_at: String,
    /// When its row last moved, in the stored form.
    pub updated_at: String,
}

/// The statements that keep the agents in step with an append, run in the append's own write for
/// each event it stores. Fails when the event's payload does not read as its type's, which refuses
/// the append.
pub fn agents_projection_statements(
    envelope: &UnsequencedEventEnvelope,
) -> Result<Vec<WriteStatement>, ProjectionError> {
    if !AGENTS_EVENT_TYPES.contains(&envelope.event_type()) {
        return Ok(Vec::new());
    }
    let event = SessionEvent::from_payload(envelope.event_type(), envelope.payload())?;
    Ok(event_statements(
        &event,
        envelope.occurred_at.as_str(),
        |_| BirthConflict::Keep,
    ))
}

/// Writes `record` as the switch `agent_id` has pending, replacing any it had. Refused when the
/// agent has no row.
pub fn write_pending_switch(agent_id: &AgentId, record: &StoredPendingSwitch) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(WRITE_PENDING_SWITCH_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding(
                "@pendingSwitch",
                &serde_json::to_string(record).expect("a pending switch writes as JSON"),
            ),
            text_binding("@updatedAt", WireInstant::now().as_str()),
            text_binding("@agentId", agent_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// Clears the switch `switch_id` that `agent_id` has pending. Refused when the agent has another
/// pending, or none, so a switch replaced since is never cleared.
pub fn clear_pending_switch(agent_id: &AgentId, switch_id: &SwitchId) -> WriteStatement {
    WriteStatement {
        expected_row_count: Some(1),
        ..clear_statement(agent_id, switch_id, WireInstant::now().as_str())
    }
}

/// The row of `agent_id`, or `None` when the table holds none. Fails as SQLite does, or when a
/// stored column does not read as its type.
pub fn read_agent_row(
    connection: &Connection,
    agent_id: &AgentId,
) -> rusqlite::Result<Option<AgentRow>> {
    connection
        .prepare_cached(&SELECT_AGENT_SQL)?
        .query_row(
            named_params! { "@agentId": agent_id.text().as_str() },
            agent_row,
        )
        .optional()
}

/// The rows of `session_id`'s agents, in the order they joined it. Fails as [`read_agent_row`]
/// does.
pub fn read_session_agents(
    connection: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<AgentRow>> {
    connection
        .prepare_cached(&SELECT_SESSION_AGENTS_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            agent_row,
        )?
        .collect()
}

/// The `agents` rows as a rebuild replaces them, keeping each pending switch.
#[derive(Clone, Copy, Debug)]
pub struct AgentsProjection;

impl SessionProjection for AgentsProjection {
    fn name(&self) -> &'static str {
        "agents"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &AGENTS_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![WriteStatement {
            sql: Cow::Borrowed(CLEAR_SESSION_AGENTS_SQL),
            bindings: StatementBindings::Positional(vec![SqlValue::Text(
                session_id.text().as_str().to_owned(),
            )]),
            expected_row_count: None,
        }]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(AgentsFold {
            born: HashSet::new(),
        })
    }
}

// The agents a rebuild has written so far: an agent's first birth refreshes the row the clear
// kept for its pending switch, and any later one keeps what is there.
struct AgentsFold {
    born: HashSet<AgentId>,
}

impl SessionProjectionFold for AgentsFold {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        statements.extend(event_statements(
            event,
            envelope.occurred_at.as_str(),
            |agent_id| {
                if self.born.insert(*agent_id) {
                    BirthConflict::Refresh
                } else {
                    BirthConflict::Keep
                }
            },
        ));
        Ok(())
    }
}

// What an agent's birth does to a row already holding its id.
enum BirthConflict {
    // Leaves it as it is.
    Keep,
    // Writes the birth's columns over it, its pending switch kept.
    Refresh,
}

// An agent's birth, as the event that brings it in carries it.
struct AgentBirth<'event> {
    agent_id: &'event AgentId,
    session_id: SessionId,
    name: &'event ToolName,
    binding: &'event AgentProviderBinding,
    instructions: Option<&'event str>,
    resolved_from_definition_id: Option<&'event AgentDefinitionId>,
    created_at: &'event str,
}

// The statements `event`, occurring at `occurred_at`, writes; `conflict_of` answers what a birth
// does to a row already holding its agent.
fn event_statements(
    event: &SessionEvent,
    occurred_at: &str,
    mut conflict_of: impl FnMut(&AgentId) -> BirthConflict,
) -> Vec<WriteStatement> {
    let birth = if let SessionEvent::SessionCreated(created) = event {
        let lead = &created.main_agent;
        let resolved = lead.resolved_configuration.as_ref();
        AgentBirth {
            agent_id: &lead.agent_id,
            session_id: created.session_id,
            name: &lead.name,
            binding: &lead.binding,
            instructions: resolved.map(|configuration| configuration.instructions.as_str()),
            resolved_from_definition_id: resolved
                .map(|configuration| &configuration.resolved_from_definition_id),
            created_at: lead.created_at.as_str(),
        }
    } else if let SessionEvent::AgentRunQueued(AgentRunQueuedPayload::ResolvedAgent(queued)) = event
    {
        let agent = &queued.resolved_agent;
        AgentBirth {
            agent_id: &agent.agent_id,
            session_id: queued.session_id,
            name: &agent.name,
            binding: &agent.binding,
            instructions: Some(agent.resolved_configuration.instructions.as_str()),
            resolved_from_definition_id: Some(
                &agent.resolved_configuration.resolved_from_definition_id,
            ),
            created_at: agent.created_at.as_str(),
        }
    } else if let SessionEvent::AgentProviderBindingChanged(changed) = event {
        return vec![land_binding_statement(changed, occurred_at)];
    } else if let SessionEvent::AgentProviderBindingChangeFailed(failed) = event {
        return vec![clear_statement(
            &failed.agent_id,
            &failed.switch_id,
            occurred_at,
        )];
    } else {
        return Vec::new();
    };
    let sql = match conflict_of(birth.agent_id) {
        BirthConflict::Keep => INSERT_NEW_AGENT_SQL.as_str(),
        BirthConflict::Refresh => REFRESH_AGENT_SQL.as_str(),
    };
    let mut bindings = vec![
        text_binding("@agentId", birth.agent_id.text().as_str()),
        text_binding("@sessionId", birth.session_id.text().as_str()),
        text_binding("@name", birth.name.as_str()),
        nullable_text_binding("@instructions", birth.instructions),
        nullable_text_binding(
            "@resolvedFromDefinitionId",
            birth
                .resolved_from_definition_id
                .map(AgentDefinitionId::text)
                .as_ref()
                .map(UuidText::as_str),
        ),
        text_binding("@createdAt", birth.created_at),
        text_binding("@updatedAt", occurred_at),
    ];
    bindings.extend(binding_columns(birth.binding));
    vec![WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: None,
    }]
}

// The binding an applied switch lands, with the account its `to` pins and never the one it landed
// on, so an agent that follows the current account still follows it; clearing the pending switch
// it settles.
fn land_binding_statement(
    changed: &AgentProviderBindingChangedPayload,
    occurred_at: &str,
) -> WriteStatement {
    let mut bindings = vec![
        text_binding("@agentId", changed.agent_id.text().as_str()),
        text_binding("@switchId", changed.switch_id.as_str()),
        text_binding("@updatedAt", occurred_at),
    ];
    bindings.extend(binding_columns(&changed.to));
    WriteStatement {
        sql: Cow::Borrowed(LAND_BINDING_SQL),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: None,
    }
}

// Clears the pending switch `switch_id` of `agent_id` at `updated_at`, whatever it finds.
fn clear_statement(agent_id: &AgentId, switch_id: &SwitchId, updated_at: &str) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CLEAR_PENDING_SWITCH_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@agentId", agent_id.text().as_str()),
            text_binding("@switchId", switch_id.as_str()),
            text_binding("@updatedAt", updated_at),
        ]),
        expected_row_count: None,
    }
}

// The binding's columns.
fn binding_columns(binding: &AgentProviderBinding) -> [(Cow<'static, str>, SqlValue); 7] {
    [
        text_binding("@providerName", binding.provider_name.as_str()),
        text_binding("@modelId", binding.model_id.as_str()),
        nullable_text_binding(
            "@providerAccountId",
            binding
                .provider_account_id
                .as_ref()
                .map(ProviderAccountId::as_str),
        ),
        nullable_text_binding(
            "@effort",
            binding.effort.as_ref().map(ProviderToken::as_str),
        ),
        nullable_text_binding(
            "@options",
            binding
                .options
                .as_ref()
                .map(|options| {
                    serde_json::to_string(options).expect("a list of options writes as JSON")
                })
                .as_deref(),
        ),
        nullable_text_binding(
            "@outputSpeed",
            binding.output_speed.as_ref().map(ProviderToken::as_str),
        ),
        (
            Cow::Borrowed("@largerWindow"),
            binding.larger_window.map_or(SqlValue::Null, |window| {
                SqlValue::Integer(i64::from(window))
            }),
        ),
    ]
}

// A row of `AGENT_COLUMNS`.
fn agent_row(row: &Row<'_>) -> rusqlite::Result<AgentRow> {
    Ok(AgentRow {
        agent_id: text_column(row, 0, |text| AgentId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        name: text_column(row, 2, ToolName::new)?,
        binding: stored_binding(row, 3)?,
        instructions: row.get(10)?,
        resolved_from_definition_id: optional_text_column(row, 11, |text| {
            AgentDefinitionId::new(&text)
        })?,
        pending_switch: optional_text_column(row, 12, |text| {
            serde_json::from_str(&text).map_err(StoredJsonFault::from)
        })?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

// The binding the seven columns from `first` on hold, in `binding_columns`' order, read as the
// wire reads one: an absent option, speed or window is left out.
fn stored_binding(row: &Row<'_>, first: usize) -> rusqlite::Result<AgentProviderBinding> {
    let text = |index: usize| -> rusqlite::Result<Value> {
        Ok(Value::from(row.get::<_, Option<String>>(first + index)?))
    };
    let mut binding = Map::new();
    binding.insert("providerName".to_owned(), text(0)?);
    binding.insert("modelId".to_owned(), text(1)?);
    binding.insert("providerAccountId".to_owned(), text(2)?);
    binding.insert("effort".to_owned(), text(3)?);
    if let Some(options) = optional_text_column(row, first + 4, |text| {
        serde_json::from_str::<Value>(&text).map_err(StoredJsonFault::from)
    })? {
        binding.insert("options".to_owned(), options);
    }
    if let Value::String(speed) = text(5)? {
        binding.insert("outputSpeed".to_owned(), Value::String(speed));
    }
    if let Some(window) = row.get::<_, Option<i64>>(first + 6)? {
        binding.insert("largerWindow".to_owned(), Value::from(window));
    }
    serde_json::from_value(Value::Object(binding)).map_err(|failure| {
        rusqlite::Error::FromSqlConversionFailure(
            first,
            Type::Text,
            Box::new(StoredJsonFault::from(failure)),
        )
    })
}
