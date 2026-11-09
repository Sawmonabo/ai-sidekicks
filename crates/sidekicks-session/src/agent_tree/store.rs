//! The agent tree's writes, each the statement a helper's run write and a rebuild's fold share,
//! the two reads that tell a helper the tree already holds from a new one, and a session's nodes.

use std::borrow::Cow;

use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::MessageContent;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

const INSERT_NODE_SQL: &str = "INSERT INTO agent_tree_nodes
  (child_handle, session_id, provider_name, subagent_id, parent_subagent_id, parent_child_handle,
   name, role, provider_path, ask, model_id, effort, start_call_id, own_run_id, started_at,
   updated_at)
  VALUES (@childHandle, @sessionId, @providerName, @subagentId, @parentSubagentId,
          @parentChildHandle, @name, @role, @providerPath, @ask, @modelId, @effort, @startCallId,
          @ownRunId, @startedAt, @startedAt)";

// A known node's newest own run and the call that started it; its first start stays, the ask,
// model and effort it named included.
const BIND_NEWEST_RUN_SQL: &str = "UPDATE agent_tree_nodes
  SET own_run_id = @ownRunId, start_call_id = @startCallId, updated_at = @updatedAt
  WHERE child_handle = @childHandle";

// Every column, in the order `node_of_row` reads them, each stored text checked as its wire type
// there, so a refused one names its column.
macro_rules! select_nodes {
    ($filter:literal) => {
        concat!(
            "SELECT child_handle, session_id, provider_name, subagent_id, parent_subagent_id,
       parent_child_handle, name, role, provider_path, start_call_id, own_run_id, started_at,
       updated_at, model_id, effort, ask
  FROM agent_tree_nodes ",
            $filter
        )
    };
}

const FIND_NODE_SQL: &str = select_nodes!(
    "WHERE session_id = @sessionId AND provider_name = @providerName AND subagent_id = @subagentId"
);

const READ_NODE_SQL: &str = select_nodes!("WHERE child_handle = @childHandle");

const READ_SESSION_NODES_SQL: &str =
    select_nodes!("WHERE session_id = @sessionId ORDER BY started_at, child_handle");

/// A helper's node as its row holds it, each provider text read as its wire type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentTreeNode {
    /// The handle the daemon minted for the helper.
    pub child_handle: ChildHandle,
    /// The session the helper runs in.
    pub session_id: SessionId,
    /// The provider that named the helper.
    pub provider_name: ProviderId,
    /// The helper's id in its provider.
    pub subagent_id: SubagentId,
    /// Its parent's id in the provider, `None` under the lead.
    pub parent_subagent_id: Option<SubagentId>,
    /// Its parent's node, `None` under the lead.
    pub parent_child_handle: Option<ChildHandle>,
    /// The name its provider gave it, where the provider names helpers.
    pub name: Option<String>,
    /// The role its provider started it in.
    pub role: Option<String>,
    /// Its path in its provider's tree, where the provider keeps one.
    pub provider_path: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The ask its first start named, where its provider named one.
    pub ask: Option<MessageContent>,
    /// The model its first start named, where its provider named one.
    pub model_id: Option<ProviderToken>,
    /// The reasoning effort its first start named, in its provider's word, where it named one.
    pub effort: Option<ProviderToken>,
    /// The provider's call that started its newest own run, where the provider names one.
    pub start_call_id: Option<ToolCallId>,
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
    pub child_handle: ChildHandle,
    /// The session the helper runs in.
    pub session_id: SessionId,
    /// The provider that named the helper.
    pub provider_name: ProviderId,
    /// The helper's id in its provider.
    pub subagent_id: String,
    /// Its parent's id in the provider, `None` under the lead.
    pub parent_subagent_id: Option<String>,
    /// Its parent's node, `None` under the lead.
    pub parent_child_handle: Option<ChildHandle>,
    /// The name its provider gave it, where the provider names helpers.
    pub name: Option<String>,
    /// The role its provider started it in.
    pub role: Option<String>,
    /// Its path in its provider's tree, where the provider keeps one.
    pub provider_path: Option<String>,
    /// The ask its provider started it with, where the start names one.
    pub ask: Option<String>,
    /// The model its provider started it on, where the start names one.
    pub model_id: Option<String>,
    /// The reasoning effort its provider started it at, where the start names one.
    pub effort: Option<String>,
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
            text_binding("@childHandle", node.child_handle.as_str()),
            text_binding("@sessionId", node.session_id.text().as_str()),
            text_binding("@providerName", node.provider_name.as_str()),
            text_binding("@subagentId", &node.subagent_id),
            nullable_text_binding("@parentSubagentId", node.parent_subagent_id.as_deref()),
            nullable_text_binding(
                "@parentChildHandle",
                node.parent_child_handle.as_ref().map(ChildHandle::as_str),
            ),
            nullable_text_binding("@name", node.name.as_deref()),
            nullable_text_binding("@role", node.role.as_deref()),
            nullable_text_binding("@providerPath", node.provider_path.as_deref()),
            nullable_text_binding("@ask", node.ask.as_deref()),
            nullable_text_binding("@modelId", node.model_id.as_deref()),
            nullable_text_binding("@effort", node.effort.as_deref()),
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
    child_handle: &ChildHandle,
    own_run_id: RunId,
    start_call_id: Option<&str>,
    updated_at: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(BIND_NEWEST_RUN_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@childHandle", child_handle.as_str()),
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
    child_handle: &ChildHandle,
) -> rusqlite::Result<Option<AgentTreeNode>> {
    connection
        .prepare_cached(READ_NODE_SQL)?
        .query_row(
            named_params! { "@childHandle": child_handle.as_str() },
            node_of_row,
        )
        .optional()
}

/// Every node of `session_id`, oldest first and by handle where two started together. Fails as
/// SQLite does, or when a stored column does not read as its type, a provider text the wire
/// refuses included.
pub fn read_session_nodes(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<AgentTreeNode>> {
    connection
        .prepare_cached(READ_SESSION_NODES_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            node_of_row,
        )?
        .collect()
}

/// A new helper's handle, minted at its first start and kept by every later one.
pub(crate) fn mint_child_handle() -> ChildHandle {
    ChildHandle::new(mint_uuid_v7().to_string()).expect("a UUID's text fits a child handle")
}

/// Stored text that is not a child's handle.
#[derive(Debug, thiserror::Error)]
#[error("the stored child handle is not a handle")]
pub(crate) struct NotAChildHandle;

/// A child's handle as a column stores it. Fails with [`NotAChildHandle`] for text no handle
/// holds.
pub(crate) fn read_child_handle(text: String) -> Result<ChildHandle, NotAChildHandle> {
    ChildHandle::new(text).ok_or(NotAChildHandle)
}

fn node_of_row(row: &Row<'_>) -> rusqlite::Result<AgentTreeNode> {
    Ok(AgentTreeNode {
        child_handle: text_column(row, 0, read_child_handle)?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        provider_name: text_column(row, 2, closed_word::<ProviderId>)?,
        subagent_id: text_column(row, 3, SubagentId::new)?,
        parent_subagent_id: optional_text_column(row, 4, SubagentId::new)?,
        parent_child_handle: optional_text_column(row, 5, read_child_handle)?,
        name: row.get(6)?,
        role: row.get(7)?,
        provider_path: optional_text_column(row, 8, FreeFormText::new)?,
        ask: optional_text_column(row, 15, FreeFormText::new)?,
        model_id: optional_text_column(row, 13, ProviderToken::new)?,
        effort: optional_text_column(row, 14, ProviderToken::new)?,
        start_call_id: optional_text_column(row, 9, ToolCallId::new)?,
        own_run_id: text_column(row, 10, |text| RunId::new(&text))?,
        started_at: text_column(row, 11, WireInstant::try_from)?,
        updated_at: text_column(row, 12, WireInstant::try_from)?,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, ErrorCode, params};
    use sidekicks_contracts::agent::definition::binding::ProviderToken;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::subagent::SubagentId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_store::database::statement::run_statement;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_run_id, test_session_id,
    };

    use super::{
        AgentTreeNode, NewAgentTreeNode, find_node, insert_node, mint_child_handle, read_node,
    };
    use crate::agent_tree::schema::schema_parts;

    // A database on the agent tree's schema and a connection opened as the daemon opens its own, so
    // foreign keys are on.
    fn open() -> (TestDatabase, Connection) {
        let database = TestDatabase::new(schema_parts());
        let connection = database.opener()().expect("the test opens its database");
        (database, connection)
    }

    fn insert_run(connection: &Connection, session_id: SessionId) -> RunId {
        let run_id = test_run_id();
        connection
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'running', 1)",
                params![run_id.text().as_str(), session_id.text().as_str()],
            )
            .expect("the test writes the run");
        run_id
    }

    fn provider() -> ProviderId {
        ProviderId::new("test-provider".to_owned()).expect("a provider id")
    }

    fn new_node(session_id: SessionId, own_run_id: RunId, subagent_id: &str) -> NewAgentTreeNode {
        NewAgentTreeNode {
            child_handle: mint_child_handle(),
            session_id,
            provider_name: provider(),
            subagent_id: subagent_id.to_owned(),
            parent_subagent_id: None,
            parent_child_handle: None,
            name: None,
            role: None,
            provider_path: None,
            ask: None,
            model_id: None,
            effort: None,
            start_call_id: None,
            own_run_id,
            started_at: WireInstant::now(),
        }
    }

    fn is_constraint_failure(error: &rusqlite::Error, extended_code: i32) -> bool {
        matches!(
            error,
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == ErrorCode::ConstraintViolation
                    && failure.extended_code == extended_code
        )
    }

    #[test]
    fn inserted_node_reads_back_and_its_provider_key_is_unique() {
        let (_database, connection) = open();
        let session_id = test_session_id();
        let parent_run = insert_run(&connection, session_id);
        let parent = new_node(session_id, parent_run, "parent");
        let parent_handle = parent.child_handle.clone();
        run_statement(&connection, &insert_node(&parent)).expect("the parent's row is written");

        let own_run = insert_run(&connection, session_id);
        let node = NewAgentTreeNode {
            parent_subagent_id: Some("parent".to_owned()),
            parent_child_handle: Some(parent_handle.clone()),
            name: Some("scout".to_owned()),
            role: Some("explorer".to_owned()),
            provider_path: Some("/root/scout".to_owned()),
            ask: None,
            model_id: Some("gpt-5.4-mini".to_owned()),
            effort: Some("low".to_owned()),
            start_call_id: Some("call-1".to_owned()),
            ..new_node(session_id, own_run, "child")
        };
        assert_eq!(
            run_statement(&connection, &insert_node(&node)).map(|ran| ran.row_count),
            Ok(1)
        );

        // The row holds the handle the node was given, never one the store minted.
        let expected = AgentTreeNode {
            child_handle: node.child_handle.clone(),
            session_id,
            provider_name: provider(),
            subagent_id: SubagentId::new("child".to_owned()).expect("a helper id"),
            parent_subagent_id: Some(SubagentId::new("parent".to_owned()).expect("a helper id")),
            parent_child_handle: Some(parent_handle),
            name: Some("scout".to_owned()),
            role: Some("explorer".to_owned()),
            provider_path: Some(FreeFormText::new("/root/scout".to_owned()).expect("a path")),
            ask: None,
            model_id: Some(ProviderToken::new("gpt-5.4-mini".to_owned()).expect("a model id")),
            effort: Some(ProviderToken::new("low".to_owned()).expect("an effort")),
            start_call_id: Some(ToolCallId::new("call-1".to_owned()).expect("a call id")),
            own_run_id: own_run,
            started_at: node.started_at.clone(),
            updated_at: node.started_at,
        };
        assert_eq!(
            find_node(&connection, session_id, &provider(), "child").expect("the find reads"),
            Some(expected.clone())
        );
        assert_eq!(
            read_node(&connection, &node.child_handle).expect("the read reads"),
            Some(expected)
        );

        let again = insert_node(&new_node(session_id, own_run, "child"));
        let refusal = run_statement(&connection, &again).expect_err("the same helper is refused");
        assert!(
            is_constraint_failure(&refusal, rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE),
            "{refusal:?}"
        );
    }

    #[test]
    fn a_parent_handle_naming_no_node_is_refused() {
        let (_database, connection) = open();
        let session_id = test_session_id();
        let own_run = insert_run(&connection, session_id);
        let node = NewAgentTreeNode {
            parent_child_handle: Some(mint_child_handle()),
            ..new_node(session_id, own_run, "orphan")
        };
        let refusal = run_statement(&connection, &insert_node(&node))
            .expect_err("a missing parent is refused");
        assert!(
            is_constraint_failure(&refusal, rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
            "{refusal:?}"
        );
    }
}
