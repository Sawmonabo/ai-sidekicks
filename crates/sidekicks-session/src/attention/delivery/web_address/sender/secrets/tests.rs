//! The person's calls on the web address and its secret, and the test message, over a test
//! database and a keychain in memory that refuses the calls a test names.

use std::collections::BTreeMap;
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::OptionalExtension as _;
use secrecy::{ExposeSecret as _, SecretString};
use serde_json::{Value, json};
use sidekicks_contracts::attention::{
    AttentionDeliveryChannel, AttentionDeliveryResult, AttentionDeliverySecret,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::BoundedInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::CredentialStore;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::TestStoreAccess;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use tempfile::TempDir;
use tokio::sync::watch;

use super::WebAddressCallError;
use crate::attention::delivery::outcome::attempt_outcome_statement;
use crate::attention::delivery::web_address::message::read_message_body;
use crate::attention::delivery::web_address::post::WebAddressPost;
use crate::attention::delivery::web_address::receiver_double::{closed_port, serve};
use crate::attention::delivery::web_address::sender::{
    WebAddressSender, WebAddressSenderDependencies,
};
use crate::attention::delivery::web_address::{SIGNING_SECRET_ACCOUNT, WEB_ADDRESS_ACCOUNT};
use crate::attention::projection::{MACHINE_VERSION_BUMP_SQL, statement};
use crate::attention::test_log::AttentionTestLog;

const DECIDE_SENT_SQL: &str = "INSERT INTO attention_deliveries
    (entry_id, banner_state, web_address_state, web_address_attempt_count)
  VALUES (@entry_id, 'withheld', 'pending', 0)";

/// The machine's settings as their defaults; the sender is never started here.
struct DefaultSettings;

impl MachineSettingsReader for DefaultSettings {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        async { Ok(MachineSettings::default()) }.boxed()
    }
}

/// A keychain in memory that yields once in each write, so two calls interleave, and refuses the
/// calls a test names with the refusal of a store that does not open.
struct TestKeychain {
    items: Mutex<BTreeMap<String, String>>,
    // Every call refused while set.
    is_refusing: Mutex<bool>,
    // The account whose next write is refused.
    refused_write: Mutex<Option<&'static str>>,
    // A keychain whose store never opens, the source of each refusal.
    unopened: Arc<dyn SecretKeychain>,
    _folder: TempDir,
}

impl TestKeychain {
    fn new() -> Arc<Self> {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let access = TestStoreAccess::new(CredentialStore::in_memory());
        access
            .opens
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let items = SecretItems::new(SecretItemsStart {
            data_folder: folder.path().to_path_buf(),
            runs_while_logged_out: false,
            access: access as _,
            call_timeout: Duration::from_secs(5),
        })
        .expect("the system gives random bytes");
        Arc::new(Self {
            items: Mutex::new(BTreeMap::new()),
            is_refusing: Mutex::new(false),
            refused_write: Mutex::new(None),
            unopened: Arc::new(items.keychain(KeychainService::DeliverySecrets)),
            _folder: folder,
        })
    }

    async fn refusal(&self) -> KeychainRefusal {
        self.unopened
            .accounts()
            .await
            .expect_err("a store that does not open refuses")
    }

    fn item(&self, account: &str) -> Option<String> {
        lock(&self.items).get(account).cloned()
    }
}

impl SecretKeychain for TestKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        async move {
            tokio::task::yield_now().await;
            let is_refused = *lock(&self.is_refusing)
                || lock(&self.refused_write)
                    .take_if(|refused| *refused == account)
                    .is_some();
            if is_refused {
                return Err(self.refusal().await);
            }
            lock(&self.items).insert(account.to_owned(), value.expose_secret().to_owned());
            Ok(())
        }
        .boxed()
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        async move {
            if *lock(&self.is_refusing) {
                return Err(self.refusal().await);
            }
            Ok(self.item(account).map(SecretString::from))
        }
        .boxed()
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        async move {
            if *lock(&self.is_refusing) {
                return Err(self.refusal().await);
            }
            Ok(lock(&self.items).remove(account).is_some())
        }
        .boxed()
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        async move {
            if *lock(&self.is_refusing) {
                return Err(self.refusal().await);
            }
            Ok(lock(&self.items).keys().cloned().collect())
        }
        .boxed()
    }
}

struct Fixture {
    log: AttentionTestLog,
    keychain: Arc<TestKeychain>,
    sender: WebAddressSender,
}

impl Fixture {
    /// A database with one named session and this machine's row, nothing saved in the keychain.
    async fn new() -> Self {
        let log = AttentionTestLog::new().await;
        let reader = log.database.reader();
        insert_session_row(
            &reader,
            log.session_id.text().as_str(),
            Some("Nightly bump"),
            None,
        );
        reader
            .execute(
                "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at)
                 VALUES (1, '018f0000-0000-7000-8000-0000000000a1',
                         '018f0000-0000-7000-8000-0000000000a2', 'studio-mac',
                         '2026-10-29T09:00:00.000Z')",
                [],
            )
            .expect("the test records this machine");
        let clock = Arc::new(TestWallClock::default());
        let scheduler = Arc::new(Scheduler::start(
            Arc::clone(&clock) as _,
            None,
            watch::channel(0).1,
        ));
        let keychain = TestKeychain::new();
        let sender = WebAddressSender::new(WebAddressSenderDependencies {
            writer: Arc::clone(&log.writer),
            pool: Arc::clone(&log.pool),
            changes: log.changes.clone(),
            settings: Arc::new(DefaultSettings),
            keychain: Arc::clone(&keychain) as _,
            scheduler,
            clock: clock as _,
        });
        Self {
            log,
            keychain,
            sender,
        }
    }

    async fn save(&self, address: &str) -> Result<Option<String>, WebAddressCallError> {
        let address: AttentionDeliverySecret =
            serde_json::from_value(json!(address)).expect("the address reads as a secret");
        self.sender.save_address(&address).await.map(|saved| {
            saved
                .signing_secret
                .map(|secret| secret.as_str().to_owned())
        })
    }

    fn count(&self, sql: &str) -> i64 {
        self.log
            .database
            .reader()
            .query_row(sql, [], |row| row.get(0))
            .expect("the test's count runs")
    }
}

fn refusal_of(error: WebAddressCallError) -> (RefusalCode, Option<Value>) {
    let WebAddressCallError::Refused(refusal) = error else {
        panic!("the call is refused, not failed");
    };
    (refusal.code, refusal.detail.map(Value::Object))
}

// The first save mints and shows the signing secret it keeps, a later save shows none and keeps
// the secret; a save whose address write fails leaves no address, so the next save mints again.
// Mutations: a secret minted at every save or shown again; the secret kept after a failed address
// write counted as a saved address.
#[tokio::test]
async fn the_first_save_shows_its_secret_once_and_a_failed_one_shows_a_fresh_one() {
    let fixture = Fixture::new().await;
    *lock(&fixture.keychain.refused_write) = Some(WEB_ADDRESS_ACCOUNT);
    let (code, _) = refusal_of(
        fixture
            .save("https://ntfy.sh/topic")
            .await
            .expect_err("the address write is refused"),
    );
    assert_eq!(code, RefusalCode::AttentionDeliveryStoreUnavailable);
    assert_eq!(fixture.keychain.item(WEB_ADDRESS_ACCOUNT), None);

    let shown = fixture
        .save("https://ntfy.sh/topic?auth=SECRET")
        .await
        .expect("the save is kept")
        .expect("with no address held, the save shows a secret");
    assert_eq!(
        fixture.keychain.item(SIGNING_SECRET_ACCOUNT),
        Some(shown.clone())
    );
    assert_eq!(
        fixture.keychain.item(WEB_ADDRESS_ACCOUNT).as_deref(),
        Some("https://ntfy.sh/topic?auth=SECRET")
    );

    let again = fixture
        .save("https://hooks.slack.com/services/T/B/X")
        .await
        .expect("the save is kept");
    assert_eq!(again, None, "a later save shows no secret");
    assert_eq!(fixture.keychain.item(SIGNING_SECRET_ACCOUNT), Some(shown));
}

// Two first saves at once leave the one secret shown standing: the second waits for the first and
// sees its address. Mutation: the secrets' lock not held across the save.
#[tokio::test]
async fn two_first_saves_at_once_leave_the_shown_secret_standing() {
    let fixture = Fixture::new().await;
    let (first, second) = tokio::join!(
        fixture.save("https://ntfy.sh/one"),
        fixture.save("https://ntfy.sh/two")
    );
    let shown: Vec<String> = [first, second]
        .into_iter()
        .filter_map(|saved| saved.expect("both saves are kept"))
        .collect();
    assert_eq!(shown.len(), 1, "one save shows a secret");
    assert_eq!(
        fixture.keychain.item(SIGNING_SECRET_ACCOUNT).as_ref(),
        shown.first()
    );
}

// Text that is no web address is refused before the keychain is touched; a keychain that cannot
// be used refuses each call with its cause; a new secret needs a saved address. Mutations: text
// with no scheme and host kept; a refusal answered as a fault or without its cause; rotate minting
// with no address.
#[tokio::test]
async fn each_refusal_answers_with_its_code_and_writes_nothing() {
    let fixture = Fixture::new().await;
    let (code, _) = refusal_of(
        fixture
            .save("ntfy.sh/topic")
            .await
            .expect_err("text with no scheme is refused"),
    );
    assert_eq!(code, RefusalCode::AttentionWebAddressNotAnAddress);
    assert!(lock(&fixture.keychain.items).is_empty(), "nothing is kept");

    let (code, detail) = refusal_of(
        fixture
            .sender
            .rotate_signing_secret()
            .await
            .expect_err("no address is saved"),
    );
    assert_eq!(
        (code, detail),
        (
            RefusalCode::AttentionDeliveryNotConfigured,
            Some(json!({ "missing": "address" }))
        )
    );
    assert!(
        lock(&fixture.keychain.items).is_empty(),
        "nothing is minted"
    );

    *lock(&fixture.keychain.is_refusing) = true;
    let (code, detail) = refusal_of(
        fixture
            .save("https://ntfy.sh/topic")
            .await
            .expect_err("the keychain cannot be used"),
    );
    assert_eq!(
        (code, detail),
        (
            RefusalCode::AttentionDeliveryStoreUnavailable,
            Some(json!({ "cause": "unavailable" }))
        )
    );
    let (code, _) = refusal_of(
        fixture
            .sender
            .list_deliveries()
            .await
            .expect_err("the list needs the keychain"),
    );
    assert_eq!(code, RefusalCode::AttentionDeliveryStoreUnavailable);
}

// A rotate replaces the secret and shows the new one; the list reads the address's scheme and host
// only; a removal takes the address, its secret, its outcome row and every message still to send,
// those dropped uncounted. Mutations: the path shown in the list; a removal leaving the secret, the
// outcome row or a waiting message; a dropped message counted.
#[tokio::test]
async fn a_removal_takes_the_address_its_secret_its_row_and_its_messages() {
    let fixture = Fixture::new().await;
    let first = fixture
        .save("https://u:p@ntfy.sh:8443/topic?auth=SECRET")
        .await
        .expect("the save is kept")
        .expect("the first save shows a secret");
    let rotated = fixture
        .sender
        .rotate_signing_secret()
        .await
        .expect("an address is saved")
        .signing_secret;
    assert_ne!(rotated.as_str(), first);
    assert_eq!(
        fixture.keychain.item(SIGNING_SECRET_ACCOUNT).as_deref(),
        Some(rotated.as_str())
    );

    let run_id = fixture.log.run(None);
    fixture
        .log
        .append(
            fixture
                .log
                .run_state(run_id, "waitingForInput", 2, json!({})),
        )
        .await;
    let entry = fixture.log.entry_of(run_id);
    fixture
        .log
        .writer
        .write(vec![
            statement(
                DECIDE_SENT_SQL,
                vec![("@entry_id".into(), entry.clone().into())],
            ),
            statement(&MACHINE_VERSION_BUMP_SQL, Vec::new()),
            attempt_outcome_statement(
                AttentionDeliveryChannel::WebAddress,
                &WireInstant::try_from("2026-10-29T09:00:00.000Z".to_owned()).expect("an instant"),
                AttentionDeliveryResult::Refused,
                None,
            ),
        ])
        .await
        .expect("the test decides the entry and records an attempt");
    fixture
        .log
        .database
        .reader()
        .execute(
            "INSERT INTO attention_web_address_sends (entry_id, body, next_attempt_at)
             VALUES (?1, x'7b7d', '2026-10-29T09:00:05.000Z')",
            [&entry],
        )
        .expect("the test queues the message");

    let listed = fixture
        .sender
        .list_deliveries()
        .await
        .expect("the list reads");
    assert!(listed.web_address.saved);
    assert_eq!(
        listed.web_address.host.as_ref().map(NonEmptyText::as_str),
        Some("https://ntfy.sh")
    );
    assert_eq!(
        listed
            .web_address
            .last_outcome
            .map(|outcome| outcome.result),
        Some(AttentionDeliveryResult::Refused)
    );
    assert!(!listed.email_digest.password_saved);

    fixture
        .sender
        .remove_address()
        .await
        .expect("the removal is kept");
    assert!(lock(&fixture.keychain.items).is_empty(), "both secrets go");
    let delivery: (String, i64) = fixture
        .log
        .database
        .reader()
        .query_row(
            "SELECT web_address_state, web_address_attempt_count FROM attention_deliveries
              WHERE entry_id = ?1",
            [&entry],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .expect("the delivery reads")
        .expect("the delivery stays");
    assert_eq!(delivery, ("undelivered".to_owned(), 0));
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM attention_web_address_sends"),
        0
    );
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM attention_delivery_outcomes"),
        0
    );
    let listed = fixture
        .sender
        .list_deliveries()
        .await
        .expect("the list reads");
    assert_eq!(
        (listed.web_address.saved, listed.web_address.host),
        (false, None)
    );
}

// The test message needs a saved address; with one it is one signed post of its own body, its
// `content` repeating its `text`, and it writes no row. Mutations: a test sent with no address; a
// moment's body sent; the test's outcome written to the row.
#[tokio::test]
async fn the_test_message_posts_once_and_writes_no_row() {
    let fixture = Fixture::new().await;
    let (code, detail) = refusal_of(
        fixture
            .sender
            .test_web_address()
            .await
            .expect_err("no address is saved"),
    );
    assert_eq!(
        (code, detail),
        (
            RefusalCode::AttentionDeliveryNotConfigured,
            Some(json!({ "missing": "address" }))
        )
    );

    let (port, received) = serve(StatusCode::OK).await;
    fixture
        .save(&format!("http://127.0.0.1:{port}/hook"))
        .await
        .expect("the save is kept");
    let tested = fixture
        .sender
        .test_web_address()
        .await
        .expect("the test is sent")
        .outcome;
    assert_eq!(
        (tested.result, tested.http_status.map(BoundedInt::get)),
        (AttentionDeliveryResult::Delivered, Some(200))
    );
    assert_eq!(tested.undelivered.get(), 0);
    let requests = lock(&received).clone();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_slice(&requests[0].body).expect("the test's body is JSON");
    assert_eq!(
        body,
        json!({
            "text": "Test message from studio-mac",
            "kind": "test",
            "at": tested.at.as_str(),
            "machine": "studio-mac",
            "content": "Test message from studio-mac",
        })
    );
    assert!(requests[0].headers.contains_key("webhook-signature"));
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM attention_delivery_outcomes"),
        0
    );

    // A closed port answers nothing, and the test still writes no row.
    let closed = closed_port().await;
    fixture
        .save(&format!("http://127.0.0.1:{closed}/hook"))
        .await
        .expect("the save is kept");
    let tested = fixture
        .sender
        .test_web_address()
        .await
        .expect("the test is sent")
        .outcome;
    assert_eq!(tested.result, AttentionDeliveryResult::Unreachable);
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM attention_delivery_outcomes"),
        0
    );
}

// The names of the environment variables holding the person's own chat addresses.
const LIVE_ADDRESS_VARIABLES: [&str; 3] = [
    "SIDEKICKS_LIVE_SLACK_ADDRESS",
    "SIDEKICKS_LIVE_DISCORD_ADDRESS",
    "SIDEKICKS_LIVE_NTFY_ADDRESS",
];

// One test message and one moment's message to each of the person's own Slack, Discord and ntfy
// addresses, each answered with a 2xx, so each service takes the body as sent.
#[tokio::test]
#[ignore = "posts to the person's own Slack, Discord and ntfy addresses; needs them in the environment"]
async fn each_chat_service_takes_the_test_and_a_moment() {
    for variable in LIVE_ADDRESS_VARIABLES {
        let address = std::env::var(variable)
            .unwrap_or_else(|_unset| panic!("{variable} holds the address to post to"));
        let fixture = Fixture::new().await;
        fixture.save(&address).await.expect("the save is kept");
        let tested = fixture
            .sender
            .test_web_address()
            .await
            .expect("the test is sent")
            .outcome;
        assert_eq!(
            tested.result,
            AttentionDeliveryResult::Delivered,
            "{variable}'s test"
        );

        let run_id = fixture.log.run(None);
        fixture
            .log
            .append(
                fixture
                    .log
                    .run_state(run_id, "waitingForInput", 2, json!({})),
            )
            .await;
        let entry = fixture.log.entry_of(run_id);
        let body = read_message_body(&fixture.log.database.reader(), &entry, "studio-mac")
            .expect("the entry reads")
            .expect("the entry has a message");
        let (address, signing_secret) = fixture
            .sender
            .read_secrets()
            .await
            .expect("the keychain answers")
            .expect("the address is saved");
        let posted = fixture
            .sender
            .poster
            .post(WebAddressPost {
                address: &address,
                signing_secret: &signing_secret,
                message_id: &entry,
                body: &body,
                attempted_at: fixture.sender.now().0,
            })
            .await
            .expect("the moment is posted");
        assert_eq!(
            posted.result,
            AttentionDeliveryResult::Delivered,
            "{variable}'s moment"
        );
    }
}
