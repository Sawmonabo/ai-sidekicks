//! A resting session's name, told to Codex on the service of the account its stored leg ran on.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::driver_on_account;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::new_session_id;
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::runtime_binding::test_store::record_session_leg;

/// How long a rename that asks Codex nothing may take.
const NOTHING_SENT_BOUND: Duration = Duration::from_secs(5);

/// The conversation the session's stored leg names.
const STORED_THREAD: &str = "stored-thread";

// Killed by resolving the resting session's service on any account but its stored leg's, which
// has no home here, and by dropping the stored handle from `thread/name/set`.
#[tokio::test]
async fn a_resting_session_is_renamed_on_its_stored_accounts_service_with_its_stored_handle() {
    let mut scripted = start_scripted_codex_service();
    let database = TestDatabase::new(schema_parts());
    let engine = Arc::new(RecordingRunEngine::default());
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    let driver = driver_on_account(&scripted, &engine, account.clone());
    let session_id = new_session_id();
    record_session_leg(&database, &engine, session_id, account, STORED_THREAD).await;

    let told = driver.tell_session_name(session_id, "Fix the login page".to_owned());
    tokio::pin!(told);
    let sent = tokio::select! {
        told = &mut told => panic!("the rename answered before it was sent: {told:?}"),
        sent = scripted.script.next_sent() => sent,
    };
    assert_eq!(sent["method"], "thread/name/set");
    assert_eq!(
        sent["params"],
        json!({"threadId": STORED_THREAD, "name": "Fix the login page"})
    );
    scripted.script.answer(&sent, &json!({}));
    told.await.expect("Codex takes the name");
}

// Killed by refusing a session with no stored leg. A request sent would wait for the answer the
// script never gives, past the test's bound.
#[tokio::test]
async fn a_session_that_never_ran_renames_with_nothing_sent() {
    let scripted = start_scripted_codex_service();
    let engine = Arc::new(RecordingRunEngine::default());
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    let driver = driver_on_account(&scripted, &engine, account);

    let told = tokio::time::timeout(
        NOTHING_SENT_BOUND,
        driver.tell_session_name(new_session_id(), "Fix the login page".to_owned()),
    )
    .await
    .expect("the rename answers without asking Codex");
    told.expect("a session that never ran has nothing to rename");
}
