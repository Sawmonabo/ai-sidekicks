use rusqlite::{Connection, ErrorCode, params};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, named_bindings};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id, test_session_id};

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

fn run_statement(connection: &Connection, statement: &WriteStatement) -> rusqlite::Result<usize> {
    let StatementBindings::Named(values) = &statement.bindings else {
        panic!("every agent tree statement binds by name");
    };
    connection.execute(&statement.sql, named_bindings(values).as_slice())
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
        start_call_id: Some("call-1".to_owned()),
        ..new_node(session_id, own_run, "child")
    };
    assert_eq!(run_statement(&connection, &insert_node(&node)), Ok(1));

    // The row holds the handle the node was given, never one the store minted.
    let expected = AgentTreeNode {
        child_handle: node.child_handle.clone(),
        session_id,
        provider_name: provider(),
        subagent_id: "child".to_owned(),
        parent_subagent_id: Some("parent".to_owned()),
        parent_child_handle: Some(parent_handle),
        name: Some("scout".to_owned()),
        role: Some("explorer".to_owned()),
        provider_path: Some("/root/scout".to_owned()),
        start_call_id: Some("call-1".to_owned()),
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
    let refusal =
        run_statement(&connection, &insert_node(&node)).expect_err("a missing parent is refused");
    assert!(
        is_constraint_failure(&refusal, rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
        "{refusal:?}"
    );
}
