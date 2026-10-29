use std::error::Error;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::OptionalExtension as _;
use serde_json::{Value, json};
use sidekicks_contracts::attention::{AttentionBannerSettledState, AttentionId};
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::presence::PresenceRegister;
use sidekicks_platforms::WindowlessLaunch;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::{test_run_id, test_session_id};
use sidekicks_store::events::session::appender::SessionEventLinkage;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::{AttentionService, AttentionServiceDependencies, DecisionTask, MERGE_WINDOW};
use crate::attention::banner_launcher::{BannerLauncher, WindowlessAppStarter};
use crate::attention::projection::notify_entry_statements;
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

/// Counts the app's starts; a started app never exits, so no timer runs behind a start.
#[derive(Default)]
struct CountingStarter(AtomicUsize);

impl WindowlessAppStarter for CountingStarter {
    fn launch_app(&self) -> BoxFuture<'static, std::io::Result<WindowlessLaunch>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        async {
            Ok(WindowlessLaunch::Watched {
                exit: std::future::pending().boxed(),
            })
        }
        .boxed()
    }
}

struct Fixture {
    log: AttentionTestLog,
    service: Arc<AttentionService>,
    settings: Arc<TestSettings>,
    starter: Arc<CountingStarter>,
}

impl Fixture {
    async fn new() -> Self {
        let log = AttentionTestLog::new().await;
        let mut settings = MachineSettings::default();
        settings.notifications.web_address.enabled = true;
        let settings = Arc::new(TestSettings(Mutex::new(settings)));
        let starter = Arc::new(CountingStarter::default());
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
        }));
        Self {
            log,
            service,
            settings,
            starter,
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
        self.starter.0.load(Ordering::SeqCst)
    }
}

fn device(id: &str) -> DeviceId {
    DeviceId::new(id.to_owned()).expect("a test device id")
}

fn word(state: &str) -> Option<String> {
    Some(state.to_owned())
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

    assert_eq!(fixture.banner(&second), (word("pending"), None));
    assert_eq!(
        fixture.banner(&first),
        (word("withheld"), Some(second.clone()))
    );
    assert_eq!(fixture.banner(&other), (word("pending"), None));
}

// A wait outranks a newer end in its session; when the wait resolves, the wait merged into it is
// decided afresh, and the waits' switch turned off in between withholds it. Killed by newest-wins
// ranking, and by a re-decision that reuses the first decision.
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
    assert_eq!(fixture.banner(&picked_entry), (word("pending"), None));
    for merged in [&older_entry, &finished_entry] {
        assert_eq!(
            fixture.banner(merged),
            (word("withheld"), Some(picked_entry.clone()))
        );
    }

    lock(&fixture.settings.0).notifications.kinds.waiting_on_you = false;
    log.append(log.run_state(picked_wait, "running", 3, json!({})))
        .await;
    assert_eq!(fixture.banner(&older_entry), (None, None), "handed back");
    Fixture::pass(&mut task).await;
    pass_the_window().await;
    Fixture::pass(&mut task).await;

    assert_eq!(fixture.banner(&older_entry), (word("withheld"), None));
    assert_eq!(fixture.banner(&finished_entry), (word("pending"), None));
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
    assert_eq!(fixture.banner(&entry), (word("pending"), None));
    settle(AttentionBannerSettledState::Posted, MACHINE_DEVICE).await;
    assert_eq!(fixture.banner(&entry), (word("posted"), None));
    settle(AttentionBannerSettledState::Withheld, MACHINE_DEVICE).await;
    assert_eq!(fixture.banner(&entry), (word("posted"), None));
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
        Some((word("pending"), None, word("pending")))
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

    assert_eq!(fixture.banner(&resolved), (word("withdrawn"), None));
    assert_eq!(
        fixture.delivery(&finished),
        Some((word("withheld"), None, word("pending")))
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
    assert_eq!(fixture.banner(&waiting), (word("pending"), None));
    assert_eq!(fixture.launches(), 1);
}
