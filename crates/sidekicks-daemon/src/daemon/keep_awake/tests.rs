use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_platforms::{KeepAwakeHold, KeepAwakePurpose, KeepAwakeRefused};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{KeepAwakeDeps, keep_machine_awake};

const WAIT: Duration = Duration::from_secs(10);

// What the system's stand-in saw: a guard asked for, granted or refused, and a guard dropped.
#[derive(Debug, PartialEq)]
enum GuardEvent {
    Asked(KeepAwakePurpose),
    Dropped(KeepAwakePurpose),
}

// A guard that tells the test when the hold lets it go.
struct RecordedGuard {
    purpose: KeepAwakePurpose,
    events: mpsc::UnboundedSender<GuardEvent>,
}

impl Drop for RecordedGuard {
    fn drop(&mut self) {
        self.events
            .send(GuardEvent::Dropped(self.purpose))
            .expect("the test reads every event");
    }
}

// Keep-awake running over a hold whose guards the test sees, with each input the test moves.
struct KeepAwake {
    events: mpsc::UnboundedReceiver<GuardEvent>,
    refusals: Arc<AtomicUsize>,
    live_runs: watch::Sender<u32>,
    settings: watch::Sender<MachineSettings>,
    is_on_power: watch::Sender<bool>,
    stop: CancellationToken,
    running: JoinHandle<()>,
}

impl KeepAwake {
    async fn next_event(&mut self) -> GuardEvent {
        tokio::time::timeout(WAIT, self.events.recv())
            .await
            .expect("the hold is moved")
            .expect("the hold's thread keeps its guard taker")
    }

    // Lets keep-awake read every change sent so far, so changes the test sends one by one are not
    // read as one; the test's runtime runs one task at a time.
    async fn let_read(&self) {
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
    }

    fn switch(&self, keeps_while_agent_works: bool, keeps_for_other_devices: bool) {
        self.settings.send_modify(|settings| {
            settings.keep_awake_while_agent_works = keeps_while_agent_works;
            settings.keep_awake_for_other_devices = keeps_for_other_devices;
        });
    }
}

// Keep-awake over a hold whose stand-in system refuses as many asks as `refusals` holds.
fn keep_awake() -> KeepAwake {
    let (sender, events) = mpsc::unbounded_channel();
    let refusals = Arc::new(AtomicUsize::new(0));
    let refused = Arc::clone(&refusals);
    let hold = KeepAwakeHold::with_guard_taker(move |purpose| {
        sender
            .send(GuardEvent::Asked(purpose))
            .expect("the test reads every event");
        let is_refused = refused
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok();
        if is_refused {
            Err(KeepAwakeRefused::stand_in(purpose))
        } else {
            Ok(RecordedGuard {
                purpose,
                events: sender.clone(),
            })
        }
    })
    .expect("the hold's thread starts");
    let live_runs = watch::Sender::new(0);
    let settings = watch::Sender::new(MachineSettings::default());
    let is_on_power = watch::Sender::new(false);
    let stop = CancellationToken::new();
    let running = tokio::spawn(keep_machine_awake(KeepAwakeDeps {
        hold,
        live_runs: live_runs.subscribe(),
        settings: settings.subscribe(),
        is_on_power: is_on_power.subscribe(),
        stop: stop.clone(),
    }));
    KeepAwake {
        events,
        refusals,
        live_runs,
        settings,
        is_on_power,
        stop,
        running,
    }
}

// With the agent switch on, the first live run takes a guard and the last ending lets it go; the
// switch turned off lets it go; the other-devices switch holds the machine only on power, under
// the agent's hold while a run is live, and moving between them takes the new guard before the
// old goes; a stop lets go. Killed by a switch turned off that leaves the hold, by the power gate
// inverted, and by a stop that keeps the hold.
#[tokio::test]
async fn the_hold_follows_the_switches_the_live_runs_and_the_power_source() {
    let mut keep_awake = keep_awake();
    keep_awake.switch(true, false);
    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.live_runs.send_replace(2);
    keep_awake.let_read().await;
    keep_awake.live_runs.send_replace(1);
    keep_awake.let_read().await;
    keep_awake.live_runs.send_replace(0);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Dropped(KeepAwakePurpose::AgentWorks)
    );

    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.switch(false, false);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Dropped(KeepAwakePurpose::AgentWorks)
    );

    keep_awake.switch(true, true);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.is_on_power.send_replace(true);
    keep_awake.let_read().await;
    keep_awake.live_runs.send_replace(0);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::OtherDevices)
    );
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Dropped(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.is_on_power.send_replace(false);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Dropped(KeepAwakePurpose::OtherDevices)
    );

    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.stop.cancel();
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Dropped(KeepAwakePurpose::AgentWorks)
    );
    tokio::time::timeout(WAIT, keep_awake.running)
        .await
        .expect("keep-awake ends at the stop")
        .expect("keep-awake ends without a panic");
}

// A hold the system refuses keeps the guard held before it and is asked for again at the next
// change, which then takes it and lets the old one go. Killed by a refused hold counted as held,
// which asks nothing at the next change.
#[tokio::test]
async fn a_refused_hold_keeps_the_old_one_and_is_asked_again_at_the_next_change() {
    let mut keep_awake = keep_awake();
    keep_awake.switch(true, true);
    keep_awake.is_on_power.send_replace(true);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::OtherDevices)
    );
    keep_awake.refusals.store(1, Ordering::SeqCst);
    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.live_runs.send_replace(2);
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Asked(KeepAwakePurpose::AgentWorks)
    );
    assert_eq!(
        keep_awake.next_event().await,
        GuardEvent::Dropped(KeepAwakePurpose::OtherDevices)
    );
}
