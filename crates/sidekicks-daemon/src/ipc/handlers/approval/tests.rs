//! `approval.list` over a test database: a session the daemon does not hold is refused, never
//! answered with no asks.

use std::sync::Arc;

use sidekicks_contracts::approval::ApprovalListRequest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};

use super::{APPROVAL_METHODS_STATEMENT_CAPACITY, list_approvals};
use crate::remote::shared_ports::schema::schema_parts;

// A list of a session with no row is refused `session.notFound`, and once its row is written the
// same list answers its asks, none yet. Killed by dropping the existence read, which answers the
// unknown session with an empty list.
#[tokio::test]
async fn a_list_of_an_unknown_session_is_refused() {
    let database = TestDatabase::new(schema_parts());
    let schema = database.opener()().expect("the test creates its database");
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        APPROVAL_METHODS_STATEMENT_CAPACITY,
    ));
    let session_id = test_session_id();
    let request = || ApprovalListRequest {
        session_id,
        state: None,
        category: None,
    };

    let refused = list_approvals(&pool, request()).await;
    assert!(
        matches!(&refused, Err(HandlerError::Refused(refusal))
            if refusal.code == RefusalCode::SessionNotFound),
        "an unknown session is refused: {refused:?}"
    );

    insert_session_row(&schema, session_id.text().as_str(), None, None);
    let listed = list_approvals(&pool, request())
        .await
        .expect("a held session's asks are listed");
    assert!(listed.approvals.is_empty(), "{listed:?}");
}
