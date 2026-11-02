//! The agent tree's writes, each the statement a helper's run write and a rebuild's fold share,
//! and the two reads that tell a helper the tree already holds from a new one.

use std::borrow::Cow;

use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{UuidText, UuidTextForm};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

const INSERT_NODE_SQL: &str = "INSERT INTO agent_tree_nodes
  (child_handle, session_id, provider_name, subagent_id, parent_subagent_id, parent_child_handle,
   name, role, provider_path, start_call_id, own_run_id, started_at, updated_at)
  VALUES (@childHandle, @sessionId, @providerName, @subagentId, @parentSubagentId,
          @parentChildHandle, @name, @role, @providerPath, @startCallId, @ownRunId, @startedAt,
          @startedAt)";

// A known node's newest own run and the call that started it; its first start stays.
const BIND_NEWEST_RUN_SQL: &str = "UPDATE agent_tree_nodes
  SET own_run_id = @ownRunId, start_call_id = @startCallId, updated_at = @updatedAt
  WHERE child_handle = @childHandle";

// Every column, in the order `node_of_row` reads them.
macro_rules! select_nodes {
    ($filter:literal) => {
        concat!(
            "SELECT child_handle, session_id, provider_name, subagent_id, parent_subagent_id,
       parent_child_handle, name, role, provider_path, start_call_id, own_run_id, started_at,
       updated_at
  FROM agent_tree_nodes ",
            $filter
        )
    };
}

const FIND_NODE_SQL: &str = select_nodes!(
    "WHERE session_id = @sessionId AND provider_name = @providerName AND subagent_id = @subagentId"
);

const READ_NODE_SQL: &str = select_nodes!("WHERE child_handle = @childHandle");

/// A helper's node as its row holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentTreeNode {
    /// The handle the daemon minted for the helper.
    pub child_handle: UuidTextForm,
    /// The session the helper runs in.
    pub session_id: SessionId,
    /// The provider that named the helper.
    pub provider_name: ProviderId,
    /// The helper's id in its provider.
    pub subagent_id: String,
    /// Its parent's id in the provider, `None` under the lead.
    pub parent_subagent_id: Option<String>,
    /// Its parent's node, `None` under the lead.
    pub parent_child_handle: Option<UuidTextForm>,
    /// The name its provider gave it, where the provider names helpers.
    pub name: Option<String>,
    /// The role its provider started it in.
    pub role: Option<String>,
    /// Its path in its provider's tree, where the provider keeps one.
    pub provider_path: Option<String>,
    /// The provider's call that started its newest own run, where the provider names one.
    pub start_call_id: Option<String>,
    /// Its newest own run, whose state is the node's.
    pub own_run_id: RunId,
    /// When its first own run started.
    pub started_at: WireInstant,
    /// When its newest own run was bound.
    pub updated_at: WireInstant,
}

/// A helper the tree does not hold yet, as its provider named it when its first own run started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewAgentTreeNode {
    /// The handle the daemon minted for the helper, which its first run's event carries.
    pub child_handle: UuidTextForm,
    /// The session the helper runs in.
    pub session_id: SessionId,
    /// The provider that named the helper.
    pub provider_name: ProviderId,
    /// The helper's id in its provider.
    pub subagent_id: String,
    /// Its parent's id in the provider, `None` under the lead.
    pub parent_subagent_id: Option<String>,
    /// Its parent's node, `None` under the lead.
    pub parent_child_handle: Option<UuidTextForm>,
    /// The name its provider gave it, where the provider names helpers.
    pub name: Option<String>,
    /// The role its provider started it in.
    pub role: Option<String>,
    /// Its path in its provider's tree, where the provider keeps one.
    pub provider_path: Option<String>,
    /// The provider's call that started its run, where the provider names one.
    pub start_call_id: Option<String>,
    /// Its first own run.
    pub own_run_id: RunId,
    /// When that run started; the node's `updated_at` starts equal to it.
    pub started_at: WireInstant,
}

/// The statement that writes `node`'s row under the handle it carries. Refused when the session
/// already holds the provider's helper or the handle, or when its parent's node is missing.
pub fn insert_node(node: &NewAgentTreeNode) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_NODE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@childHandle", node.child_handle.text().as_str()),
            text_binding("@sessionId", node.session_id.text().as_str()),
            text_binding("@providerName", node.provider_name.as_str()),
            text_binding("@subagentId", &node.subagent_id),
            nullable_text_binding("@parentSubagentId", node.parent_subagent_id.as_deref()),
            nullable_text_binding(
                "@parentChildHandle",
                node.parent_child_handle
                    .map(|handle| handle.text())
                    .as_ref()
                    .map(UuidText::as_str),
            ),
            nullable_text_binding("@name", node.name.as_deref()),
            nullable_text_binding("@role", node.role.as_deref()),
            nullable_text_binding("@providerPath", node.provider_path.as_deref()),
            nullable_text_binding("@startCallId", node.start_call_id.as_deref()),
            text_binding("@ownRunId", node.own_run_id.text().as_str()),
            text_binding("@startedAt", node.started_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// Binds the known node `child_handle` to its newest own run `own_run_id`, started by the call
/// `start_call_id` where its provider names one, at `updated_at`; its first start stays. Refused
/// when no node holds the handle.
pub fn bind_newest_run(
    child_handle: UuidTextForm,
    own_run_id: RunId,
    start_call_id: Option<&str>,
    updated_at: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(BIND_NEWEST_RUN_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@childHandle", child_handle.text().as_str()),
            text_binding("@ownRunId", own_run_id.text().as_str()),
            nullable_text_binding("@startCallId", start_call_id),
            text_binding("@updatedAt", updated_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The node of the helper `subagent_id` that `provider_name` named in `session_id`, or `None` when
/// the tree does not hold it. Fails as SQLite does, or when a stored column does not read as its
/// type.
pub fn find_node(
    connection: &Connection,
    session_id: SessionId,
    provider_name: &ProviderId,
    subagent_id: &str,
) -> rusqlite::Result<Option<AgentTreeNode>> {
    connection
        .prepare_cached(FIND_NODE_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@providerName": provider_name.as_str(),
                "@subagentId": subagent_id,
            },
            node_of_row,
        )
        .optional()
}

/// The node `child_handle`, or `None` when no row holds it. Fails as SQLite does, or when a stored
/// column does not read as its type.
pub fn read_node(
    connection: &Connection,
    child_handle: UuidTextForm,
) -> rusqlite::Result<Option<AgentTreeNode>> {
    connection
        .prepare_cached(READ_NODE_SQL)?
        .query_row(
            named_params! { "@childHandle": child_handle.text().as_str() },
            node_of_row,
        )
        .optional()
}

fn node_of_row(row: &Row<'_>) -> rusqlite::Result<AgentTreeNode> {
    Ok(AgentTreeNode {
        child_handle: text_column(row, 0, |text| UuidTextForm::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        provider_name: text_column(row, 2, closed_word::<ProviderId>)?,
        subagent_id: row.get(3)?,
        parent_subagent_id: row.get(4)?,
        parent_child_handle: optional_text_column(row, 5, |text| UuidTextForm::new(&text))?,
        name: row.get(6)?,
        role: row.get(7)?,
        provider_path: row.get(8)?,
        start_call_id: row.get(9)?,
        own_run_id: text_column(row, 10, |text| RunId::new(&text))?,
        started_at: text_column(row, 11, WireInstant::try_from)?,
        updated_at: text_column(row, 12, WireInstant::try_from)?,
    })
}

#[cfg(test)]
mod tests;
