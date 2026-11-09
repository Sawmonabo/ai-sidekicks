//! A chain's count and a run's Keep mark rebuilt from the log as the live writes left them, the
//! chain's first run in the joining run's session or in another.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::run::retention::WorkflowRunKeepSet;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunChainPlace;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::events::log_service::EVENT_LOG_STATEMENT_CAPACITY;

use super::{Fixture, TestSession, body, start, started};
use crate::engine::start::{WorkflowRunStart, WorkflowStartArrival};
use crate::runs::deletion::{WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY, WorkflowRunDeletion};
use crate::test_rows::{TEST_SESSION_ID, rebuild_workflow_runs, run_rows};

/// The session a chain's first run lives in when it is not the joining run's.
const OTHER_SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e7f";

/// A run joining a chain counts on its first run's row through a `workflow.chain.runJoined` in
/// that first run's session, and a Keep mark rides its `workflow.run.keepChanged`, so rebuilding
/// both sessions from their logs writes both runs' rows byte-identical: the first run counting
/// two runs, the joining run kept. Mutations: the start leaving the joined event out, or the fold
/// skipping it (the rebuilt count reads 1); `set_keep` writing its mark without its event, or the
/// fold skipping it (the rebuilt mark reads 0); the joined event appended in the joining run's
/// session when the first run lives in another (that session's rebuild counts nothing).
#[rstest]
#[case::first_run_in_the_same_session(TEST_SESSION_ID)]
#[case::first_run_in_another_session(OTHER_SESSION_ID)]
#[tokio::test]
async fn a_chains_count_and_a_keep_mark_rebuild_as_written(#[case] root_session: &str) {
    let fixture = Fixture::new(&body(None, &json!([])), TestSession::WithoutFolder, None).await;
    if root_session == OTHER_SESSION_ID {
        insert_session_row(&fixture.rows, OTHER_SESSION_ID, None, None);
    }
    let root = started(
        fixture
            .starter
            .start(WorkflowRunStart {
                session_id: SessionId::new(root_session).expect("the root's session"),
                ..start(
                    WorkflowStartArrival::Person,
                    WorkflowRunChainPlace::Starts {},
                    Vec::new(),
                )
            })
            .await,
    );
    let root_id = root.scope.run_id;
    let joining = started(
        fixture
            .starter
            .start(start(
                WorkflowStartArrival::Trigger,
                WorkflowRunChainPlace::Joins {
                    chain_root_run_id: root_id,
                    is_from_error: true,
                },
                Vec::new(),
            ))
            .await,
    );
    let joining_id = joining.scope.run_id;
    let deletion = WorkflowRunDeletion::new(
        Arc::new(DatabaseReadPool::new(
            fixture.roots.database.path(),
            EVENT_LOG_STATEMENT_CAPACITY + WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY,
        )),
        Arc::clone(&fixture.roots.log.service),
        fixture.data_folder(),
    );
    deletion
        .set_keep(WorkflowRunKeepSet {
            workflow_run_id: joining_id,
            keep: true,
        })
        .await
        .expect("the Keep mark is set");
    let live = [root_id, joining_id].map(|run_id| run_rows(&fixture.rows, run_id.text().as_str()));
    assert_eq!(
        fixture.count(&format!(
            "SELECT chain_run_count FROM workflow_runs WHERE id = '{}'",
            root_id.text().as_str()
        )),
        2
    );
    assert_eq!(
        fixture.count(&format!(
            "SELECT kept FROM workflow_runs WHERE id = '{}'",
            joining_id.text().as_str()
        )),
        1
    );

    rebuild_workflow_runs(&fixture.rows, root_session);
    if root_session != TEST_SESSION_ID {
        rebuild_workflow_runs(&fixture.rows, TEST_SESSION_ID);
    }

    let rebuilt =
        [root_id, joining_id].map(|run_id| run_rows(&fixture.rows, run_id.text().as_str()));
    assert_eq!(rebuilt, live);
}
