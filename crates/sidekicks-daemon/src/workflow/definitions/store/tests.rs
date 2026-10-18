use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::builder::{
    SavedWorkflowDraftUpdateRequest, WorkflowDraftUpdateRequest,
};
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDocument, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::methods::{
    WorkflowDefinitionCreateRequest, WorkflowDefinitionCreateResponse,
    WorkflowDefinitionUpdateRequest,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowDefinitionFinding;

use super::{
    WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY, WorkflowCreateOptions, WorkflowDefinitionStore,
    WorkflowDefinitionStoreError, WorkflowSaveAuthor,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::workflow::definitions::drafts::{
    WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY, WorkflowDraftStore,
};
use crate::workflow::definitions::errors::DefinitionRefusal;
use crate::workflow::definitions::library::WORKFLOW_LIBRARY_STATEMENT_CAPACITY;
use crate::workflow::not_found::{WorkflowNotFound, WorkflowVersionAddress};
use crate::workflow::schema::WORKFLOW_SCHEMA_SQL;

/// A document of `name` whose trigger feeds its one node, which the graph check passes.
fn document(name: &str, path: &str) -> Value {
    json!({
        "schemaVersion": "2",
        "name": name,
        "trigger": {
            "id": "trigger", "kind": "trigger.manual", "kindVersion": 1, "name": "Start",
            "order": 0, "params": {},
        },
        "nodes": [{
            "id": "read", "kind": "files.read", "kindVersion": 1, "name": "Read notes",
            "order": 0, "params": { "path": path },
        }],
        "edges": [{
            "id": "trigger-to-read", "source": "trigger", "sourceHandle": "outputs/main/0",
            "target": "read", "targetHandle": "inputs/main/0",
        }],
    })
}

fn saved_document(name: &str, path: &str) -> WorkflowDocument {
    serde_json::from_value(document(name, path)).expect("the test's document reads")
}

/// The store and the draft store over one test database holding the workflow tables.
async fn open_stores(database: &TestDatabase) -> (WorkflowDefinitionStore, WorkflowDraftStore) {
    let opener = database.opener_without_event_tables();
    let writer = Arc::new(
        DatabaseWriter::open(
            move || -> rusqlite::Result<Connection> {
                let connection = opener()?;
                connection.execute_batch(&WORKFLOW_SCHEMA_SQL)?;
                Ok(connection)
            },
            DatabaseWriterOptions::default(),
        )
        .await
        .expect("the writer opens the test database"),
    );
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        WORKFLOW_LIBRARY_STATEMENT_CAPACITY
            + WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY
            + WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY,
    ));
    (
        WorkflowDefinitionStore::new(
            Arc::clone(&pool),
            Arc::clone(&writer),
            Box::new(|_node| None),
        ),
        WorkflowDraftStore::new(pool, writer),
    )
}

fn author() -> WorkflowSaveAuthor {
    WorkflowSaveAuthor {
        device_id: DeviceId::new("device".to_owned()).expect("the id is well formed"),
        agent_id: None,
    }
}

// A create of a document named `name`, a Duplicate of `copied_version_id` when one is given.
async fn create_copy(
    store: &WorkflowDefinitionStore,
    name: &str,
    copied_version_id: Option<WorkflowVersionId>,
) -> Result<WorkflowDefinitionCreateResponse, WorkflowDefinitionStoreError> {
    store
        .create(
            &WorkflowDefinitionCreateRequest {
                document: saved_document(name, "notes.md"),
                copied_version_id,
            },
            &author(),
            WorkflowCreateOptions {
                is_from_new_workflow_draft: false,
            },
        )
        .await
}

async fn create(store: &WorkflowDefinitionStore, name: &str) -> WorkflowDefinitionId {
    create_copy(store, name, None)
        .await
        .expect("the create commits")
        .definition_id
}

async fn hold_draft(drafts: &WorkflowDraftStore, definition_id: WorkflowDefinitionId) {
    drafts
        .update(&WorkflowDraftUpdateRequest::Saved(
            SavedWorkflowDraftUpdateRequest {
                definition_id,
                based_on_version_number: SafeInt::new(1),
                document: serde_json::from_value(document("Unsaved", "draft.md"))
                    .expect("the test's draft reads"),
            },
        ))
        .await
        .expect("the draft is held");
}

fn version_count(rows: &Connection, definition_id: WorkflowDefinitionId) -> i64 {
    rows.query_row(
        "SELECT COUNT(*) FROM workflow_versions WHERE definition_id = ?1",
        [definition_id.text().as_str()],
        |row| row.get(0),
    )
    .expect("the test counts the versions")
}

fn update(definition_id: WorkflowDefinitionId, name: &str) -> WorkflowDefinitionUpdateRequest {
    WorkflowDefinitionUpdateRequest {
        definition_id,
        expected_version_number: SafeInt::new(1).expect("one is a version number"),
        document: saved_document(name, "changed.md"),
        restored_version_number: None,
    }
}

/// A save writes its version and clears its workflow's draft as one write; a save refused for a
/// name another workflow holds, in another letter case, writes no version, keeps the workflow's
/// name and leaves its draft held, whether the check before the write or the one inside it refuses
/// it. Mutations: drop the draft's clear from the save; fold no case in either name check; answer
/// the in-write name check's refusal as a stale version.
#[tokio::test]
async fn a_save_clears_its_draft_and_a_refused_name_leaves_nothing() {
    let database = TestDatabase::new();
    let (store, drafts) = open_stores(&database).await;
    let nightly = create(&store, "Nightly").await;
    let weekly = create(&store, "Weekly").await;
    hold_draft(&drafts, nightly).await;
    hold_draft(&drafts, weekly).await;

    let saved = store
        .update(&update(nightly, "Nightly"), &author())
        .await
        .expect("the save commits");
    assert_eq!(saved.version_number.get(), 2);
    let cleared = drafts.read(Some(nightly)).await.expect("the draft reads");
    assert_eq!(cleared.draft, None);

    let request = update(weekly, "NIGHTLY");
    let refusals = [
        store.update(&request, &author()).await,
        // The write alone, as when the name is taken after the check before it.
        store.write_update(&request, &author()).await,
    ];
    for refused in refusals {
        let refused = refused.expect_err("a name another workflow holds is refused");
        let WorkflowDefinitionStoreError::Refused(DefinitionRefusal::Refused { findings }) =
            refused
        else {
            panic!("the save is refused with findings, not {refused:?}");
        };
        assert_eq!(
            findings,
            vec![WorkflowDefinitionFinding::NameTaken {
                node_ids: Vec::new()
            }]
        );
    }
    let rows = database.reader();
    assert_eq!(version_count(&rows, weekly), 1);
    assert_eq!(definition_name(&rows, weekly), "Weekly");
    let held = drafts.read(Some(weekly)).await.expect("the draft reads");
    assert!(held.draft.is_some(), "a refused save leaves its draft held");
}

fn definition_name(rows: &Connection, definition_id: WorkflowDefinitionId) -> String {
    rows.query_row(
        "SELECT name FROM workflow_definitions WHERE id = ?1",
        [definition_id.text().as_str()],
        |row| row.get(0),
    )
    .expect("the test reads the workflow")
}

/// A Duplicate is named the first free `<name> copy`, then `<name> copy 2`; one naming a version
/// no row holds is refused as that version not found, not as a held name, and writes no workflow.
/// Mutations: answer every refused create as a held name; drop the copied version's check from the
/// write.
#[tokio::test]
async fn a_duplicate_takes_the_first_free_copy_name_and_a_missing_version_writes_nothing() {
    let database = TestDatabase::new();
    let (store, _drafts) = open_stores(&database).await;
    let source = create_copy(&store, "Nightly", None)
        .await
        .expect("the create commits");
    let rows = database.reader();
    for expected_name in ["Nightly copy", "Nightly copy 2"] {
        let copy = create_copy(&store, "Nightly", Some(source.workflow_version_id))
            .await
            .expect("the duplicate commits");
        assert_eq!(definition_name(&rows, copy.definition_id), expected_name);
    }

    let missing = WorkflowVersionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e59")
        .expect("the id is a version id");
    let refused = create_copy(&store, "Weekly", Some(missing))
        .await
        .expect_err("a copied version no row holds is refused");
    let WorkflowDefinitionStoreError::NotFound(WorkflowNotFound::Version(
        WorkflowVersionAddress::Id {
            workflow_version_id,
        },
    )) = refused
    else {
        panic!("the duplicate is refused as its version not found, not {refused:?}");
    };
    assert_eq!(workflow_version_id, missing);
    let definition_count: i64 = rows
        .query_row("SELECT COUNT(*) FROM workflow_definitions", [], |row| {
            row.get(0)
        })
        .expect("the test counts the workflows");
    assert_eq!(definition_count, 3);
}
