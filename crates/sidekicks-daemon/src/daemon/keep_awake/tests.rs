use std::error::Error;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_platforms::{KeepAwakeHold, KeepAwakePurpose};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{KeepAwakeDeps, KeepAwakeTarget, keep_machine_awake};

const WAIT: Duration = Duration::from_secs(10);

// Set only for the child the killed-process test starts, which holds until it is killed.
const HOLDER_VARIABLE: &str = "SIDEKICKS_KEEP_AWAKE_TEST_HOLDER";
const HOLDER_TEST: &str = "daemon::keep_awake::tests::a_hold_kept_until_the_process_is_killed";

#[derive(Debug, PartialEq)]
enum HoldCall {
    Take(KeepAwakePurpose),
    Release,
}

// A hold that tells the test each call and refuses as many takes as `refusals` holds.
struct RecordedHold {
    calls: mpsc::UnboundedSender<HoldCall>,
    refusals: Arc<AtomicUsize>,
}

impl RecordedHold {
    fn record(&self, call: HoldCall) {
        self.calls.send(call).expect("the test reads every call");
    }
}

impl KeepAwakeTarget for RecordedHold {
    fn take(
        &self,
        purpose: KeepAwakePurpose,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record(HoldCall::Take(purpose));
        let is_refused = self
            .refusals
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok();
        async move {
            if is_refused {
                Err("the system refused the hold".into())
            } else {
                Ok(())
            }
        }
        .boxed()
    }

    fn release(&self) {
        self.record(HoldCall::Release);
    }
}

// Keep-awake running over a recorded hold, with each input the test moves.
struct KeepAwake {
    calls: mpsc::UnboundedReceiver<HoldCall>,
    live_runs: watch::Sender<u32>,
    settings: watch::Sender<MachineSettings>,
    is_on_power: watch::Sender<bool>,
    stop: CancellationToken,
    running: JoinHandle<()>,
}

impl KeepAwake {
    async fn next_call(&mut self) -> HoldCall {
        tokio::time::timeout(WAIT, self.calls.recv())
            .await
            .expect("the hold is moved")
            .expect("keep-awake keeps its hold")
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

fn keep_awake(refusals: usize) -> KeepAwake {
    let (calls, recorded) = mpsc::unbounded_channel();
    let live_runs = watch::Sender::new(0);
    let settings = watch::Sender::new(MachineSettings::default());
    let is_on_power = watch::Sender::new(false);
    let stop = CancellationToken::new();
    let running = tokio::spawn(keep_machine_awake(KeepAwakeDeps {
        hold: RecordedHold {
            calls,
            refusals: Arc::new(AtomicUsize::new(refusals)),
        },
        live_runs: live_runs.subscribe(),
        settings: settings.subscribe(),
        is_on_power: is_on_power.subscribe(),
        stop: stop.clone(),
    }));
    KeepAwake {
        calls: recorded,
        live_runs,
        settings,
        is_on_power,
        stop,
        running,
    }
}

// With the agent switch on, the first live run takes the hold, a second takes nothing more and
// the last ending lets it go; the switch turned off lets it go; the other-devices switch holds
// the machine only on power, under the agent's hold while a run is live; a stop lets go. Killed
// by a hold taken per run, by a switch turned off that leaves the hold, and by the power gate
// inverted.
#[tokio::test]
async fn the_hold_follows_the_switches_the_live_runs_and_the_power_source() {
    let mut keep_awake = keep_awake(0);
    keep_awake.switch(true, false);
    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_call().await,
        HoldCall::Take(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.live_runs.send_replace(2);
    keep_awake.let_read().await;
    keep_awake.live_runs.send_replace(1);
    keep_awake.let_read().await;
    keep_awake.live_runs.send_replace(0);
    assert_eq!(keep_awake.next_call().await, HoldCall::Release);

    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_call().await,
        HoldCall::Take(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.switch(false, false);
    assert_eq!(keep_awake.next_call().await, HoldCall::Release);

    keep_awake.switch(true, true);
    assert_eq!(
        keep_awake.next_call().await,
        HoldCall::Take(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.is_on_power.send_replace(true);
    keep_awake.let_read().await;
    keep_awake.live_runs.send_replace(0);
    assert_eq!(
        keep_awake.next_call().await,
        HoldCall::Take(KeepAwakePurpose::OtherDevices)
    );
    keep_awake.is_on_power.send_replace(false);
    assert_eq!(keep_awake.next_call().await, HoldCall::Release);

    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_call().await,
        HoldCall::Take(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.stop.cancel();
    assert_eq!(keep_awake.next_call().await, HoldCall::Release);
    tokio::time::timeout(WAIT, keep_awake.running)
        .await
        .expect("keep-awake ends at the stop")
        .expect("keep-awake ends without a panic");
}

// A hold the system refuses holds nothing and is taken again at the next change. Killed by a
// refused hold counted as held.
#[tokio::test]
async fn a_refused_hold_is_taken_again_at_the_next_change() {
    let mut keep_awake = keep_awake(1);
    keep_awake.switch(true, false);
    keep_awake.live_runs.send_replace(1);
    assert_eq!(
        keep_awake.next_call().await,
        HoldCall::Take(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.live_runs.send_replace(2);
    assert_eq!(
        keep_awake.next_call().await,
        HoldCall::Take(KeepAwakePurpose::AgentWorks)
    );
    keep_awake.live_runs.send_replace(0);
    assert_eq!(keep_awake.next_call().await, HoldCall::Release);
}

// The power manager's assertions of process `pid` that name the app.
fn assertions_of(pid: u32) -> Vec<String> {
    let listed = Command::new("/usr/bin/pmset")
        .args(["-g", "assertions"])
        .output()
        .expect("pmset runs");
    assert!(listed.status.success(), "pmset lists the assertions");
    String::from_utf8_lossy(&listed.stdout)
        .lines()
        .filter(|line| line.contains(&format!("pid {pid}(")) && line.contains(APP_DISPLAY_NAME))
        .map(str::to_owned)
        .collect()
}

// Reads `pid`'s assertions until `is_done` holds them, failing after the wait.
async fn wait_for_assertions(pid: u32, is_done: impl Fn(&[String]) -> bool) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let assertions = assertions_of(pid);
        if is_done(&assertions) || tokio::time::Instant::now() >= deadline {
            return assertions;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

// The hold the system lists keeps the machine and its screen awake while idle and never blocks
// a sleep the person asks for; it goes when the hold drops and when its process is killed.
// Killed by the guard taken off the hold's thread and by a hold that blocks every sleep. Needs
// macOS's power manager: run with `--run-ignored only -E 'test(/pmset/)'`.
#[tokio::test]
#[ignore = "takes a real hold from macOS's power manager and reads it with pmset"]
async fn pmset_lists_the_hold_until_it_drops_or_its_process_is_killed() {
    let pid = std::process::id();
    let hold = KeepAwakeHold::new().expect("the hold's thread starts");
    hold.take(KeepAwakePurpose::AgentWorks)
        .await
        .expect("the system allows the hold");
    let held = assertions_of(pid);
    for kind in ["PreventUserIdleDisplaySleep", "PreventUserIdleSystemSleep"] {
        assert!(held.iter().any(|line| line.contains(kind)), "{held:?}");
    }
    assert!(
        !held.iter().any(|line| line.contains("PreventSystemSleep")),
        "{held:?}"
    );
    drop(hold);
    assert_eq!(assertions_of(pid), Vec::<String>::new());

    let mut holder = Command::new(std::env::current_exe().expect("the test knows its program"))
        .args(["--exact", HOLDER_TEST, "--ignored", "--nocapture"])
        .env(HOLDER_VARIABLE, "1")
        .spawn()
        .expect("the holder starts");
    let holder_pid = holder.id();
    let listed = wait_for_assertions(holder_pid, |lines| !lines.is_empty()).await;
    assert!(!listed.is_empty(), "the holder's hold is listed");
    holder.kill().expect("the test kills its own child");
    holder.wait().expect("the killed holder is reaped");
    let left = wait_for_assertions(holder_pid, <[String]>::is_empty).await;
    assert_eq!(left, Vec::<String>::new(), "a killed process's hold goes");
}

// The child of the test above: holds the machine awake until it is killed.
#[tokio::test]
#[ignore = "the pmset test's child, which holds until it is killed"]
async fn a_hold_kept_until_the_process_is_killed() {
    if std::env::var_os(HOLDER_VARIABLE).is_none() {
        return;
    }
    let hold = KeepAwakeHold::new().expect("the hold's thread starts");
    hold.take(KeepAwakePurpose::AgentWorks)
        .await
        .expect("the system allows the hold");
    tokio::time::sleep(Duration::from_secs(120)).await;
}
