use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::{SignedDuration, Timestamp};
use rusqlite::OptionalExtension as _;
use serde_json::{Value, json};
use sidekicks_contracts::attention::{
    AttentionBannerSettledState, AttentionId, AttentionItem, AttentionSubscribeRequest,
};
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::presence::PresenceRegister;
use sidekicks_platforms::{WallClock, WallClockTimer, WallClockWait};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::writer::test_file::{test_run_id, test_session_id};
use sidekicks_store::events::session::appender::SessionEventLinkage;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use tokio::sync::watch;
use tokio::time::{Instant, timeout};
use tokio_util::sync::CancellationToken;

use super::build_retirement::{
    PROVIDER_BUILD_RETIREMENT_JOB, PROVIDER_BUILD_RETIREMENT_RETRY_JOB, RETIREMENT_RETRY_DELAY,
};
use super::{AttentionService, AttentionServiceDependencies, DecisionTask, MERGE_WINDOW};
use crate::attention::banner_launcher::counting_starter::CountingStarter;
use crate::attention::banner_launcher::{BannerLauncher, WindowlessAppStarter};
use crate::attention::projection::notify_entry_statements;
use crate::attention::read::read_attention_projection;
use crate::attention::test_log::AttentionTestLog;
use crate::run::engine::test_fixture::insert_running_run;

const MACHINE_DEVICE: &str = "device-machine";
const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
// Long enough for a write and a read on a loaded machine; a missed wake fails at it.
const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The machine's settings as a test sets them, switchable between decisions.
struct TestSettings(Mutex<MachineSettings>);

impl MachineSettingsReader for TestSettings {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        let settings = lock(&self.0).clone();
        async move { Ok(settings) }.boxed()
    }
}

struct Fixture {
    log: AttentionTestLog,
    service: Arc<AttentionService>,
    settings: Arc<TestSettings>,
    starter: Arc<CountingStarter>,
    scheduler: Arc<Scheduler>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_wall_clock(Arc::new(
            WallClockTimer::new().expect("the wall-clock timer is made"),
        ))
        .await
    }

    /// A fixture whose scheduler arms `wall_clock`'s timer.
    async fn with_wall_clock(wall_clock: Arc<dyn WallClock>) -> Self {
        let log = AttentionTestLog::new().await;
        let mut settings = MachineSettings::default();
        settings.notifications.web_address.enabled = true;
        let settings = Arc::new(TestSettings(Mutex::new(settings)));
        // A started app never exits, so no timer runs behind a start.
        let starter = Arc::new(CountingStarter::never_exiting());
        let scheduler = Arc::new(Scheduler::start(wall_clock, None, watch::channel(0).1));
        let service = Arc::new(AttentionService::new(AttentionServiceDependencies {
            writer: Arc::clone(&log.writer),
            pool: Arc::clone(&log.pool),
            changes: log.changes.clone(),
            settings: Arc::clone(&settings) as Arc<dyn MachineSettingsReader>,
            presence: Arc::new(PresenceRegister::default()),
            launcher: Arc::new(BannerLauncher::new(
                Arc::clone(&starter) as Arc<dyn WindowlessAppStarter>
            )),
            machine_device_id: device(MACHINE_DEVICE),
            scheduler: Arc::clone(&scheduler),
        }));
        Self {
            log,
            service,
            settings,
            starter,
            scheduler,
        }
    }

    fn task(&self) -> DecisionTask {
        DecisionTask::new(Arc::clone(&self.service))
    }

    /// The decision task's pass, which must not fail.
    async fn pass(task: &mut DecisionTask) {
        task.pass()
            .await
            .expect("the decision pass reads and writes");
    }

    /// `entry_id`'s banner state, the entry it merged into and its web-address state, `None`
    /// while it has no delivery row.
    fn delivery(&self, entry_id: &str) -> Option<(Option<String>, Option<String>, Option<String>)> {
        self.log
            .database
            .reader()
            .query_row(
                "SELECT banner_state, merged_into, web_address_state FROM attention_deliveries
                  WHERE entry_id = ?1",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .expect("the delivery read runs")
    }

    fn banner(&self, entry_id: &str) -> (Option<String>, Option<String>) {
        let (banner_state, merged_into, _) = self.delivery(entry_id).expect("the entry is decided");
        (banner_state, merged_into)
    }

    fn launches(&self) -> usize {
        self.starter.starts()
    }
}

fn device(id: &str) -> DeviceId {
    DeviceId::new(id.to_owned()).expect("a test device id")
}

/// Steps the decision task's clock past one merge window; the store's writes run on threads of
/// their own, so the clock is paused only for the step.
async fn pass_the_window() {
    tokio::time::pause();
    tokio::time::advance(MERGE_WINDOW).await;
    tokio::time::resume();
}

/// An `agent.run.completed` event of `run_id` in `session_id`.
fn completed_in(session_id: SessionId, run_id: RunId) -> Value {
    json!({"type": "agent.run.completed", "payload": {
        "sessionId": session_id, "runId": run_id, "runVersion": 2,
        "previousState": "running", "newState": "completed",
    }})
}

// Two ends of one session within the half second raise one banner, the newer's, and an end of
// another session raises its own; every entry stays. Killed by leading-edge selection, which
// keeps the first end's banner, and by merging across subjects.
#[tokio::test]
async fn two_moments_of_one_session_raise_one_banner_and_two_sessions_raise_two() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    let other_session = test_session_id();
    let [first, second] = [(); 2].map(|()| log.run(None));
    let other = test_run_id();
    insert_running_run(&log.database, other_session, other);
    let mut task = fixture.task();

    log.append(log.run_state(first, "completed", 2, json!({})))
        .await;
    Fixture::pass(&mut task).await;
    log.append(log.run_state(second, "completed", 2, json!({})))
        .await;
    log.append_to(
        other_session,
        completed_in(other_session, other),
        SessionEventLinkage::default(),
    )
    .await;
    Fixture::pass(&mut task).await;
    let [first, second, other] = [first, second, other].map(|run_id| log.entry_of(run_id));
    assert_eq!(
        fixture.delivery(&first),
        None,
        "no banner before the window closes"
    );
    pass_the_window().await;
    Fixture::pass(&mut task).await;

    assert_eq!(fixture.banner(&second), (Some("pending".to_owned()), None));
    assert_eq!(
        fixture.banner(&first),
        (Some("withheld".to_owned()), Some(second.clone()))
    );
    assert_eq!(fixture.banner(&other), (Some("pending".to_owned()), None));
}

// A wait outranks a newer end in its session; when the wait resolves, the wait merged into it is
// decided afresh, and the waits' switch turned off in between withholds it, while the end merged
// into it stays withheld. Killed by newest-wins ranking, by a re-decision that reuses the first
// decision, and by the hand-back taking informational entries.
#[tokio::test]
async fn a_wait_wins_its_window_and_a_merged_wait_is_decided_again_when_it_resolves() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    let [older_wait, picked_wait, finished] = [(); 3].map(|()| log.run(None));
    let mut task = fixture.task();

    log.append(log.run_state(older_wait, "waitingForApproval", 2, json!({})))
        .await;
    Fixture::pass(&mut task).await;
    log.append(log.run_state(picked_wait, "waitingForInput", 2, json!({})))
        .await;
    log.append(log.run_state(finished, "completed", 2, json!({})))
        .await;
    pass_the_window().await;
    Fixture::pass(&mut task).await;
    let [older_entry, picked_entry, finished_entry] =
        [older_wait, picked_wait, finished].map(|run_id| log.entry_of(run_id));
    assert_eq!(
        fixture.banner(&picked_entry),
        (Some("pending".to_owned()), None)
    );
    for merged in [&older_entry, &finished_entry] {
        assert_eq!(
            fixture.banner(merged),
            (Some("withheld".to_owned()), Some(picked_entry.clone()))
        );
    }

    lock(&fixture.settings.0).notifications.kinds.waiting_on_you = false;
    log.append(log.run_state(picked_wait, "running", 3, json!({})))
        .await;
    assert_eq!(fixture.banner(&older_entry), (None, None), "handed back");
    Fixture::pass(&mut task).await;
    pass_the_window().await;
    Fixture::pass(&mut task).await;

    assert_eq!(
        fixture.banner(&older_entry),
        (Some("withheld".to_owned()), None)
    );
    assert_eq!(
        fixture.banner(&finished_entry),
        (Some("withheld".to_owned()), Some(picked_entry))
    );
}

// A read that fails at a window's close moves the window a window past the failure, so the loop
// reads again then, never at once, and again a window after a second failure; once the read
// succeeds the entry is decided. Killed by the failed read keeping its closed window.
#[tokio::test]
async fn a_read_that_fails_at_a_close_is_tried_again_a_window_later() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    let run_id = log.run(None);
    let mut task = fixture.task();
    log.append(log.run_state(run_id, "completed", 2, json!({})))
        .await;
    Fixture::pass(&mut task).await;
    let entry = log.entry_of(run_id);
    let rename_deliveries = |from: &str, to: &str| {
        log.database
            .reader()
            .execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}"))
            .expect("the deliveries table is renamed");
    };
    rename_deliveries("attention_deliveries", "attention_deliveries_away");

    tokio::time::pause();
    for _ in 0..2 {
        let closes_at = task.next_close().expect("the entry's window is open");
        tokio::time::advance(closes_at.saturating_duration_since(Instant::now())).await;
        let failed_at = Instant::now();
        assert!(task.pass().await.is_err(), "the read fails");
        assert!(
            task.next_close().expect("the window stays") >= failed_at + MERGE_WINDOW,
            "the failed read is tried again a window later"
        );
    }
    tokio::time::advance(MERGE_WINDOW).await;
    tokio::time::resume();
    rename_deliveries("attention_deliveries_away", "attention_deliveries");
    Fixture::pass(&mut task).await;

    assert_eq!(fixture.banner(&entry), (Some("pending".to_owned()), None));
}

// Only this machine's main settles a banner, and only while it is pending. Killed by an
// unguarded update, and by the device check dropped.
#[tokio::test]
async fn a_settle_moves_only_this_machines_pending_banner() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    let run_id = log.run(None);
    log.append(log.run_state(run_id, "completed", 2, json!({})))
        .await;
    let entry = log.entry_of(run_id);
    log.decide(&entry, Some("pending"), None);
    let entry_id = AttentionId::new(entry.clone()).expect("a stored entry id");
    let settle = |state, device_id: &str| {
        let device_id = device(device_id);
        let service = Arc::clone(&fixture.service);
        let entry_id = entry_id.clone();
        async move {
            service
                .settle(&entry_id, state, Some(&device_id))
                .await
                .expect("the settle is written");
        }
    };

    settle(AttentionBannerSettledState::Posted, "device-phone").await;
    assert_eq!(fixture.banner(&entry), (Some("pending".to_owned()), None));
    settle(AttentionBannerSettledState::Posted, MACHINE_DEVICE).await;
    assert_eq!(fixture.banner(&entry), (Some("posted".to_owned()), None));
    settle(AttentionBannerSettledState::Withheld, MACHINE_DEVICE).await;
    assert_eq!(fixture.banner(&entry), (Some("posted".to_owned()), None));
}

// A Notify step's entry, written in its step's own prelude, wakes the running decision task,
// which decides it at once. Killed by the counts' bump dropped from the Notify entry's statements.
#[tokio::test]
async fn a_notify_steps_entry_is_decided_by_the_running_task() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    let stop = CancellationToken::new();
    let decisions = fixture
        .service
        .start(stop.clone())
        .await
        .expect("the service starts");
    let mut count = log.changes.follow(None);
    let node_id = WorkflowNodeId::new("tell".to_owned()).expect("a test node id");
    let workflow_run_id = WorkflowRunId::new(WORKFLOW_RUN).expect("a test workflow run id");
    log.append_with(
        json!({"type": "workflow.step.completed", "payload": {
            "sessionId": log.session_id, "workflowRunId": WORKFLOW_RUN, "nodeId": "tell",
            "attempt": 1, "executionIndex": 0,
            "outputRef": {"kind": "inline", "items": []},
            "logRef": {"kind": "inline", "items": []},
        }}),
        SessionEventLinkage {
            transactional_prelude: notify_entry_statements(
                log.session_id,
                workflow_run_id,
                &node_id,
                SafeInt::ZERO,
                "018f0000-0000-7000-8000-0000000000aa",
                &NonEmptyText::new("Deployed".to_owned()).expect("a test notice"),
                "2026-10-28T09:00:00.000Z",
            ),
            ..SessionEventLinkage::default()
        },
    )
    .await;
    let notice: String = log
        .database
        .reader()
        .query_row(
            "SELECT id FROM attention_entries WHERE trigger = 'workflowNotify'",
            [],
            |row| row.get(0),
        )
        .expect("the Notify step raised its entry");

    timeout(WAIT, async {
        while fixture.delivery(&notice).is_none() {
            count.changed().await.expect("the counts stay open");
        }
    })
    .await
    .expect("the task decides the Notify entry");
    stop.cancel();
    decisions
        .await
        .expect("the decision task ends with the stop");

    assert_eq!(
        fixture.delivery(&notice),
        Some((Some("pending".to_owned()), None, Some("pending".to_owned())))
    );
}

// What a stop left behind: a resolved entry's posted banner is withdrawn, an undecided end keeps
// its banner back but still has its web address decided, and an undecided open wait goes through
// the gate, which starts the app. Killed by withholding everything, by gating the end, and by
// withholding the end's web address.
#[tokio::test]
async fn the_start_sweep_gates_an_open_wait_and_withholds_only_an_ends_banner() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    let [waiting, finished, resolved] = [(); 3].map(|()| log.run(None));
    log.append(log.run_state(waiting, "waitingForApproval", 2, json!({})))
        .await;
    log.append(log.run_state(finished, "completed", 2, json!({})))
        .await;
    log.append(log.run_state(resolved, "waitingForInput", 2, json!({})))
        .await;
    log.append(log.run_state(resolved, "running", 3, json!({})))
        .await;
    let [waiting, finished, resolved] =
        [waiting, finished, resolved].map(|run_id| log.entry_of(run_id));
    // The stop came between the resolve's write and its withdrawal.
    log.decide(&resolved, Some("posted"), None);

    let sessions = fixture
        .service
        .read_sessions_with_entries()
        .await
        .expect("the sessions read");
    fixture
        .service
        .sweep_after_stop(&sessions)
        .await
        .expect("the sweep runs");

    assert_eq!(
        fixture.banner(&resolved),
        (Some("withdrawn".to_owned()), None)
    );
    assert_eq!(
        fixture.delivery(&finished),
        Some((
            Some("withheld".to_owned()),
            None,
            Some("pending".to_owned())
        ))
    );
    assert_eq!(
        fixture.delivery(&waiting),
        None,
        "an open wait waits for the gate"
    );

    let mut task = fixture.task();
    Fixture::pass(&mut task).await;
    pass_the_window().await;
    Fixture::pass(&mut task).await;
    assert_eq!(fixture.banner(&waiting), (Some("pending".to_owned()), None));
    assert_eq!(fixture.launches(), 1);
}

/// The machine's change count, `None` before its first bump.
fn machine_version(log: &AttentionTestLog) -> Option<i64> {
    log.database
        .reader()
        .query_row(
            "SELECT version FROM attention_versions WHERE scope_key = ''",
            [],
            |row| row.get(0),
        )
        .optional()
        .expect("the count read runs")
}

/// The provider builds the whole projection lists, as their state words.
fn listed_builds(log: &AttentionTestLog) -> Vec<String> {
    read_attention_projection(
        &log.database.reader(),
        &AttentionSubscribeRequest {
            session_id: None,
            scope: None,
            run_id: None,
        },
    )
    .expect("the whole projection reads")
    .items
    .into_iter()
    .filter_map(|item| match item {
        AttentionItem::ProviderBuild(build) => Some(build.state_word.as_str().to_owned()),
        AttentionItem::Moment(_) | AttentionItem::Notify(_) => None,
    })
    .collect()
}

// A build moved to stays listed for a day after it was recorded and then leaves at the advance,
// waking the followers, while a build only available stays. Killed by the retirement missing from
// the advance, by the moved-to filter dropped, and by the bump dropped.
#[tokio::test]
async fn the_advance_retires_a_day_old_build_moved_to_and_keeps_an_available_one() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    // Recorded now, so the retirement the advance arms on the wall clock lies a day ahead.
    let recorded_at = Timestamp::now();
    for (provider, version, from_version) in [
        ("claude", "2.1.294", Some("2.1.293")),
        ("codex", "0.163.0", None),
    ] {
        insert_build(log, provider, version, from_version, recorded_at);
    }
    let advance = |hours: i64| {
        let now = recorded_at + SignedDuration::from_hours(hours);
        fixture.service.advance_retention(Vec::new(), now)
    };

    advance(23).await.expect("the advance within the day runs");
    assert_eq!(
        listed_builds(log),
        ["updated · 2.1.293 → 2.1.294", "0.163.0 available"]
    );
    assert_eq!(machine_version(log), None, "nothing retired wakes no one");

    advance(25).await.expect("the advance past the day runs");
    assert_eq!(listed_builds(log), ["0.163.0 available"]);
    assert_eq!(
        machine_version(log),
        Some(1),
        "the retirement wakes the followers"
    );
}

/// Records `provider`'s build `version` at `recorded_at`, moved to from `from_version` when given,
/// with no write that wakes anyone.
fn insert_build(
    log: &AttentionTestLog,
    provider: &str,
    version: &str,
    from_version: Option<&str>,
    recorded_at: Timestamp,
) {
    let recorded_at = WireInstant::from_timestamp(recorded_at).expect("a test instant");
    log.database
        .reader()
        .execute(
            "INSERT INTO provider_builds (provider_name, version, from_version, recorded_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![provider, version, from_version, recorded_at.as_str()],
        )
        .expect("the test records a build");
}

/// Waits until the service holds the provider build retirement armed for `instant`.
async fn wait_until_armed_at(service: &AttentionService, instant: SystemTime) {
    timeout(WAIT, async {
        while lock(&service.retirement).armed_instant() != Some(instant) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the retirement is armed for its instant");
}

// A build moved to that was recorded a day ago leaves the list when the wall clock's timer fires
// for it, with no decision batch, once its recording is told; one moved to within the day and one
// only available, recorded before both, stay, and the one retirement left waiting is the next
// one's. Killed by a recorded build arming nothing, by the moved-to filter dropped from the next
// retirement, and by the retirement it replaces left uncanceled.
#[tokio::test]
async fn a_day_old_build_moved_to_retires_when_its_timer_fires_with_no_batch() {
    let fixture = Fixture::new().await;
    let log = &fixture.log;
    let stop = CancellationToken::new();
    let decisions = fixture
        .service
        .start(stop.clone())
        .await
        .expect("the service starts");
    // Whole milliseconds, as the record stores an instant.
    let now = Timestamp::from_millisecond(Timestamp::now().as_millisecond())
        .expect("the clock's instant is a timestamp");
    let within_day = now - SignedDuration::from_hours(23);
    insert_build(log, "codex", "0.164.0", Some("0.163.0"), within_day);
    log.changes.raise_recorded_builds();
    let next_retirement = SystemTime::from(
        within_day + SignedDuration::from_hours(24) + SignedDuration::from_millis(1),
    );
    wait_until_armed_at(&fixture.service, next_retirement).await;
    let mut count = fixture.service.follow(None);

    insert_build(
        log,
        "claude",
        "2.1.295",
        None,
        now - SignedDuration::from_hours(26),
    );
    insert_build(
        log,
        "claude",
        "2.1.294",
        Some("2.1.293"),
        now - SignedDuration::from_hours(25),
    );
    log.changes.raise_recorded_builds();
    timeout(WAIT, async {
        while machine_version(log).is_none() {
            count.changed().await.expect("the counts stay followed");
        }
    })
    .await
    .expect("the timer retires the day-old build");

    assert_eq!(
        listed_builds(log),
        ["updated · 0.163.0 → 0.164.0", "2.1.295 available"]
    );
    wait_until_armed_at(&fixture.service, next_retirement).await;
    assert_eq!(
        fixture.scheduler.waiting_job_names(),
        [PROVIDER_BUILD_RETIREMENT_JOB],
        "the retirement replaced was canceled"
    );
    stop.cancel();
    decisions
        .await
        .expect("the decision task ends with the stop");
}

// The system's wall-clock timer, which refuses its first arm as a system refusing the setting.
struct RefusingFirstArm {
    timer: WallClockTimer,
    has_refused: AtomicBool,
}

impl WallClock for RefusingFirstArm {
    fn arm(&self, instant: SystemTime) -> std::io::Result<()> {
        if !self.has_refused.swap(true, Ordering::SeqCst) {
            return Err(std::io::Error::other("the test refuses the first arm"));
        }
        self.timer.arm(instant)
    }

    fn disarm(&self) -> std::io::Result<()> {
        self.timer.disarm()
    }

    fn wait(&self) -> WallClockWait<'_> {
        self.timer.wait()
    }
}

// A retirement whose wall-clock timer the system refuses leaves the slot empty for a minute on the
// monotonic clock, then the retry arms it. Killed by the retry dropped.
#[tokio::test]
async fn a_refused_retirement_is_armed_again_by_its_retry_a_minute_later() {
    let fixture = Fixture::with_wall_clock(Arc::new(RefusingFirstArm {
        timer: WallClockTimer::new().expect("the wall-clock timer is made"),
        has_refused: AtomicBool::new(false),
    }))
    .await;
    let within_day = Timestamp::from_millisecond(Timestamp::now().as_millisecond())
        .expect("the clock's instant is a timestamp")
        - SignedDuration::from_hours(23);
    insert_build(
        &fixture.log,
        "codex",
        "0.164.0",
        Some("0.163.0"),
        within_day,
    );
    tokio::time::pause();

    fixture.service.arm_provider_build_retirement().await;
    tokio::time::advance(RETIREMENT_RETRY_DELAY.saturating_sub(std::time::Duration::from_secs(1)))
        .await;
    assert_eq!(
        fixture.scheduler.waiting_job_names(),
        [PROVIDER_BUILD_RETIREMENT_RETRY_JOB],
        "the refused retirement waits for its retry"
    );

    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    wait_until_armed_at(
        &fixture.service,
        SystemTime::from(
            within_day + SignedDuration::from_hours(24) + SignedDuration::from_millis(1),
        ),
    )
    .await;
    assert_eq!(
        fixture.scheduler.waiting_job_names(),
        [PROVIDER_BUILD_RETIREMENT_JOB]
    );
}
