//! The window start: a provider counts each usage window from the first message after its reset,
//! so while nobody works the window's clock stands still. At an account's reset the daemon spends
//! one smallest turn there, in a throwaway process outside every session, so the new window runs
//! from then.
//!
//! - Every stored window counts, of every length: one is closed when its reset has passed or none
//!   is stored, and one whose reset lies ahead is running.
//! - A closed window is started when the account's last window-start turn came at or after its
//!   reset, or, with no reset stored, within the five hours before now, as far ahead as a window
//!   that turn started can reset. One turn starts every closed window of the account, and its
//!   time is written on the account's row in the write of its usage row, so a restart or a second
//!   trigger spends no second turn on one reset.
//! - It is looked at on the timer armed for the account's earliest reset ahead, re-armed at each
//!   look, at the observer's start, at an account's registration, at each wake of the machine and
//!   after each limits read.
//! - It runs only under the observer's opt-out and the account's own switch, and never while a
//!   turn is live on the account, a turn that starts the window itself, nor on a login gone. A
//!   pasted token whose limits are read by a turn takes none, since each of those reads is the
//!   turn.
//! - With the account's wake switch on, the machine's wake helper books a wake for the timer's
//!   reset, so a machine asleep then wakes a minute before it; the booking follows the timer and
//!   is canceled once the switch or the window start is off or the account is removed. A time
//!   two accounts share stays booked while either holds it.
//! - The windows are read before the home is taken, so a look that finds none closed never holds
//!   it; the turn runs under the account's home lock, the windows read again there, joined by any
//!   look while it runs, and one at a time on a provider whose processes run one at a time.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use futures::FutureExt as _;
use rusqlite::OptionalExtension as _;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{WakeRefusal, WakeReply};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduleError, ScheduledJobHandle, Scheduler};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::optional_text_column;
use tokio::sync::broadcast::error::RecvError;

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::observer::{
    ObserverShared, ProviderAccountObserverError, READ_BOUND, ladder, log_read_failure,
};
use crate::account::registry::{RegisteredAccount, refusal_or_failure};
use crate::account::usage_turns::unpriced::UnpricedUsageKey;
use crate::account::usage_turns::{mint_sessionless_turn_id, sessionless_usage_turn_statement};
use crate::account::wake_helper::MachineWakeHelper;
use crate::driver::contract::account::{ProviderWindowTurnLegs, WindowTurnAnswer, WindowTurnSpend};
use crate::driver::ports::HeldRequest;

// How long after a window-start turn a window with no stored reset still counts as started: the
// longest a window that turn started runs before it resets.
const STARTED_WITHIN: jiff::SignedDuration = jiff::SignedDuration::from_hours(5);

const WINDOW_START_JOB: &str = "provider account window start";

const SELECT_WINDOW_RESETS_SQL: &str =
    "SELECT resets_at FROM provider_account_usage_windows WHERE account_id = ?";

const SELECT_WINDOW_START_SENT_SQL: &str = "
  SELECT window_start_sent_at
    FROM provider_accounts
   WHERE account_id = ? AND removal_intent = 0";

static RECORD_WINDOW_START_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET window_start_sent_at = @sent_at, updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

/// What a due timer calls with its account; it starts the look and returns at once.
pub(super) type WindowStartDue = Arc<dyn Fn(ProviderAccountId) + Send + Sync>;

/// Each account's one timer, armed for its earliest window reset ahead.
pub(super) struct WindowStartTimers {
    scheduler: Arc<Scheduler>,
    on_due: WindowStartDue,
    timers: Mutex<HashMap<ProviderAccountId, ScheduledJobHandle>>,
}

impl WindowStartTimers {
    /// Timers on `scheduler`'s wall-clock timer that call `on_due`.
    pub(super) fn new(scheduler: Arc<Scheduler>, on_due: WindowStartDue) -> Self {
        Self {
            scheduler,
            on_due,
            timers: Mutex::default(),
        }
    }

    /// Arms `account_id`'s timer for `reset` in place of the one it had, or disarms it with
    /// `None`. Refused once the scheduler has stopped.
    fn arm(
        &self,
        account_id: &ProviderAccountId,
        reset: Option<SystemTime>,
    ) -> Result<(), ScheduleError> {
        let replaced = match reset {
            Some(reset) => {
                let on_due = Arc::clone(&self.on_due);
                let due_account = account_id.clone();
                let timer = self.scheduler.schedule_at(
                    WINDOW_START_JOB,
                    JobCondition::Always,
                    reset,
                    move |_| {
                        on_due(due_account.clone());
                        async { Ok(()) }.boxed()
                    },
                )?;
                lock(&self.timers).insert(account_id.clone(), timer)
            }
            None => lock(&self.timers).remove(account_id),
        };
        if let Some(replaced) = replaced {
            replaced.cancel();
        }
        Ok(())
    }

    /// Disarms `account_id`'s timer.
    pub(super) fn forget(&self, account_id: &ProviderAccountId) {
        if let Some(timer) = lock(&self.timers).remove(account_id) {
            timer.cancel();
        }
    }

    /// Disarms every timer.
    pub(super) fn forget_all(&self) {
        for (_, timer) in lock(&self.timers).drain() {
            timer.cancel();
        }
    }
}

/// The wake booked on the machine's wake helper for each account's timer, while its wake switch
/// is on.
pub(super) struct WindowStartWakes {
    helper: Option<Arc<dyn MachineWakeHelper>>,
    booked: tokio::sync::Mutex<HashMap<ProviderAccountId, SystemTime>>,
}

impl WindowStartWakes {
    /// Wakes booked on `helper`; none where the system has no helper.
    pub(super) fn new(helper: Option<Arc<dyn MachineWakeHelper>>) -> Self {
        Self {
            helper,
            booked: tokio::sync::Mutex::default(),
        }
    }

    /// Books `account_id`'s wake for `reset` in place of the one booked before, or cancels it
    /// with `None`; a time another account still holds is not canceled. A booking the helper
    /// refuses or cannot take is logged and left unbooked, so the next look books it again.
    async fn book(&self, account_id: &ProviderAccountId, reset: Option<SystemTime>) {
        let Some(helper) = &self.helper else {
            return;
        };
        let mut booked = self.booked.lock().await;
        let before = booked.get(account_id).copied();
        if before == reset {
            return;
        }
        booked.remove(account_id);
        if let Some(reset) = reset {
            match helper.book(reset).await {
                Ok(WakeReply::Booked) => {
                    booked.insert(account_id.clone(), reset);
                }
                Ok(reply) => {
                    tracing::warn!(reply = %reply, "the wake helper did not book a window's wake");
                }
                Err(error) => tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a window's wake could not be booked"
                ),
            }
        }
        if let Some(before) = before
            && !booked.values().any(|held| *held == before)
        {
            match helper.cancel(before).await {
                Ok(WakeReply::Canceled | WakeReply::Refused(WakeRefusal::NotBooked)) => {}
                Ok(reply) => {
                    tracing::warn!(
                        reply = %reply,
                        "the wake helper did not cancel a window's wake"
                    );
                }
                Err(error) => tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a window's wake could not be canceled"
                ),
            }
        }
    }
}

// An account's stored windows' resets, `None` where none is stored, and its last window-start
// turn.
struct AccountWindows {
    resets: Vec<Option<jiff::Timestamp>>,
    last_sent: Option<jiff::Timestamp>,
}

impl AccountWindows {
    async fn read(
        reads: &DatabaseReadPool,
        account_id: ProviderAccountId,
    ) -> Result<Self, ProviderAccountRegistryError> {
        reads
            .read(ReadLength::Short, move |connection| {
                let last_sent = connection
                    .prepare_cached(SELECT_WINDOW_START_SENT_SQL)?
                    .query_row([account_id.as_str()], |row| {
                        optional_text_column(row, 0, WireInstant::try_from)
                    })
                    .optional()?
                    .ok_or(ProviderAccountRegistryError::NotFound)?;
                let resets = connection
                    .prepare_cached(SELECT_WINDOW_RESETS_SQL)?
                    .query_map([account_id.as_str()], |row| {
                        optional_text_column(row, 0, WireInstant::try_from)
                    })?
                    .map(|reset| Ok(reset?.and_then(|reset| reset.timestamp())))
                    .collect::<Result<_, rusqlite::Error>>()?;
                Ok(Self {
                    resets,
                    last_sent: last_sent.and_then(|sent| sent.timestamp()),
                })
            })
            .await
    }

    // Whether a window is closed at `now` and no window-start turn started it.
    fn has_unstarted_closed_window(&self, now: jiff::Timestamp) -> bool {
        self.resets
            .iter()
            .any(|reset| match (*reset, self.last_sent) {
                (Some(reset), _) if reset > now => false,
                (Some(reset), Some(sent)) => sent < reset,
                (None, Some(sent)) => now.duration_since(sent) >= STARTED_WITHIN,
                (_, None) => true,
            })
    }

    // The earliest reset ahead of `now`.
    fn next_reset(&self, now: jiff::Timestamp) -> Option<SystemTime> {
        self.resets
            .iter()
            .flatten()
            .filter(|reset| **reset > now)
            .min()
            .map(|reset| SystemTime::from(*reset))
    }
}

impl ObserverShared {
    /// Looks at `provider_account_id`'s windows in a task no caller waits on, its failure written
    /// to the service log.
    pub(super) fn spawn_window_start(self: Arc<Self>, provider_account_id: ProviderAccountId) {
        tokio::spawn(async move {
            if let Err(error) = self.start_windows(provider_account_id).await {
                log_read_failure(&error);
            }
        });
    }

    /// Cancels the wake booked for `provider_account_id`, removed, in a task no caller waits on.
    pub(super) fn spawn_wake_cancel(self: Arc<Self>, provider_account_id: ProviderAccountId) {
        tokio::spawn(async move {
            self.window_wakes.book(&provider_account_id, None).await;
        });
    }

    /// Looks at every registered account's windows, one after another, in a task of its own.
    pub(super) fn spawn_every_window_start(self: Arc<Self>) {
        tokio::spawn(async move {
            let accounts = match self.registry.list(None).await {
                Ok(accounts) => accounts,
                Err(error) => {
                    log_read_failure(&ProviderAccountObserverError::Registry(error));
                    return;
                }
            };
            for account in accounts {
                if let Err(error) = self.start_windows(account.account_id).await {
                    log_read_failure(&error);
                }
            }
        });
    }

    /// Looks at every account's windows at each wake of the machine, until the scheduler stops
    /// telling wakes or the observer is dropped.
    pub(super) fn spawn_wake_watch(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let mut wakes = self.scheduler.on_wake();
        let this = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                match wakes.recv().await {
                    Ok(_) | Err(RecvError::Lagged(_)) => match this.upgrade() {
                        Some(shared) => shared.spawn_every_window_start(),
                        None => return,
                    },
                    Err(RecvError::Closed) => return,
                }
            }
        })
    }

    /// Looks at `provider_account_id`'s windows and spends one turn where one is closed and not
    /// started, as the module doc says. Fails when the account or its windows cannot be read, its
    /// timer cannot be armed or its turn's usage cannot be written.
    pub(super) async fn start_windows(
        self: &Arc<Self>,
        provider_account_id: ProviderAccountId,
    ) -> Result<(), ProviderAccountObserverError> {
        let account = self.registry.read(provider_account_id.clone()).await?;
        let is_off = !account.probe_enabled
            || !account.window_start_enabled
            || self.token_limits_legs_of(&account).is_some()
            || account
                .health
                .as_ref()
                .is_some_and(|health| health.state == ProviderAccountHealthState::ReauthRequired);
        if is_off {
            self.window_timers.forget(&provider_account_id);
            self.window_wakes.book(&provider_account_id, None).await;
            return Ok(());
        }
        let Some(legs) = self.window_turn_legs.get(&account.provider).cloned() else {
            return Ok(());
        };
        let now = ladder::timestamp(self.wall_clock.now());
        let windows =
            AccountWindows::read(&self.database_reads, provider_account_id.clone()).await?;
        let next_reset = windows.next_reset(now);
        self.window_timers.arm(&provider_account_id, next_reset)?;
        let wake = next_reset.filter(|_| account.wake_for_window_start_enabled);
        self.window_wakes.book(&provider_account_id, wake).await;
        if !windows.has_unstarted_closed_window(now)
            || !self
                .live_turns
                .sessions_with_live_turns(&provider_account_id)
                .is_empty()
        {
            return Ok(());
        }
        let shared = Arc::clone(self);
        let answer = self
            .window_starts
            .run_if_free(provider_account_id, move || {
                async move {
                    shared
                        .send_window_turn(account, legs)
                        .await
                        .map_err(Arc::new)
                }
                .boxed()
            })
            .await?;
        match answer {
            None | Some(Ok(())) => Ok(()),
            Some(Err(error)) => Err(ProviderAccountObserverError::WindowStartFailed(error)),
        }
    }

    // Under the home's hold: the windows read again, since a turn that ended since the look may
    // have started them, and one turn spent where a closed window is still not started.
    async fn send_window_turn(
        &self,
        account: RegisteredAccount,
        legs: Arc<dyn ProviderWindowTurnLegs>,
    ) -> Result<(), ProviderAccountObserverError> {
        let now = ladder::timestamp(self.wall_clock.now());
        let windows =
            AccountWindows::read(&self.database_reads, account.account_id.clone()).await?;
        if !windows.has_unstarted_closed_window(now) {
            return Ok(());
        }
        let one_at_a_time = self.one_reader_at_a_time.get(&account.provider).cloned();
        let _reader_turn = match &one_at_a_time {
            Some(one_at_a_time) => Some(one_at_a_time.lock().await),
            None => None,
        };
        let folders = self
            .account_reader
            .resolve_account_folders(account.account_id.clone())
            .await
            .map_err(ProviderAccountObserverError::Folders)?;
        match tokio::time::timeout(
            READ_BOUND,
            legs.start_window(account.account_id.clone(), folders),
        )
        .await
        {
            Ok(Ok(WindowTurnAnswer::Spent(spends))) => {
                self.record_window_turn(&account, &spends).await?;
            }
            Ok(Ok(WindowTurnAnswer::Refused)) => {
                tracing::warn!("the provider refused an account's window-start turn");
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an account's window-start turn failed"
                );
            }
            Err(_elapsed) => tracing::warn!("an account's window-start turn took too long"),
        }
        Ok(())
    }

    /// Writes a turn that starts `account`'s closed windows: a usage row for each of its requests'
    /// `spends`, held and with no session, and its time on the account's row, in one write, then
    /// hands each row's request to the repricing. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered, keeping nothing;
    /// a hand-off that fails leaves its held row to the next start.
    pub(super) async fn record_window_turn(
        &self,
        account: &RegisteredAccount,
        spends: &[WindowTurnSpend],
    ) -> Result<(), ProviderAccountObserverError> {
        let provider_account_id = &account.account_id;
        let sent_at = ladder::wire_instant(self.wall_clock.now());
        let mut statements: Vec<WriteStatement> = spends
            .iter()
            .map(|spend| {
                sessionless_usage_turn_statement(
                    &mint_sessionless_turn_id(),
                    provider_account_id,
                    &sent_at,
                    &self.daemon_started_at,
                    spend,
                )
            })
            .collect();
        statements.push(WriteStatement {
            sql: std::borrow::Cow::Borrowed(RECORD_WINDOW_START_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", provider_account_id.as_str()),
                text_binding("@sent_at", sent_at.as_str()),
            ]),
            expected_row_count: Some(1),
        });
        self.database_writer
            .write(statements)
            .await
            .map_err(refusal_or_failure)?;
        let Some(repricing) = self.request_held.port() else {
            return Ok(());
        };
        for spend in spends {
            let held = HeldRequest {
                key: UnpricedUsageKey {
                    provider: account.provider.clone(),
                    account_id: provider_account_id.clone(),
                    model_id: spend.model_id.clone(),
                    speed: spend.speed.clone(),
                    processing_region: None,
                },
                // Written held, so the hand-off has no row to mark.
                row_ids: Vec::new(),
            };
            if let Err(error) = repricing.request_held(held).await {
                tracing::warn!(
                    error = &*error as &(dyn std::error::Error + 'static),
                    "a window-start turn's request was not handed over for pricing; it waits for \
                     the next start"
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use rstest::rstest;
    use rusqlite::types::Value;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_platforms::WallClock as _;
    use sidekicks_store::database::statement::{
        StatementBindings, WriteStatement, nullable_text_binding, text_binding,
    };
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use super::WINDOW_START_JOB;
    use crate::account::observer::ladder::wire_instant;
    use crate::account::observer::test_fixture::{
        Fixture, ScriptedLegs, TestClock, claude, codex, new_clock, usage_rows,
    };
    use crate::account::registry::{AccountSettingsChange, RegisteredAccount};
    use crate::account::wake_helper::WakeHelperCall;
    use crate::driver::schema::schema_parts;

    const FIVE_HOURS: i64 = 300;
    const WEEK: i64 = 10_080;

    // Where a stored window's reset lies against the clock.
    #[derive(Clone, Copy, Debug)]
    enum Reset {
        Passed,
        Absent,
        Ahead(Duration),
    }

    async fn open(database: &TestDatabase, data_folder: &Path, clock: Arc<TestClock>) -> Fixture {
        Fixture::open(database, data_folder, clock, ScriptedLegs::default()).await
    }

    // Stores `account`'s `window_mins` window, its reset at `reset` or none, read now.
    async fn store_window(
        fixture: &Fixture,
        account: &RegisteredAccount,
        window_mins: i64,
        reset: Option<SystemTime>,
    ) {
        fixture
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(
                    "INSERT INTO provider_account_usage_windows
                       (account_id, limit_id, window_mins, used_percent, resets_at, observed_at,
                        observed_credential_generation, source)
                     VALUES (@account_id, 'default', @window_mins, 0, @resets_at, @observed_at, 1,
                             'probe')
                     ON CONFLICT (account_id, limit_id, window_mins)
                     DO UPDATE SET resets_at = excluded.resets_at,
                                   observed_at = excluded.observed_at",
                ),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account.account_id.as_str()),
                    (Cow::Borrowed("@window_mins"), Value::Integer(window_mins)),
                    nullable_text_binding(
                        "@resets_at",
                        reset.map(wire_instant).as_ref().map(WireInstant::as_str),
                    ),
                    text_binding("@observed_at", wire_instant(fixture.clock.now()).as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await
            .expect("the window is stored");
    }

    async fn look(fixture: &Fixture, account: &RegisteredAccount) {
        fixture
            .observer
            .shared
            .start_windows(account.account_id.clone())
            .await
            .expect("the windows are looked at");
    }

    fn window_starts(fixture: &Fixture, provider: &ProviderId) -> usize {
        fixture.turns[provider].window_starts()
    }

    // Every closed window, of either length on either provider, takes one turn, written as one
    // usage row with no session, handed to the repricing, and a second look spends none; a running
    // window takes none and arms the timer for its reset. Killed by a running window read as closed
    // (a turn on the running cases), by a weekly window skipped (none on the weekly cases), by a
    // turn sent again for one reset (two), and by a row never handed over.
    #[rstest]
    #[case::a_passed_five_hour_reset_on_claude_code(claude(), FIVE_HOURS, Reset::Passed, 1)]
    #[case::a_passed_weekly_reset_on_claude_code(claude(), WEEK, Reset::Passed, 1)]
    #[case::no_stored_reset_on_codex(codex(), FIVE_HOURS, Reset::Absent, 1)]
    #[case::a_passed_weekly_reset_on_codex(codex(), WEEK, Reset::Passed, 1)]
    #[case::a_reset_within_five_hours_reads_as_started(
        codex(),
        FIVE_HOURS,
        Reset::Ahead(Duration::from_mins(299)),
        0
    )]
    #[case::a_running_weekly_window_is_not_closed(
        claude(),
        WEEK,
        Reset::Ahead(Duration::from_hours(80)),
        0
    )]
    #[tokio::test(start_paused = true)]
    async fn each_closed_window_takes_one_turn_on_each_provider(
        #[case] provider: ProviderId,
        #[case] window_mins: i64,
        #[case] reset: Reset,
        #[case] turns: usize,
    ) {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let fixture = open(&database, data_folder.path(), new_clock()).await;
        let account = fixture.register_on(provider.clone(), None).await;
        let now = fixture.clock.now();
        let reset_at = match reset {
            Reset::Passed => Some(now - Duration::from_mins(1)),
            Reset::Absent => None,
            Reset::Ahead(by) => Some(now + by),
        };
        store_window(&fixture, &account, window_mins, reset_at).await;

        look(&fixture, &account).await;
        look(&fixture, &account).await;

        assert_eq!(window_starts(&fixture, &provider), turns);
        let other = if provider == claude() {
            codex()
        } else {
            claude()
        };
        assert_eq!(window_starts(&fixture, &other), 0);
        assert_eq!(
            usage_rows(&database, &account),
            vec![(None::<String>, 1_i64); turns]
        );
        assert_eq!(
            fixture.held_requests.handed_over(),
            vec![(provider.clone(), account.account_id.clone()); turns]
        );
        assert_eq!(
            fixture
                .scheduler
                .waiting_job_names()
                .contains(&WINDOW_START_JOB),
            matches!(reset, Reset::Ahead(_))
        );
    }

    // A restarted observer spends no second turn on the reset the first one started, and spends
    // one again once the window that turn started has reset in turn. Killed by the turn's time
    // kept in memory (a second turn after the restart) and by a stored time blocking every later
    // reset (no turn after the next one).
    #[tokio::test(start_paused = true)]
    async fn a_restart_after_the_fire_fires_nothing_until_the_next_reset() {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let clock = new_clock();
        let before = open(&database, data_folder.path(), Arc::clone(&clock)).await;
        let account = before.register().await;
        store_window(
            &before,
            &account,
            FIVE_HOURS,
            Some(clock.now() - Duration::from_mins(1)),
        )
        .await;
        look(&before, &account).await;
        assert_eq!(window_starts(&before, &claude()), 1);
        drop(before);

        let after = open(&database, data_folder.path(), Arc::clone(&clock)).await;
        look(&after, &account).await;
        assert_eq!(window_starts(&after, &claude()), 0);

        store_window(
            &after,
            &account,
            FIVE_HOURS,
            Some(clock.now() + Duration::from_hours(5)),
        )
        .await;
        clock.advance(Duration::from_hours(6));
        look(&after, &account).await;
        assert_eq!(window_starts(&after, &claude()), 1);
        assert_eq!(usage_rows(&database, &account).len(), 2);
    }

    // Either switch off spends nothing on a closed window: the account's own, and the observer's
    // opt-out it sits under. Killed by either switch not read.
    #[rstest]
    #[case::the_window_start_switched_off(AccountSettingsChange {
        window_start_enabled: Some(false),
        ..AccountSettingsChange::default()
    })]
    #[case::the_observer_opted_out(AccountSettingsChange {
        probe_enabled: Some(false),
        ..AccountSettingsChange::default()
    })]
    #[tokio::test(start_paused = true)]
    async fn a_switch_off_fires_nothing(#[case] change: AccountSettingsChange) {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let fixture = open(&database, data_folder.path(), new_clock()).await;
        let account = fixture.register().await;
        fixture
            .registry
            .change_settings(account.account_id.clone(), change)
            .await
            .expect("the switch changes");
        store_window(
            &fixture,
            &account,
            WEEK,
            Some(fixture.clock.now() - Duration::from_mins(1)),
        )
        .await;

        look(&fixture, &account).await;

        assert_eq!(window_starts(&fixture, &claude()), 0);
        assert_eq!(
            usage_rows(&database, &account),
            Vec::<(Option<String>, i64)>::new()
        );
    }

    // A reset ahead books its wake on the machine's helper only while the account's wake switch
    // is on, and turning the switch off cancels the wake booked. Killed by the wake booked with
    // the switch off, and by a booked wake left in place once the switch turns off.
    #[rstest]
    #[case::the_wake_switch_on(true)]
    #[case::the_wake_switch_off(false)]
    #[tokio::test(start_paused = true)]
    async fn a_reset_ahead_books_a_wake_only_with_the_wake_switch_on(#[case] is_wake_on: bool) {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let fixture = open(&database, data_folder.path(), new_clock()).await;
        let account = fixture.register().await;
        let wake_switch = |is_on| AccountSettingsChange {
            wake_for_window_start_enabled: Some(is_on),
            ..AccountSettingsChange::default()
        };
        fixture
            .registry
            .change_settings(account.account_id.clone(), wake_switch(is_wake_on))
            .await
            .expect("the switch changes");
        let reset = fixture.clock.now() + Duration::from_hours(2);
        store_window(&fixture, &account, FIVE_HOURS, Some(reset)).await;
        let stored_reset = SystemTime::from(
            wire_instant(reset)
                .timestamp()
                .expect("a stored reset reads as an instant"),
        );

        look(&fixture, &account).await;

        let booked = if is_wake_on {
            vec![WakeHelperCall::Book(stored_reset)]
        } else {
            Vec::new()
        };
        assert_eq!(fixture.wakes.calls(), booked);

        fixture
            .registry
            .change_settings(account.account_id.clone(), wake_switch(false))
            .await
            .expect("the switch changes");
        look(&fixture, &account).await;

        let canceled = if is_wake_on {
            vec![
                WakeHelperCall::Book(stored_reset),
                WakeHelperCall::Cancel(stored_reset),
            ]
        } else {
            Vec::new()
        };
        assert_eq!(fixture.wakes.calls(), canceled);
        assert_eq!(window_starts(&fixture, &claude()), 0);
    }
}
