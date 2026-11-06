use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::methods::ProviderAccountInUseDetails;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::ProviderAccountRemovalError;
use crate::account::credential_home::marks::{mark_minted, read_minted_homes, read_removed_homes};
use crate::account::credential_home::reset_credential_home;
use crate::account::credential_home::test_legs::RecordedSignOuts;
use crate::account::home_lock::AccountHomeLock;
use crate::account::observer::AccountLiveTurns;
use crate::account::registry::tests::{create_workflow_steps_table, register};
use crate::account::registry::{ProviderAccountRegistry, RegisteredAccount, open_test_registry};
use crate::account::token_custody::ProviderTokenCustody;
use crate::account::token_custody::tests::{ScriptedKeychain, snapshot};
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::MockProviderDriver;
use crate::driver::registry::ProviderRegistry;
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::{new_session_id, registry_of_first_provider};

// The sessions a test says have a turn live on every account.
struct LiveSessions(Vec<SessionId>);

impl AccountLiveTurns for LiveSessions {
    fn sessions_with_live_turns(&self, _provider_account_id: &ProviderAccountId) -> Vec<SessionId> {
        self.0.clone()
    }
}

struct Fixture {
    database: TestDatabase,
    data_folder: tempfile::TempDir,
    registry: Arc<ProviderAccountRegistry>,
    writer: Arc<DatabaseWriter>,
    keychain: Arc<ScriptedKeychain>,
    custody: ProviderTokenCustody,
    home_lock: AccountHomeLock,
    account: RegisteredAccount,
}

impl Fixture {
    // One signed-in account with a sealed token, a quota reading and a usage turn, beside the
    // workflow steps the removal's guard reads.
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let (registry, writer) = open_test_registry(&database, data_folder.path()).await;
        let registry = Arc::new(registry);
        let keychain = Arc::new(ScriptedKeychain::default());
        let custody = ProviderTokenCustody::new(
            Arc::clone(&registry),
            Arc::clone(&keychain) as _,
            HashMap::new(),
        );
        let account = register(&registry, "claude").await;
        let fixture = Self {
            database,
            data_folder,
            registry,
            writer,
            keychain,
            custody,
            home_lock: AccountHomeLock::default(),
            account,
        };
        create_workflow_steps_table(&fixture.database);
        fixture
            .keychain
            .write(fixture.account_id().as_str(), &SecretString::from("token"))
            .await
            .expect("the token is sealed");
        fixture
            .run(
                "INSERT INTO provider_account_usage_windows
                   (account_id, limit_id, window_mins, used_percent, observed_at,
                    observed_credential_generation, source)
                 SELECT account_id, 'session', 300, 40.0, '2026-11-01T12:00:00.000Z',
                        credential_generation, 'probe'
                   FROM provider_accounts WHERE account_id = @account_id",
            )
            .await;
        fixture
            .run(
                "INSERT INTO provider_account_usage_turns
                   (turn_id, account_id, provider, occurred_at, observed_credential_generation)
                 SELECT 'turn-1', account_id, provider, '2026-11-01T12:00:00.000Z',
                        credential_generation
                   FROM provider_accounts WHERE account_id = @account_id",
            )
            .await;
        fixture
    }

    fn account_id(&self) -> &ProviderAccountId {
        &self.account.account_id
    }

    // Runs `sql` with `@account_id` bound to the fixture's account where it names it.
    async fn run(&self, sql: &'static str) {
        let bindings = if sql.contains("@account_id") {
            StatementBindings::Named(vec![text_binding(
                "@account_id",
                self.account_id().as_str(),
            )])
        } else {
            StatementBindings::None
        };
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(sql),
                bindings,
                expected_row_count: None,
            }])
            .await
            .expect("the statement runs");
    }

    async fn remove(
        &self,
        live_sessions: Vec<SessionId>,
        drivers: &ProviderRegistry,
    ) -> Result<(), ProviderAccountRemovalError> {
        self.registry
            .remove_account(
                self.account_id(),
                &LiveSessions(live_sessions),
                &self.custody,
                drivers,
                &self.home_lock,
            )
            .await
    }

    // The fixture account's stored readings: each quota window's generation stamp, and how many
    // usage turns it has.
    fn readings(&self) -> (Vec<i64>, i64) {
        let connection =
            rusqlite::Connection::open(self.database.path()).expect("the database opens");
        let account_id = self.account_id().as_str();
        let windows = connection
            .prepare(
                "SELECT observed_credential_generation FROM provider_account_usage_windows
                  WHERE account_id = ?",
            )
            .expect("the windows' read prepares")
            .query_map([account_id], |row| row.get(0))
            .expect("the windows read")
            .collect::<Result<_, _>>()
            .expect("each window reads");
        let turns = connection
            .query_row(
                "SELECT count(*) FROM provider_account_usage_turns WHERE account_id = ?",
                [account_id],
                |row| row.get(0),
            )
            .expect("the turns are counted");
        (windows, turns)
    }

    async fn sealed_token(&self) -> Option<SecretString> {
        self.keychain
            .read(self.account_id().as_str())
            .await
            .expect("the keychain reads")
    }
}

// What a refused removal is refused for.
#[derive(Clone, Copy)]
enum Holder {
    ParkedStep,
    RunningSession,
}

/// A step parked on the account, or a session running on it, refuses the removal
/// `provider.account.inUse`, naming the step's workflow run or the session, and leaves the account
/// registered with its token, its readings and every driver's memory of it. Fails when the waiting
/// steps or the running sessions are not read before the intent is marked, and when a parked step
/// is refused without its workflow run named.
#[rstest]
#[case::parked_step(Holder::ParkedStep)]
#[case::running_session(Holder::RunningSession)]
#[tokio::test]
async fn a_held_account_refuses_its_removal_and_keeps_everything(#[case] holder: Holder) {
    let fixture = Fixture::new().await;
    // Any call to forget the account fails the test.
    let drivers = registry_of_first_provider(Arc::new(MockProviderDriver::new()));
    let mut live_sessions = Vec::new();
    let named = match holder {
        Holder::ParkedStep => {
            fixture
                .run(
                    "INSERT INTO workflow_steps \
                     (workflow_run_id, wait_account_id, status, wait_cause)
                     VALUES ('0190a3b4-0000-7000-8000-000000000001', @account_id, 'waiting',
                             'account')",
                )
                .await;
            ProviderAccountInUseDetails::WaitingSteps {
                workflow_run_ids: BoundedVec::new(vec![
                    WorkflowRunId::new("0190a3b4-0000-7000-8000-000000000001")
                        .expect("a test workflow run id"),
                ])
                .expect("one run"),
            }
        }
        Holder::RunningSession => {
            live_sessions.push(new_session_id());
            ProviderAccountInUseDetails::Sessions {
                session_ids: BoundedVec::new(live_sessions.clone()).expect("one session"),
            }
        }
    };

    let refused = fixture
        .remove(live_sessions.clone(), &drivers)
        .await
        .expect_err("a held account is not removed");

    let HandlerError::Refused(refusal) = HandlerError::from(refused) else {
        panic!("a held account answers a refusal");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderAccountInUse);
    assert_eq!(
        refusal
            .detail
            .map(|detail| serde_json::Value::Object(*detail)),
        Some(serde_json::to_value(named).expect("the details write"))
    );
    let ids = fixture
        .registry
        .read_account_ids_by_removal_intent()
        .await
        .expect("the accounts read");
    assert_eq!(ids.registered, [fixture.account_id().clone()]);
    assert!(ids.marked.is_empty(), "the removal intent stays 0");
    assert!(fixture.sealed_token().await.is_some());
    assert_eq!(fixture.readings(), (vec![1], 1));
}

/// A home reset leaves the account's quota readings stamped with the generation before it while
/// its sign-in reads gone at the next one; its removal then destroys the sealed token, read from
/// the keychain itself, writes a removed mark naming its provider beside the homes, deletes its
/// row, readings and usage turns, tells each driver to forget it, and leaves its home byte for
/// byte, clearing the minted mark its admission failed to clear. Fails when the token is left
/// behind, when the readings outlive the row, when the removal writes into the home, when no
/// removed mark is written, when the mark is a minted one, and when the stale minted mark is kept:
/// either would have the next start's sweep sign the removed home out and delete it.
#[tokio::test]
async fn a_removal_shreds_what_the_account_kept_and_leaves_its_home() {
    let fixture = Fixture::new().await;
    let home = fixture.account.credential_home.path().to_owned();
    reset_credential_home(
        &fixture.registry,
        &AccountHomeLock::default(),
        &RecordedSignOuts::default(),
        fixture.account_id().clone(),
        ProviderAccountFolders {
            configuration_folder: home.clone(),
            credential_store_folder: home.clone(),
        },
    )
    .await
    .expect("the home is reset");
    let reset = fixture
        .registry
        .read(fixture.account_id().clone())
        .await
        .expect("the account reads");
    assert_eq!(reset.credential_generation.get(), 2);
    assert_eq!(
        reset.health.map(|health| health.state),
        Some(ProviderAccountHealthState::ReauthRequired)
    );
    assert_eq!(fixture.readings(), (vec![1], 1));
    fs::write(home.join("settings.json"), b"{\"kept\":true}").expect("the settings are kept");
    // An admission whose clear of the minted mark failed leaves it beside the row.
    mark_minted(
        fixture.data_folder.path(),
        fixture.account_id(),
        &fixture.account.provider,
    )
    .expect("the stale minted mark is written");
    let home_before = snapshot(&home);
    let mut driver = MockProviderDriver::new();
    let forgotten = fixture.account_id().clone();
    driver
        .expect_forget_account()
        .withf(move |account_id| *account_id == forgotten)
        .times(1)
        .return_const(());
    let drivers = registry_of_first_provider(Arc::new(driver));

    fixture
        .remove(Vec::new(), &drivers)
        .await
        .expect("the account is removed");

    assert!(fixture.sealed_token().await.is_none());
    let ids = fixture
        .registry
        .read_account_ids_by_removal_intent()
        .await
        .expect("the accounts read");
    assert!(ids.registered.is_empty() && ids.marked.is_empty());
    assert_eq!(fixture.readings(), (Vec::new(), 0));
    let removed: Vec<_> = read_removed_homes(fixture.data_folder.path())
        .expect("the removed marks read")
        .into_iter()
        .map(|marked| (marked.account_id, marked.provider, marked.home))
        .collect();
    assert_eq!(
        removed,
        [(
            fixture.account_id().clone(),
            fixture.account.provider.clone(),
            fixture.account.credential_home.clone(),
        )]
    );
    assert!(
        read_minted_homes(fixture.data_folder.path())
            .expect("the minted marks read")
            .is_empty(),
        "the removal leaves no minted mark"
    );
    assert_eq!(snapshot(&home), home_before);
}

// Killed by the removal's check and mark run without the account's home held: the account would
// be marked while a sign-in or renewal holding the home still writes there.
#[tokio::test]
async fn a_removal_waits_for_the_account_s_home() {
    let fixture = Fixture::new().await;
    let mut driver = MockProviderDriver::new();
    driver.expect_forget_account().return_const(());
    let drivers = registry_of_first_provider(Arc::new(driver));
    let held = fixture.home_lock.hold(fixture.account_id().clone()).await;

    let removal = fixture.remove(Vec::new(), &drivers);
    tokio::pin!(removal);
    let is_done_while_held = tokio::time::timeout(Duration::from_millis(200), &mut removal)
        .await
        .is_ok();
    let marked_while_held = fixture
        .registry
        .read_account_ids_by_removal_intent()
        .await
        .expect("the accounts read")
        .marked;
    drop(held);
    removal
        .await
        .expect("the account is removed once its home is free");

    assert!(
        !is_done_while_held,
        "the removal ran while the home was held"
    );
    assert!(
        marked_while_held.is_empty(),
        "the account was marked while its home was held"
    );
}
