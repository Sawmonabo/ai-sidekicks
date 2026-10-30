//! The sender over a test database, a test wall clock its retries are due on, the delivery
//! secrets' keychain in memory and a receiver on a loopback port.

use std::error::Error;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{Connection, OptionalExtension as _};
use secrecy::SecretString;
use serde_json::json;
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{CredentialStore, WallClock as _};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::TestStoreAccess;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use tempfile::TempDir;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{RETRY_DELAYS, WebAddressSender, WebAddressSenderDependencies};
use crate::attention::delivery::web_address::queue::MAX_WAITING_MESSAGES;
use crate::attention::delivery::web_address::receiver_double::{
    Answer, ReceivedRequests, closed_port, serve_answers,
};
use crate::attention::delivery::web_address::signature::mint_signing_secret;
use crate::attention::delivery::web_address::{SIGNING_SECRET_ACCOUNT, WEB_ADDRESS_ACCOUNT};
use crate::attention::projection::{MACHINE_VERSION_BUMP_SQL, statement};
use crate::attention::test_log::AttentionTestLog;

// Long enough for a write and a read on a loaded machine, and for an attempt's 15 s timeout.
const WAIT: Duration = Duration::from_secs(30);

const DECIDE_SENT_SQL: &str = "INSERT INTO attention_deliveries
    (entry_id, banner_state, web_address_state, web_address_attempt_count)
  VALUES (@entry_id, 'withheld', 'pending', 0)";

/// The machine's settings as the test sets them, counting the sender's reads, and the
/// announcement of each change.
struct TestSettings {
    settings: Mutex<MachineSettings>,
    reads: AtomicUsize,
    announce: watch::Sender<MachineSettings>,
}

impl MachineSettingsReader for TestSettings {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let settings = lock(&self.settings).clone();
        async move { Ok(settings) }.boxed()
    }
}

/// The delivery a test reads: its state and its tries.
type DeliveryRow = (Option<String>, Option<i64>);

/// The web address's outcome row: its result, its status and the messages given up on.
type OutcomeRow = (Option<String>, Option<i64>, i64);

struct Fixture {
    log: AttentionTestLog,
    clock: Arc<TestWallClock>,
    scheduler: Arc<Scheduler>,
    settings: Arc<TestSettings>,
    keychain: Arc<dyn SecretKeychain>,
    store_opens: Arc<AtomicBool>,
    _secrets_folder: TempDir,
    sender: Option<(Arc<WebAddressSender>, CancellationToken, JoinHandle<()>)>,
}

impl Fixture {
    /// A database with one named session and this machine's row, the switch on and the address
    /// `http://127.0.0.1:<port>/hook` saved with its secret; the sender is not started.
    async fn new(port: u16) -> Self {
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
        let mut machine_settings = MachineSettings::default();
        machine_settings.notifications.web_address.enabled = true;
        let settings = Arc::new(TestSettings {
            settings: Mutex::new(machine_settings.clone()),
            reads: AtomicUsize::new(0),
            announce: watch::Sender::new(machine_settings),
        });
        let secrets_folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let credentials = CredentialStore::in_memory();
        // The test saves through items of its own, so the sender's items first open the store at
        // the sender's first read, which a test can refuse.
        let saving = delivery_keychain(
            secrets_folder.path(),
            TestStoreAccess::new(credentials.clone()),
        );
        let access = TestStoreAccess::new(credentials);
        let store_opens = Arc::clone(&access.opens);
        let keychain = delivery_keychain(secrets_folder.path(), access);
        let address = SecretString::from(format!("http://127.0.0.1:{port}/hook"));
        let secret = mint_signing_secret().expect("the system's random source");
        saving
            .write_verified(SIGNING_SECRET_ACCOUNT, &secret)
            .await
            .expect("the test saves the secret");
        saving
            .write_verified(WEB_ADDRESS_ACCOUNT, &address)
            .await
            .expect("the test saves the address");
        let clock = Arc::new(TestWallClock::default());
        let scheduler = Arc::new(Scheduler::start(
            Arc::clone(&clock) as _,
            None,
            watch::channel(0).1,
        ));
        Self {
            log,
            clock,
            scheduler,
            settings,
            keychain,
            store_opens,
            _secrets_folder: secrets_folder,
            sender: None,
        }
    }

    /// Starts a sender, after stopping the one running, as a restart of the daemon does.
    async fn start(&mut self) {
        self.stop().await;
        let sender = Arc::new(WebAddressSender::new(WebAddressSenderDependencies {
            writer: Arc::clone(&self.log.writer),
            pool: Arc::clone(&self.log.pool),
            changes: self.log.changes.clone(),
            settings: Arc::clone(&self.settings) as _,
            keychain: Arc::clone(&self.keychain),
            scheduler: Arc::clone(&self.scheduler),
            clock: Arc::clone(&self.clock) as _,
        }));
        let stop = CancellationToken::new();
        let task = sender.start(self.settings.announce.subscribe(), stop.clone());
        self.sender = Some((sender, stop, task));
    }

    async fn stop(&mut self) {
        if let Some((_, stop, task)) = self.sender.take() {
            stop.cancel();
            task.await.expect("the sender ends with its stop");
        }
    }

    fn sender(&self) -> &Arc<WebAddressSender> {
        &self.sender.as_ref().expect("the sender runs").0
    }

    /// Turns `Send to a web address` on or off and announces it.
    fn switch(&self, is_on: bool) {
        let mut settings = lock(&self.settings.settings);
        settings.notifications.web_address.enabled = is_on;
        self.settings.announce.send_replace(settings.clone());
    }

    /// A run's wait on the person, its entry decided to go to the web address as the gate decides
    /// it, which raises the counts.
    async fn waiting(&self) -> (RunId, String) {
        let run_id = self.log.run(None);
        self.log
            .append(self.log.run_state(run_id, "waitingForInput", 2, json!({})))
            .await;
        let entry = self.log.entry_of(run_id);
        self.decide_sent(&entry).await;
        (run_id, entry)
    }

    /// `run_id`'s end, decided to go to the web address.
    async fn finished(&self, run_id: RunId) -> String {
        self.log
            .append(self.log.run_state(run_id, "completed", 3, json!({})))
            .await;
        let (entries, _) = self.log.entries_of(run_id);
        let entry = entries
            .into_iter()
            .find(|entry| self.delivery(entry).0.is_none())
            .expect("the end raised its entry");
        self.decide_sent(&entry).await;
        entry
    }

    async fn decide_sent(&self, entry: &str) {
        self.log
            .writer
            .write(vec![
                statement(
                    DECIDE_SENT_SQL,
                    vec![("@entry_id".into(), entry.to_owned().into())],
                ),
                statement(&MACHINE_VERSION_BUMP_SQL, Vec::new()),
            ])
            .await
            .expect("the test decides the entry");
    }

    /// Moves the wall clock on by `span`, which fires a retry due by then.
    fn advance(&self, span: Duration) {
        self.clock.set_now(self.clock.now() + span);
    }

    fn delivery(&self, entry: &str) -> DeliveryRow {
        self.read(|reader| {
            reader
                .query_row(
                    "SELECT web_address_state, web_address_attempt_count FROM attention_deliveries
                      WHERE entry_id = ?1",
                    [entry],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map(Option::unwrap_or_default)
        })
    }

    fn send(&self, entry: &str) -> Option<(Vec<u8>, String)> {
        self.read(|reader| {
            reader
                .query_row(
                    "SELECT body, next_attempt_at FROM attention_web_address_sends
                      WHERE entry_id = ?1",
                    [entry],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
        })
    }

    fn waiting_count(&self) -> usize {
        let count: i64 = self.read(|reader| {
            reader.query_row(
                "SELECT COUNT(*) FROM attention_web_address_sends",
                [],
                |row| row.get(0),
            )
        });
        usize::try_from(count).expect("a count is never negative")
    }

    fn outcome(&self) -> Option<OutcomeRow> {
        self.read(|reader| {
            reader
                .query_row(
                    "SELECT result, http_status, undelivered FROM attention_delivery_outcomes
                      WHERE channel = 'webAddress'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
        })
    }

    fn read<Answer>(&self, read: impl FnOnce(&Connection) -> rusqlite::Result<Answer>) -> Answer {
        read(&self.log.database.reader()).expect("the test's read runs")
    }

    /// Waits until `holds` reads true, naming `what` when it never does.
    async fn until(&self, what: &str, holds: impl Fn(&Self) -> bool) {
        tokio::time::timeout(WAIT, async {
            while !holds(self) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_elapsed| panic!("{what}"));
    }

    /// Waits until `entry`'s delivery reads `state` after `tries` tries.
    async fn until_delivery(&self, entry: &str, state: &str, tries: i64) {
        self.until(
            &format!("{entry} reads {state} after {tries} tries"),
            |fixture| fixture.delivery(entry) == (Some(state.to_owned()), Some(tries)),
        )
        .await;
    }
}

// The delivery secrets' keychain of items kept in `folder` and the store `access` offers.
fn delivery_keychain(folder: &Path, access: Arc<TestStoreAccess>) -> Arc<dyn SecretKeychain> {
    let items = SecretItems::new(SecretItemsStart {
        data_folder: folder.to_path_buf(),
        runs_while_logged_out: false,
        access: access as _,
        call_timeout: Duration::from_secs(5),
    })
    .expect("the system gives random bytes");
    Arc::new(items.keychain(KeychainService::DeliverySecrets))
}

fn requests(received: &ReceivedRequests) -> usize {
    lock(received).len()
}

fn result_row(result: &str, status: Option<i64>, undelivered: i64) -> OutcomeRow {
    (Some(result.to_owned()), status, undelivered)
}

/// How the address answers each try in a case of the attempt table.
#[derive(Clone, Copy, Debug)]
enum Address {
    Answering(Answer),
    Closed,
    InALockedKeychain,
}

// Every try's ending as the delivery, its message and the outcome row record it: a 2xx delivers,
// any other ending is retried 5 s, 5 min and 30 min later and the fourth gives up, counted, its
// entry left present and unresolved. Mutations: a redirect followed; a retry past the third or on
// another schedule; a locked keychain left uncounted; a give-up left uncounted or its entry
// resolved; the sender woken by its own write.
#[rstest]
#[case::delivered(
    Address::Answering(Answer::Status(StatusCode::OK)),
    1,
    "delivered",
    Some(200)
)]
#[case::a_redirect_not_followed(Address::Answering(Answer::Redirect), 1, "refused", Some(302))]
#[case::refused_four_times(
    Address::Answering(Answer::Status(StatusCode::INTERNAL_SERVER_ERROR)),
    4,
    "refused",
    Some(500)
)]
#[case::no_answer_in_15_seconds(Address::Answering(Answer::Hang), 1, "timedOut", None)]
#[case::a_closed_port(Address::Closed, 1, "unreachable", None)]
#[case::a_locked_keychain_four_times(Address::InALockedKeychain, 4, "storeUnavailable", None)]
#[tokio::test]
async fn each_try_ends_as_the_address_answers(
    #[case] address: Address,
    #[case] tries: i64,
    #[case] result: &str,
    #[case] status: Option<i64>,
) {
    let (port, received) = match address {
        Address::Answering(answer) => serve_answers(vec![answer]).await,
        Address::Closed | Address::InALockedKeychain => {
            (closed_port().await, ReceivedRequests::default())
        }
    };
    let mut fixture = Fixture::new(port).await;
    if matches!(address, Address::InALockedKeychain) {
        fixture.store_opens.store(false, Ordering::SeqCst);
    }
    let (run_id, entry) = fixture.waiting().await;
    fixture.start().await;

    for tried in 1..=tries {
        let is_settled = result == "delivered" || tried == 4;
        let state = match (result, tried == 4) {
            ("delivered", _) => "delivered",
            (_, true) => "undelivered",
            (_, false) => "pending",
        };
        fixture.until_delivery(&entry, state, tried).await;
        assert_eq!(
            fixture.outcome(),
            Some(result_row(result, status, i64::from(tried == 4)))
        );
        if is_settled {
            assert_eq!(
                fixture.send(&entry),
                None,
                "a settled message leaves the queue"
            );
            continue;
        }
        let delay = RETRY_DELAYS[usize::try_from(tried - 1).expect("a few tries")];
        let (_, due_at) = fixture
            .send(&entry)
            .expect("the message waits for its retry");
        let attempted_at = jiff::Timestamp::try_from(fixture.clock.now()).expect("a timestamp");
        assert_eq!(
            WireInstant::try_from(due_at)
                .ok()
                .and_then(|due| due.timestamp()),
            attempted_at.checked_add(delay).ok(),
            "try {tried} is retried after {delay:?}"
        );
        if tried < tries {
            fixture.advance(delay.saturating_sub(Duration::from_millis(1)));
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(
                fixture.delivery(&entry).1,
                Some(tried),
                "no try before its delay"
            );
            fixture.advance(Duration::from_millis(1));
        }
    }
    if result == "delivered" {
        // The start's one pass delivered it; the sender's own write woke no other.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fixture.settings.reads.load(Ordering::SeqCst), 1);
    }
    if let Address::Answering(_) = address {
        assert_eq!(
            requests(&received),
            usize::try_from(tries).expect("a few tries")
        );
        assert!(
            lock(&received)
                .iter()
                .all(|request| request.path_and_query == "/hook"),
            "a redirect is never followed"
        );
    }
    let (ids, open) = fixture.log.entries_of(run_id);
    assert_eq!(
        (ids, open),
        (vec![entry], 1),
        "the entry stays present and unresolved"
    );
    fixture.stop().await;
}

// Past 100 waiting, the oldest waiting gives up, counted, and the newest waits; a delivery's delete
// takes its waiting message with it. Mutations: the bound dropped or the newest given up; the
// give-up left uncounted; the reference to the delivery dropped.
#[tokio::test]
async fn past_the_bound_the_oldest_waiting_gives_up_counted() {
    let mut fixture = Fixture::new(closed_port().await).await;
    fixture.store_opens.store(false, Ordering::SeqCst);
    let mut entries = Vec::new();
    for _ in 0..MAX_WAITING_MESSAGES {
        entries.push(fixture.waiting().await.1);
    }
    fixture.start().await;
    fixture
        .until("every message is tried once", |fixture| {
            entries
                .iter()
                .all(|entry| fixture.delivery(entry) == (Some("pending".to_owned()), Some(1)))
        })
        .await;

    let (_, newest) = fixture.waiting().await;
    let oldest = &entries[0];
    fixture.until_delivery(oldest, "undelivered", 1).await;
    fixture
        .until("the newest message waits", |fixture| {
            fixture.send(&newest).is_some()
        })
        .await;
    assert_eq!(fixture.waiting_count(), MAX_WAITING_MESSAGES);
    assert_eq!(fixture.outcome().map(|outcome| outcome.2), Some(1));

    fixture.stop().await;
    let second = &entries[1];
    fixture
        .log
        .writer
        .write(vec![statement(
            "DELETE FROM attention_deliveries WHERE entry_id = @entry_id",
            vec![("@entry_id".into(), second.clone().into())],
        )])
        .await
        .expect("the test deletes a delivery as a purge does");
    assert_eq!(
        fixture.send(second),
        None,
        "the delivery's delete takes its message"
    );
}

// A restart sends a waiting message whose retry fell due while the daemon was stopped at once,
// with the same id and bytes, and sends nothing already settled. Mutations: the queue kept in
// memory only; the body built again at the retry; a settled delivery sent again.
#[tokio::test]
async fn a_restart_sends_a_waiting_message_at_once_with_its_frozen_bytes() {
    let (port, received) = serve_answers(vec![
        Answer::Status(StatusCode::OK),
        Answer::Status(StatusCode::SERVICE_UNAVAILABLE),
        Answer::Status(StatusCode::OK),
    ])
    .await;
    let mut fixture = Fixture::new(port).await;
    fixture.start().await;
    let (_, delivered) = fixture.waiting().await;
    fixture.until_delivery(&delivered, "delivered", 1).await;
    let (_, retried) = fixture.waiting().await;
    fixture.until_delivery(&retried, "pending", 1).await;
    fixture.stop().await;

    fixture.advance(Duration::from_hours(1));
    fixture.start().await;

    fixture.until_delivery(&retried, "delivered", 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let requests = lock(&received).clone();
    let [first, failed, resent] = requests.as_slice() else {
        panic!("three tries reached the address: {requests:?}");
    };
    assert_eq!(first.headers["webhook-id"], delivered.as_str());
    assert_eq!(failed.headers["webhook-id"], retried.as_str());
    assert_eq!(resent.headers["webhook-id"], retried.as_str());
    assert_eq!(
        failed.body, resent.body,
        "the restart resends the frozen bytes"
    );
    fixture.stop().await;
}

// Abandoning the attempt in flight under the secrets' lock returns once it ended, with nothing
// written; with the address removed, its message is dropped uncounted. Mutations: the attempt not
// abandoned, or its outcome written after the abandon.
#[tokio::test]
async fn an_abandoned_attempt_writes_nothing_and_a_removed_address_drops_its_message() {
    let (port, received) = serve_answers(vec![Answer::Hang]).await;
    let mut fixture = Fixture::new(port).await;
    fixture.start().await;
    let (_, entry) = fixture.waiting().await;
    fixture
        .until("the attempt reaches the address", |_| {
            requests(&received) == 1
        })
        .await;

    let sender = Arc::clone(fixture.sender());
    let held = sender.lock_secrets().await;
    tokio::time::timeout(Duration::from_secs(5), sender.abandon_attempt(&held))
        .await
        .expect("the attempt is abandoned at once");
    assert_eq!(
        fixture.outcome(),
        None,
        "the abandoned attempt wrote nothing"
    );
    assert_eq!(
        fixture.delivery(&entry),
        (Some("pending".to_owned()), Some(0))
    );
    for account in [WEB_ADDRESS_ACCOUNT, SIGNING_SECRET_ACCOUNT] {
        fixture
            .keychain
            .remove(account)
            .await
            .expect("the test removes the item");
    }
    drop(held);

    fixture.until_delivery(&entry, "undelivered", 0).await;
    assert_eq!(fixture.send(&entry), None);
    assert_eq!(fixture.outcome(), None, "a removed address counts nothing");
    assert_eq!(requests(&received), 1);
    fixture.stop().await;
}

/// When the switch reads off against the messages waiting.
#[derive(Clone, Copy, Debug)]
enum SwitchedOff {
    WhileTheyWait,
    BeforeTheGateWrites,
    AcrossARestart,
}

// The switch off drops every pending delivery and waiting message, uncounted: at its off edge,
// for a delivery the gate writes after the edge, and at a start while it reads off; nothing is
// sent after. Mutations: the drop left to the next due try; the drop counted; a delivery written
// after the edge kept; a copy of the switch held in memory.
#[rstest]
#[case::while_they_wait(SwitchedOff::WhileTheyWait)]
#[case::before_the_gate_writes(SwitchedOff::BeforeTheGateWrites)]
#[case::across_a_restart(SwitchedOff::AcrossARestart)]
#[tokio::test]
async fn the_switch_off_drops_every_waiting_message_uncounted(#[case] when: SwitchedOff) {
    let (port, received) =
        serve_answers(vec![Answer::Status(StatusCode::INTERNAL_SERVER_ERROR)]).await;
    let mut fixture = Fixture::new(port).await;
    fixture.start().await;
    let (_, waiting) = fixture.waiting().await;
    fixture.until_delivery(&waiting, "pending", 1).await;

    let mut dropped = vec![waiting];
    match when {
        SwitchedOff::WhileTheyWait => fixture.switch(false),
        SwitchedOff::BeforeTheGateWrites => {
            fixture.switch(false);
            fixture.until_delivery(&dropped[0], "undelivered", 1).await;
            dropped.push(fixture.waiting().await.1);
        }
        SwitchedOff::AcrossARestart => {
            fixture.stop().await;
            fixture.switch(false);
            fixture.start().await;
        }
    }

    fixture
        .until("every pending delivery is dropped", |fixture| {
            dropped.iter().all(|entry| {
                fixture.delivery(entry).0.as_deref() == Some("undelivered")
                    && fixture.send(entry).is_none()
            })
        })
        .await;
    assert_eq!(fixture.outcome(), Some(result_row("refused", Some(500), 0)));
    fixture.switch(true);
    fixture.advance(Duration::from_hours(1));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(requests(&received), 1, "nothing dropped is sent");
    fixture.stop().await;
}

// A retry whose moment a later state replaced, or whose wait was answered, is dropped uncounted,
// and so is a muted session's end; a wait still open and an end are sent. Mutations: a replaced
// or answered moment sent; a final state dropped; a muted end sent; the drop counted.
#[tokio::test]
async fn a_retry_goes_only_while_its_moment_stands() {
    let (port, received) = serve_answers(vec![
        Answer::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Answer::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Answer::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Answer::Status(StatusCode::OK),
    ])
    .await;
    let mut fixture = Fixture::new(port).await;
    fixture.start().await;
    let (replaced_run, replaced) = fixture.waiting().await;
    let (answered_run, answered) = fixture.waiting().await;
    let (_, standing) = fixture.waiting().await;
    for entry in [&replaced, &answered, &standing] {
        fixture.until_delivery(entry, "pending", 1).await;
    }
    fixture.stop().await;
    let end = fixture.finished(replaced_run).await;
    fixture
        .log
        .append(fixture.log.run_state(answered_run, "running", 3, json!({})))
        .await;
    fixture.advance(Duration::from_secs(5));
    fixture.start().await;

    fixture.until_delivery(&replaced, "undelivered", 1).await;
    fixture.until_delivery(&answered, "undelivered", 1).await;
    fixture.until_delivery(&standing, "delivered", 2).await;
    fixture.until_delivery(&end, "delivered", 1).await;
    fixture.stop().await;
    let muted_run = fixture.log.run(None);
    let muted_end = fixture.finished(muted_run).await;
    fixture
        .log
        .database
        .reader()
        .execute(
            "UPDATE sessions SET muted_at = '2026-10-29T09:30:00.000Z' WHERE id = ?1",
            [fixture.log.session_id.text().as_str()],
        )
        .expect("the test mutes the session");
    fixture.start().await;
    fixture.until_delivery(&muted_end, "undelivered", 0).await;
    assert_eq!(requests(&received), 5);
    assert_eq!(fixture.outcome().map(|outcome| outcome.2), Some(0));
    fixture.stop().await;
}
