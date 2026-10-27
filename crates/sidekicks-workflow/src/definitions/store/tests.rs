use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::builder::{
    NewWorkflowDraftUpdateRequest, SavedWorkflowDraftUpdateRequest, WorkflowDraftUpdateRequest,
};
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDocument, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::methods::{
    WorkflowCreateOrigin, WorkflowDefinitionCreateRequest, WorkflowDefinitionCreateResponse,
    WorkflowDefinitionUpdateRequest,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowDefinitionFinding;

use super::{
    WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY, WorkflowDefinitionStore,
    WorkflowDefinitionStoreError, WorkflowSaveAuthor,
};
use crate::definitions::drafts::{WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY, WorkflowDraftStore};
use crate::definitions::errors::DefinitionRefusal;
use crate::definitions::library::WORKFLOW_LIBRARY_STATEMENT_CAPACITY;
use crate::not_found::{WorkflowNotFound, WorkflowVersionAddress};
use crate::schema::schema_parts;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

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
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
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

// A create of a document named `name` whose node reads `path`, from `origin`.
async fn create_from(
    store: &WorkflowDefinitionStore,
    name: &str,
    path: &str,
    origin: WorkflowCreateOrigin,
) -> Result<WorkflowDefinitionCreateResponse, WorkflowDefinitionStoreError> {
    store
        .create(
            &WorkflowDefinitionCreateRequest {
                document: saved_document(name, path),
                origin,
            },
            &author(),
        )
        .await
}

async fn create(store: &WorkflowDefinitionStore, name: &str) -> WorkflowDefinitionId {
    create_from(store, name, "notes.md", WorkflowCreateOrigin::FileImport {})
        .await
        .expect("the create commits")
        .definition_id
}

fn duplicate_of(copied_version_id: WorkflowVersionId) -> WorkflowCreateOrigin {
    WorkflowCreateOrigin::Duplicate { copied_version_id }
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
    let database = TestDatabase::new(schema_parts());
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

/// A create from the builder's new-workflow draft clears that draft in its own write; a file
/// import leaves it held, since the builder was not saving it. Mutations: drop the draft's clear
/// from the create; clear it for every origin.
#[tokio::test]
async fn a_create_from_the_new_workflow_draft_clears_it_and_an_import_leaves_it() {
    let database = TestDatabase::new(schema_parts());
    let (store, drafts) = open_stores(&database).await;
    let hold_new_draft = || async {
        drafts
            .update(&WorkflowDraftUpdateRequest::New(
                NewWorkflowDraftUpdateRequest {
                    definition_id: None,
                    based_on_version_number: None,
                    document: serde_json::from_value(document("Unsaved", "draft.md"))
                        .expect("the test's draft reads"),
                },
            ))
            .await
            .expect("the draft is held");
    };

    hold_new_draft().await;
    create_from(
        &store,
        "Imported",
        "notes.md",
        WorkflowCreateOrigin::FileImport {},
    )
    .await
    .expect("the import commits");
    let held = drafts.read(None).await.expect("the draft reads");
    assert!(
        held.draft.is_some(),
        "an import leaves the new workflow's draft held"
    );

    create_from(
        &store,
        "Drafted",
        "draft.md",
        WorkflowCreateOrigin::NewWorkflowDraft {},
    )
    .await
    .expect("the create commits");
    let cleared = drafts.read(None).await.expect("the draft reads");
    assert_eq!(cleared.draft, None);
}

fn definition_name(rows: &Connection, definition_id: WorkflowDefinitionId) -> String {
    rows.query_row(
        "SELECT name FROM workflow_definitions WHERE id = ?1",
        [definition_id.text().as_str()],
        |row| row.get(0),
    )
    .expect("the test reads the workflow")
}

/// A Duplicate is named the first free `<name> copy`, then `<name> copy 2`; its first version
/// keeps the copied version's package locks while its document is that version's, and none when it
/// differs. One naming a version no row holds, or a version of a deleted workflow, is refused as
/// that version not found, not as a held name, and writes no workflow. Mutations: carry the locks
/// whatever the document; answer every refused create as a held name; drop the copied version's
/// check, or its deleted workflow condition, from the write.
#[tokio::test]
async fn a_duplicate_takes_a_free_copy_name_and_its_source_locks_only_for_the_same_content() {
    let database = TestDatabase::new(schema_parts());
    let (store, _drafts) = open_stores(&database).await;
    let source = create_from(
        &store,
        "Nightly",
        "notes.md",
        WorkflowCreateOrigin::FileImport {},
    )
    .await
    .expect("the create commits");
    let source_version = source.workflow_version_id;
    let locks = r#"{"read":{"lodash":"4.17.21"}}"#;
    let rows = database.reader();
    rows.execute(
        "UPDATE workflow_versions SET code_locks_json = ?1 WHERE id = ?2",
        [locks, source_version.text().as_str()],
    )
    .expect("the test locks the source's packages");
    for (expected_name, path, expected_locks) in [
        ("Nightly copy", "notes.md", locks),
        ("Nightly copy 2", "changed.md", "{}"),
    ] {
        let copy = create_from(&store, "Nightly", path, duplicate_of(source_version))
            .await
            .expect("the duplicate commits");
        assert_eq!(definition_name(&rows, copy.definition_id), expected_name);
        let copy_locks: String = rows
            .query_row(
                "SELECT code_locks_json FROM workflow_versions WHERE id = ?1",
                [copy.workflow_version_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the copy's locks");
        assert_eq!(copy_locks, expected_locks, "{expected_name}");
    }

    let missing = WorkflowVersionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e59")
        .expect("the id is a version id");
    let refused_missing = create_from(&store, "Weekly", "notes.md", duplicate_of(missing)).await;
    rows.execute(
        "UPDATE workflow_definitions SET deleted_at = ?1 WHERE id = ?2",
        [
            "2026-10-14T09:30:00.000Z",
            source.definition_id.text().as_str(),
        ],
    )
    .expect("the test deletes the source");
    let refused_deleted =
        create_from(&store, "Nightly", "notes.md", duplicate_of(source_version)).await;
    for (refused, copied_version_id) in [
        (refused_missing, missing),
        (refused_deleted, source_version),
    ] {
        let refused = refused.expect_err("a copied version not in the library is refused");
        let WorkflowDefinitionStoreError::NotFound(WorkflowNotFound::Version(
            WorkflowVersionAddress::Id {
                workflow_version_id,
            },
        )) = refused
        else {
            panic!("the duplicate is refused as its version not found, not {refused:?}");
        };
        assert_eq!(workflow_version_id, copied_version_id);
    }
    let definition_count: i64 = rows
        .query_row("SELECT COUNT(*) FROM workflow_definitions", [], |row| {
            row.get(0)
        })
        .expect("the test counts the workflows");
    assert_eq!(definition_count, 3);
}
