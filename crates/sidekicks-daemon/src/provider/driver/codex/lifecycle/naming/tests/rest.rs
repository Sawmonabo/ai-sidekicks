//! A resting session's name, told to Codex on the service of the account its stored leg ran on.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::provider::driver::codex::lifecycle::CodexDriver;
use crate::provider::driver::codex::service::home::CodexServiceHome;
use crate::provider::driver::codex::service::registry::{CodexHomeResolver, CodexServiceRegistry};
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::test_registry::test_driver_services;
use crate::provider::runtime_binding::test_store::record_session_leg;

/// The statements the driver's read pool caches.
const POOL_STATEMENT_CAPACITY: usize = 8;

/// How long a rename that asks Codex nothing may take.
const NOTHING_SENT_BOUND: Duration = Duration::from_secs(5);

/// The conversation the session's stored leg names.
const STORED_THREAD: &str = "stored-thread";

// The scripted service's home for the one account a test names; any other account, the default
// one among them, has no home.
struct AccountHome {
    provider_account_id: ProviderAccountId,
    home: CodexServiceHome,
}

impl CodexHomeResolver for AccountHome {
    fn codex_home_for<'call>(
        &'call self,
        provider_account_id: Option<&'call ProviderAccountId>,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>> {
        let home = (provider_account_id == Some(&self.provider_account_id))
            .then(|| self.home.clone())
            .ok_or_else(|| DriverError::Internal("no home for that account".into()));
        Box::pin(async move { home })
    }
}

// A driver whose only service is the scripted one, on `provider_account_id`'s home, over the
// daemon's schema in `database`.
fn driver_on_account(
    scripted: &ScriptedCodexService,
    database: &TestDatabase,
    provider_account_id: ProviderAccountId,
) -> CodexDriver {
    drop((database.opener())().expect("the test database opens with the daemon's schema"));
    let mut services = test_driver_services();
    services.pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        POOL_STATEMENT_CAPACITY,
    ));
    let mut driver = CodexDriver::new(&services);
    driver.registry = CodexServiceRegistry::holding_on(
        scripted,
        Arc::new(AccountHome {
            provider_account_id,
            home: scripted.service.home().clone(),
        }),
    );
    driver
}

fn new_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

// Killed by resolving the resting session's service on the default account, which has no home
// here, and by dropping the stored handle from `thread/name/set`.
#[tokio::test]
async fn a_resting_session_is_renamed_on_its_stored_accounts_service_with_its_stored_handle() {
    let mut scripted = start_scripted_codex_service();
    let database = TestDatabase::new();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    let driver = driver_on_account(&scripted, &database, account.clone());
    let session_id = new_session_id();
    record_session_leg(&database, session_id, account, STORED_THREAD).await;

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
    let database = TestDatabase::new();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    let driver = driver_on_account(&scripted, &database, account);

    let told = tokio::time::timeout(
        NOTHING_SENT_BOUND,
        driver.tell_session_name(new_session_id(), "Fix the login page".to_owned()),
    )
    .await
    .expect("the rename answers without asking Codex");
    told.expect("a session that never ran has nothing to rename");
}
