//! The web address's sender: one task that sends each pending delivery's message, one at a time,
//! oldest due first.
//!
//! - **The pickup.** Each pass picks up the pending deliveries with no message queued, drops
//!   uncounted those and, when it picks any up, the messages waiting whose moment no longer
//!   stands, whose entry is gone or that are a muted session's end, freezes each other one's body
//!   with the machine's name as it reads then, and queues it due at once; past 100 waiting, the
//!   oldest waiting gives up and counts as undelivered.
//! - **The switch.** Every pass reads the settings file first; while `Send to a web address` reads
//!   off, every pending delivery and its message is dropped as undelivered, uncounted. The pass
//!   runs at the start, at every attention change, at every settings change and when the timer
//!   fires, so a delivery the gate wrote as the switch went off is dropped too, and an attempt in
//!   flight is abandoned the moment the switch goes off.
//! - **An attempt.** A message whose moment no longer stands, whose entry is gone, or a muted
//!   session's end, is dropped uncounted, and so is one with no address saved. The switch is read
//!   from the settings file again before each attempt, and once more at each announced change while
//!   it is in flight, a read that fails there leaving the attempt to run. The address and the
//!   signing secret are read under the secrets' lock; a locked or unavailable keychain, or an
//!   address saved with a signing secret missing or damaged, is a `storeUnavailable` try with its
//!   cause. Any 2xx is delivered; any other ending is a failed try, retried 5 s, 5 min and
//!   30 min after it ended, the fourth giving up and counting as undelivered. Every write that
//!   settles a delivery or counts a try raises the counts, and the sender skips the wake its own
//!   write causes.
//! - **The timer.** One job on the wall clock's timer, armed at the earliest waiting message, only
//!   wakes the sender; nothing is armed while nothing waits. A failed pass is passed again a
//!   minute later, whatever instant is armed.
//!
//! A stop or a removal of the address abandons the attempt in flight with nothing written, so its
//! message is due again at once. The person's calls on the address and its secret, and the test
//! message, hold the same lock the attempt takes while it reads them.

pub mod secrets;
mod test_message;

use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::{SignedDuration, Timestamp};
use rusqlite::types::Value;
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::attention::{
    AttentionDeliveryChannel, AttentionDeliveryResult, AttentionDeliveryStoreUnavailableCause,
    AttentionWebAddressState,
};
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::WallClock;
use sidekicks_std::failure_episode::FailureEpisode;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::armed_instant::{ArmedInstant, InstantJob};
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementResult, WriteStatement};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::machine::local::{LocalMachineError, read_local_machine};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use tokio::sync::{MutexGuard, Notify, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::attention::changes::AttentionChanges;
use crate::attention::delivery::outcome::{attempt_outcome_statement, undelivered_count_statement};
use crate::attention::delivery::web_address::message::read_message_body;
use crate::attention::delivery::web_address::post::{
    PostError, PostOutcome, WebAddressPost, WebAddressPoster,
};
use crate::attention::delivery::web_address::queue::{
    DueMessage, MAX_WAITING_MESSAGES, QueuedDelivery, machine_version_statement, queue_statement,
    read_earliest_due, read_next_due, read_pending, read_unqueued, read_waiting, retry_statements,
    settle_statements,
};
use crate::attention::delivery::web_address::{SIGNING_SECRET_ACCOUNT, WEB_ADDRESS_ACCOUNT};
use crate::attention::read::AttentionReadError;

/// The statements the sender prepares on a read connection: the deliveries still to pick up, the
/// messages waiting, the next one due, the earliest due, every pending delivery and the channels'
/// outcome rows its calls read.
pub const WEB_ADDRESS_SENDER_STATEMENT_CAPACITY: usize = 6;

/// The wait after each failed try before the next; one more failure gives up.
pub(crate) const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_mins(5),
    Duration::from_mins(30),
];

/// The timer's job name, as the program's log names it.
const SEND_JOB: &str = "web address send";

/// The timer's retry's job name, as the program's log names it.
const SEND_RETRY_JOB: &str = "web address send retry";

/// What the sender works over.
pub struct WebAddressSenderDependencies {
    /// The writer every settle and try goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The read pool the queue and the moments are read on.
    pub pool: Arc<DatabaseReadPool>,
    /// The attention change counts, whose machine count wakes a pickup.
    pub changes: AttentionChanges,
    /// The machine's settings file, read at each pass.
    pub settings: Arc<dyn MachineSettingsReader>,
    /// The delivery secrets' keychain, holding the address and its signing secret.
    pub keychain: Arc<dyn SecretKeychain>,
    /// The daemon's scheduler, whose wall-clock timer wakes the sender when a retry is due.
    pub scheduler: Arc<Scheduler>,
    /// The wall clock every due time and attempt is read from, the scheduler's own.
    pub clock: Arc<dyn WallClock>,
}

/// Sends each moment's message to the web address the person saved.
pub struct WebAddressSender {
    writer: Arc<DatabaseWriter>,
    pool: Arc<DatabaseReadPool>,
    changes: AttentionChanges,
    settings: Arc<dyn MachineSettingsReader>,
    keychain: Arc<dyn SecretKeychain>,
    clock: Arc<dyn WallClock>,
    poster: WebAddressPoster,
    timer: ArmedInstant,
    // Told by the timer, which only wakes the task.
    wake: Notify,
    // Held by every change of the address or the secret and by an attempt while it reads them.
    secrets: tokio::sync::Mutex<()>,
    // Held across each attempt, taken under the secrets' lock, so a holder of that lock awaits the
    // attempt in flight by taking this one.
    attempt: tokio::sync::Mutex<()>,
    // Cancels the attempt in flight.
    attempt_cancel: Mutex<CancellationToken>,
}

/// Why a pass of the sender failed; it is tried again at the next wake, or a minute later.
#[derive(Debug, thiserror::Error)]
pub enum WebAddressSendError {
    /// The machine's settings file could not be read.
    #[error("the machine's settings were not read")]
    Settings(#[source] Box<dyn Error + Send + Sync>),
    /// The writer did not keep the write.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// SQLite refused a read, or a stored value does not read as its column's.
    #[error("a read of the web address's messages failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A moment's entry did not read.
    #[error(transparent)]
    Entry(#[from] AttentionReadError),
    /// This machine's row did not read.
    #[error(transparent)]
    Machine(#[from] LocalMachineError),
    /// This machine has no row, which the daemon's start writes before any sender runs.
    #[error("this machine has no row to read its name from")]
    MachineUnrecorded,
    /// A waiting message's due time does not read as an instant.
    #[error("a waiting message's due time {due} does not read as an instant")]
    UnreadableDueTime {
        /// The stored due time.
        due: String,
    },
}

/// Why the saved address's secrets did not read: the keychain refused, or the address is held
/// with no signing secret beside it.
#[derive(Debug, thiserror::Error)]
enum SecretsReadError {
    /// The keychain is locked or cannot be used.
    #[error(transparent)]
    Refused(#[from] KeychainRefusal),
    /// The address is saved, and its signing secret is missing from the keychain.
    #[error("the web address is saved with no signing secret beside it")]
    SigningSecretMissing,
}

impl SecretsReadError {
    /// Why the secrets could not be used, as the outcome names it.
    fn cause(&self) -> AttentionDeliveryStoreUnavailableCause {
        match self {
            Self::Refused(refusal) => refusal.cause().into(),
            Self::SigningSecretMissing => AttentionDeliveryStoreUnavailableCause::SecretMissing,
        }
    }
}

/// How a try ended: the post's outcome, and why the secret could not be used on a
/// `storeUnavailable` one.
#[derive(Clone, Copy)]
struct TryEnd {
    outcome: PostOutcome,
    cause: Option<AttentionDeliveryStoreUnavailableCause>,
}

/// How an attempt step ended.
enum Step {
    /// A message was settled or tried; the next one may be due.
    Settled,
    /// No message is due.
    Idle,
    /// The switch reads off, before an attempt or while one was in flight.
    SwitchedOff,
    /// The sender is stopping; nothing more is attempted or armed.
    Stopped,
}

/// What a pickup read: the messages waiting that stand, the deliveries frozen to queue, those given
/// up past the bound and those dropped uncounted.
struct Pickup {
    waiting: Vec<QueuedDelivery>,
    frozen: Vec<(QueuedDelivery, Vec<u8>)>,
    given_up: Vec<QueuedDelivery>,
    dropped: Vec<QueuedDelivery>,
}

/// The machine's change count the task follows, and the version it has accounted for, its own
/// writes included.
struct ChangeFollow {
    count: watch::Receiver<u64>,
    known_version: u64,
}

impl WebAddressSender {
    /// The sender over `dependencies`; nothing runs until [`WebAddressSender::start`].
    pub fn new(dependencies: WebAddressSenderDependencies) -> Self {
        Self {
            timer: ArmedInstant::new(
                Arc::clone(&dependencies.scheduler),
                SEND_JOB,
                SEND_RETRY_JOB,
            ),
            writer: dependencies.writer,
            pool: dependencies.pool,
            changes: dependencies.changes,
            settings: dependencies.settings,
            keychain: dependencies.keychain,
            clock: dependencies.clock,
            poster: WebAddressPoster::default(),
            wake: Notify::new(),
            secrets: tokio::sync::Mutex::new(()),
            attempt: tokio::sync::Mutex::new(()),
            attempt_cancel: Mutex::new(CancellationToken::new()),
        }
    }

    /// Starts the task, which passes at once and then at every attention change, every change
    /// `settings` announces and every firing of its timer, until `stop`.
    pub fn start(
        self: &Arc<Self>,
        settings: watch::Receiver<MachineSettings>,
        stop: CancellationToken,
    ) -> JoinHandle<()> {
        tokio::spawn(Arc::clone(self).run(settings, stop))
    }

    /// Holds the lock every change of the saved address or signing secret takes, which an attempt
    /// takes while it reads them.
    pub(crate) async fn lock_secrets(&self) -> MutexGuard<'_, ()> {
        self.secrets.lock().await
    }

    /// Abandons the attempt in flight, if any, and returns once it ended with nothing written;
    /// `_held` proves the secrets' lock is held, so no attempt starts until it drops.
    pub(crate) async fn abandon_attempt(&self, _held: &MutexGuard<'_, ()>) {
        lock(&self.attempt_cancel).cancel();
        drop(self.attempt.lock().await);
    }

    async fn run(
        self: Arc<Self>,
        mut settings: watch::Receiver<MachineSettings>,
        stop: CancellationToken,
    ) {
        let mut follow = ChangeFollow {
            count: self.changes.follow(None),
            known_version: 0,
        };
        let failure_episode = FailureEpisode::default();
        loop {
            match self.pass(&mut follow, &mut settings, &stop).await {
                Ok(()) => failure_episode.mark_succeeded(),
                Err(error) => {
                    let error = &error as &(dyn Error + 'static);
                    if failure_episode.is_first_failure() {
                        tracing::warn!(error, "the web address's messages were not sent");
                    } else {
                        tracing::debug!(error, "the web address's messages still were not sent");
                    }
                    // A pass that fails as the stop lands leaves no retry to outlive it.
                    if !stop.is_cancelled() {
                        ArmedInstant::schedule_retry_after_failure(&self);
                    }
                }
            }
            tokio::select! {
                () = stop.cancelled() => return,
                changed = follow.count.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                changed = settings.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                () = self.wake.notified() => {}
            }
        }
    }

    // Reads the switch; while it is off drops every pending delivery, disarms the timer and lets
    // the client and its connection go, and while it is on picks up, attempts every message due in
    // turn and arms the timer for the next, unless the sender is stopping.
    async fn pass(
        self: &Arc<Self>,
        follow: &mut ChangeFollow,
        settings: &mut watch::Receiver<MachineSettings>,
        stop: &CancellationToken,
    ) -> Result<(), WebAddressSendError> {
        follow.known_version = *follow.count.borrow_and_update();
        loop {
            if !self.is_switched_on().await? {
                self.drop_pending(follow).await?;
                ArmedInstant::arm(self, None);
                self.poster.release();
                return Ok(());
            }
            self.pick_up(follow).await?;
            loop {
                match self.attempt_next(follow, settings, stop).await? {
                    Step::Settled => {}
                    Step::Idle if stop.is_cancelled() => return Ok(()),
                    Step::Idle => return self.arm_next().await,
                    Step::SwitchedOff => break,
                    Step::Stopped => return Ok(()),
                }
            }
        }
    }

    async fn is_switched_on(&self) -> Result<bool, WebAddressSendError> {
        Ok(self
            .settings
            .read_machine_settings()
            .await
            .map_err(WebAddressSendError::Settings)?
            .notifications
            .web_address
            .enabled)
    }

    // Drops every pending delivery and its message as undelivered, uncounted.
    async fn drop_pending(&self, follow: &mut ChangeFollow) -> Result<(), WebAddressSendError> {
        let pending = self
            .pool
            .read(ReadLength::Short, |connection| {
                Ok::<_, WebAddressSendError>(read_pending(connection)?)
            })
            .await?;
        let statements = pending.iter().flat_map(drop_statements).collect::<Vec<_>>();
        self.write_own(statements, follow).await
    }

    // Queues each pending delivery no message waits for, its body frozen with the machine's name
    // as it reads now, due at once; past the bound the oldest waiting give up, counted. One whose
    // moment no longer stands, whose entry is gone or that is a muted session's end is dropped
    // uncounted first, and, when it picks any up, so is such a waiting one, so only a message that
    // stands counts toward the bound, and one given up is never frozen.
    async fn pick_up(&self, follow: &mut ChangeFollow) -> Result<(), WebAddressSendError> {
        let unqueued = self
            .pool
            .read(ReadLength::Short, |connection| {
                Ok::<_, WebAddressSendError>(read_unqueued(connection)?)
            })
            .await?;
        if unqueued.is_empty() {
            return Ok(());
        }
        let machine = read_local_machine(&self.pool)
            .await?
            .ok_or(WebAddressSendError::MachineUnrecorded)?
            .name;
        let pickup = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let mut pickup = Pickup {
                    waiting: Vec::new(),
                    frozen: Vec::new(),
                    given_up: Vec::new(),
                    dropped: Vec::new(),
                };
                for waiting in read_waiting(connection)? {
                    if waiting.is_standing && !waiting.is_muted_end {
                        pickup.waiting.push(waiting.delivery);
                    } else {
                        pickup.dropped.push(waiting.delivery);
                    }
                }
                // Newest first, so the newest that stand fill the bound and any older one past it
                // gives up unfrozen.
                for unqueued in unqueued.into_iter().rev() {
                    let delivery = unqueued.delivery;
                    if !unqueued.is_standing || unqueued.is_muted_end {
                        pickup.dropped.push(delivery);
                        continue;
                    }
                    if pickup.frozen.len() == MAX_WAITING_MESSAGES {
                        pickup.given_up.push(delivery);
                        continue;
                    }
                    match read_message_body(connection, &delivery.entry_id, &machine)? {
                        Some(body) => pickup.frozen.push((delivery, body)),
                        // Its entry went since the pickup read it, so there is nothing to send.
                        None => pickup.dropped.push(delivery),
                    }
                }
                Ok::<_, WebAddressSendError>(pickup)
            })
            .await?;
        let due_at = self.now().1;
        let waiting_given_up =
            (pickup.waiting.len() + pickup.frozen.len()).saturating_sub(MAX_WAITING_MESSAGES);
        let mut statements = Vec::new();
        for delivery in pickup
            .waiting
            .iter()
            .take(waiting_given_up)
            .chain(&pickup.given_up)
        {
            statements.extend(give_up_statements(delivery));
        }
        statements.extend(pickup.dropped.iter().flat_map(drop_statements));
        for (delivery, body) in pickup.frozen.into_iter().rev() {
            statements.push(queue_statement(&delivery, body, &due_at));
        }
        self.write_own(statements, follow).await
    }

    // Attempts the message due first, if any.
    async fn attempt_next(
        &self,
        follow: &mut ChangeFollow,
        settings: &mut watch::Receiver<MachineSettings>,
        stop: &CancellationToken,
    ) -> Result<Step, WebAddressSendError> {
        let now = self.now().1;
        let Some(due) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WebAddressSendError>(read_next_due(connection, &now)?)
            })
            .await?
        else {
            return Ok(Step::Idle);
        };
        if !due.is_standing || due.is_muted_end {
            self.write_own(drop_statements(&due.delivery), follow)
                .await?;
            return Ok(Step::Settled);
        }
        if !self.is_switched_on().await? {
            return Ok(Step::SwitchedOff);
        }
        let held = self.secrets.lock().await;
        let secrets = self.read_secrets().await;
        let _attempt = self.attempt.lock().await;
        let cancel = stop.child_token();
        *lock(&self.attempt_cancel) = cancel.clone();
        drop(held);
        let (attempted_instant, end) = match secrets {
            Ok(Some((address, signing_secret))) => {
                let (attempted_at, attempted_instant) = self.now();
                let post = self.poster.post(WebAddressPost {
                    address: &address,
                    signing_secret: &signing_secret,
                    message_id: &due.delivery.entry_id,
                    body: &due.body,
                    attempted_at,
                });
                let posted = tokio::select! {
                    posted = post => posted,
                    // Abandoned with nothing written; at a stop no other attempt follows.
                    () = cancel.cancelled() => {
                        return Ok(if stop.is_cancelled() { Step::Stopped } else { Step::Settled });
                    }
                    () = self.switched_off(settings) => return Ok(Step::SwitchedOff),
                };
                (attempted_instant, end_of_post(posted))
            }
            Ok(None) => {
                self.write_own(drop_statements(&due.delivery), follow)
                    .await?;
                return Ok(Step::Settled);
            }
            Err(unread) => (self.now().1, end_of_unread_secrets(&unread)),
        };
        // The retry waits its delay from the moment the try ended, not from when it began.
        let ended_at = self.now().1;
        self.write_own(
            tried_statements(&due, &attempted_instant, &ended_at, end),
            follow,
        )
        .await?;
        Ok(Step::Settled)
    }

    // Returns once the settings file reads the switch off after an announced change, and never
    // once the announcements end. A read that fails is no change, so the attempt in flight runs.
    async fn switched_off(&self, settings: &mut watch::Receiver<MachineSettings>) {
        loop {
            if settings.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
            match self.is_switched_on().await {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the machine's settings did not read during an attempt, so it runs on"
                ),
            }
        }
    }

    // The saved address and its signing secret, `None` with no address saved or the address not
    // reading as one; an address held with no signing secret reads as `SigningSecretMissing`.
    async fn read_secrets(&self) -> Result<Option<(WebAddress, SecretString)>, SecretsReadError> {
        let Some(address) = self.keychain.read(WEB_ADDRESS_ACCOUNT).await? else {
            return Ok(None);
        };
        let Some(signing_secret) = self.keychain.read(SIGNING_SECRET_ACCOUNT).await? else {
            return Err(SecretsReadError::SigningSecretMissing);
        };
        let address = WebAddress::new(address.expose_secret());
        if address.is_none() {
            // A value no save would keep; nothing of it is logged, since it may hold a token.
            tracing::warn!(
                "the saved web address does not read as an address, so nothing was sent"
            );
        }
        Ok(address.map(|address| (address, signing_secret)))
    }

    // Arms the timer for the earliest waiting message, or disarms it while none waits.
    async fn arm_next(self: &Arc<Self>) -> Result<(), WebAddressSendError> {
        let earliest = self
            .pool
            .read(ReadLength::Short, |connection| {
                Ok::<_, WebAddressSendError>(read_earliest_due(connection)?)
            })
            .await?;
        let next = match earliest {
            None => None,
            Some(due) => Some(
                WireInstant::try_from(due.clone())
                    .ok()
                    .and_then(|instant| instant.timestamp())
                    .map(SystemTime::from)
                    .ok_or(WebAddressSendError::UnreadableDueTime { due })?,
            ),
        };
        ArmedInstant::arm(self, next);
        Ok(())
    }

    // Writes `statements`, then accounts for the version its own write moved the machine's count
    // to, marking that raise seen unless another write moved the count too.
    async fn write_own(
        &self,
        statements: Vec<WriteStatement>,
        follow: &mut ChangeFollow,
    ) -> Result<(), WebAddressSendError> {
        if statements.is_empty() {
            return Ok(());
        }
        let mut write = vec![machine_version_statement()];
        write.extend(statements);
        write.push(machine_version_statement());
        let results = self.writer.write(write).await?;
        let version_of = |result: Option<&StatementResult>| {
            match result.and_then(|result| result.rows.first()?.first()) {
                Some(Value::Integer(version)) => {
                    u64::try_from(*version).expect("the table keeps every version at 1 or more")
                }
                // No row before the machine's first raise.
                Some(_) | None => 0,
            }
        };
        let before = version_of(results.first());
        let after = version_of(results.last());
        if before == follow.known_version {
            follow.known_version = after;
            if *follow.count.borrow() == after {
                follow.count.borrow_and_update();
            }
        }
        Ok(())
    }

    // The wall clock's instant now, as a timestamp and in the stored form.
    fn now(&self) -> (Timestamp, WireInstant) {
        let timestamp = Timestamp::try_from(self.clock.now())
            .expect("the wall clock reads within a timestamp's range");
        let instant =
            WireInstant::from_timestamp(timestamp).expect("the clock reads after year 0000");
        (timestamp, instant)
    }
}

impl InstantJob for WebAddressSender {
    fn armed_instant(&self) -> &ArmedInstant {
        &self.timer
    }

    fn fire(
        self: Arc<Self>,
        _instant: SystemTime,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
        self.wake.notify_one();
        async { Ok(()) }.boxed()
    }

    fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()> {
        self.wake.notify_one();
        async {}.boxed()
    }
}

// How a try whose secrets did not read ended: `storeUnavailable` with the cause, nothing posted.
fn end_of_unread_secrets(unread: &SecretsReadError) -> TryEnd {
    tracing::info!(
        error = unread as &(dyn Error + 'static),
        "the web address's secrets did not read, so nothing was sent"
    );
    TryEnd {
        outcome: PostOutcome {
            result: AttentionDeliveryResult::StoreUnavailable,
            http_status: None,
        },
        cause: Some(unread.cause()),
    }
}

// How a post ended. An attempt that could not be made: a signing secret that does not read is a
// damaged one, and a client that does not build reaches nothing.
fn end_of_post(posted: Result<PostOutcome, PostError>) -> TryEnd {
    match posted {
        Ok(outcome) => TryEnd {
            outcome,
            cause: None,
        },
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "no attempt was made to send to the web address"
            );
            let (result, cause) = match error {
                PostError::SigningSecret(_) => (
                    AttentionDeliveryResult::StoreUnavailable,
                    Some(AttentionDeliveryStoreUnavailableCause::SecretDamaged),
                ),
                PostError::Client(_) => (AttentionDeliveryResult::Unreachable, None),
            };
            TryEnd {
                outcome: PostOutcome {
                    result,
                    http_status: None,
                },
                cause,
            }
        }
    }
}

// The writes after `due`'s try made at `attempted_at` ended at `ended_at` as `end`: a delivery
// settles it, any other ending retries it its delay after `ended_at`, the last one giving up,
// counted.
fn tried_statements(
    due: &DueMessage,
    attempted_at: &WireInstant,
    ended_at: &WireInstant,
    end: TryEnd,
) -> Vec<WriteStatement> {
    let outcome = end.outcome;
    let mut statements = vec![attempt_outcome_statement(
        AttentionDeliveryChannel::WebAddress,
        attempted_at,
        outcome.result,
        end.cause,
        outcome.http_status,
    )];
    let failed_tries =
        usize::try_from(due.attempt_count).expect("an attempt count is never negative");
    match (outcome.result, RETRY_DELAYS.get(failed_tries)) {
        (AttentionDeliveryResult::Delivered, _) => statements.extend(settle_statements(
            &due.delivery,
            AttentionWebAddressState::Delivered,
            true,
        )),
        (_, Some(delay)) => {
            let due_at = ended_at
                .timestamp()
                .and_then(|ended| {
                    ended
                        .checked_add(SignedDuration::try_from(*delay).ok()?)
                        .ok()
                })
                .and_then(WireInstant::from_timestamp)
                .expect("a retry falls within a timestamp's range");
            statements.extend(retry_statements(&due.delivery, &due_at));
        }
        (_, None) => {
            statements.extend(settle_statements(
                &due.delivery,
                AttentionWebAddressState::Undelivered,
                true,
            ));
            statements.push(undelivered_count_statement(
                AttentionDeliveryChannel::WebAddress,
            ));
        }
    }
    statements
}

// A message given up on before its tries ran out, counted.
fn give_up_statements(delivery: &QueuedDelivery) -> Vec<WriteStatement> {
    let mut statements = settle_statements(delivery, AttentionWebAddressState::Undelivered, false);
    statements.push(undelivered_count_statement(
        AttentionDeliveryChannel::WebAddress,
    ));
    statements
}

// A message dropped uncounted: its moment no longer stands, its session was muted or no address
// is saved.
fn drop_statements(delivery: &QueuedDelivery) -> Vec<WriteStatement> {
    settle_statements(delivery, AttentionWebAddressState::Undelivered, false)
}

#[cfg(test)]
mod tests;
