use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde_json::Value;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalId;
use sidekicks_contracts::terminal::control::TerminalControlChangedPayload;
use sidekicks_contracts::trust_statement::DeviceId;
use tokio::sync::oneshot;

use super::{ShellConnection, ShellControlLease, ShellLeaseCaller, ShellLeaseRun, ShellWriter};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::TransportId;

/// A lease whose broadcasts are recorded as sent, and whose next broadcasts a case can hold back
/// and then land or fail.
struct LeaseUnderTest {
    lease: Arc<ShellControlLease>,
    changes: Arc<Mutex<Vec<Value>>>,
    held: Arc<Mutex<VecDeque<oneshot::Receiver<bool>>>>,
}

impl LeaseUnderTest {
    fn open() -> Self {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let held: Arc<Mutex<VecDeque<oneshot::Receiver<bool>>>> = Arc::default();
        let recorded = Arc::clone(&changes);
        let gates = Arc::clone(&held);
        let lease = ShellControlLease::new(
            SessionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e").expect("a session id"),
            TerminalId::new("terminal-1".to_owned()).expect("a terminal id"),
            device("device-machine"),
            Arc::new(move |change: TerminalControlChangedPayload| {
                recorded
                    .lock()
                    .expect("no test panics holding it")
                    .push(serde_json::to_value(&change).expect("a payload serializes"));
                let gate = gates.lock().expect("no test panics holding it").pop_front();
                async move {
                    let lands = match gate {
                        Some(gate) => gate.await.expect("the case answers every held broadcast"),
                        None => true,
                    };
                    if lands {
                        Ok(())
                    } else {
                        Err(DomainError::new(
                            "relay down",
                            RefusalCode::SystemInternalError,
                        ))
                    }
                }
                .boxed()
            }),
            Arc::new(|_caller: &ShellLeaseCaller| Ok(())),
        );
        Self {
            lease: Arc::new(lease),
            changes,
            held,
        }
    }

    /// Holds the next broadcast back; the sender lands it with `true` and fails it with `false`.
    fn hold_next_broadcast(&self) -> oneshot::Sender<bool> {
        let (land, gate) = oneshot::channel();
        self.held
            .lock()
            .expect("no test panics holding it")
            .push_back(gate);
        land
    }

    /// Lets spawned acts run until `count` broadcasts have been sent.
    async fn sent(&self, count: usize) {
        while self
            .changes
            .lock()
            .expect("no test panics holding it")
            .len()
            < count
        {
            tokio::task::yield_now().await;
        }
    }

    /// Each broadcast as `(reason, leaseVersion, holderDeviceId, previousHolderDeviceId)`.
    fn changes(&self) -> Vec<(String, u64, Option<String>, Option<String>)> {
        let text = |value: &Value| value.as_str().map(str::to_owned);
        self.changes
            .lock()
            .expect("no test panics holding it")
            .iter()
            .map(|change| {
                (
                    text(&change["reason"]).expect("a reason"),
                    change["leaseVersion"].as_u64().expect("a version"),
                    text(&change["holderDeviceId"]),
                    text(&change["previousHolderDeviceId"]),
                )
            })
            .collect()
    }

    async fn write(&self, writer: &ShellWriter) -> Result<(), DomainError> {
        self.lease.admit_write(writer, || ())?.admitted().await
    }
}

fn device(id: &str) -> DeviceId {
    DeviceId::new(id.to_owned()).expect("a device id")
}

fn caller(device_id: &str, transport: u64, subscription: &str) -> ShellLeaseCaller {
    ShellLeaseCaller {
        connection: ShellConnection {
            device_id: device(device_id),
            transport_id: TransportId(transport),
        },
        output_subscription_id: SubscriptionId::new(subscription).expect("a subscription id"),
    }
}

fn run(run_id: &str, command_id: &str) -> ShellLeaseRun {
    ShellLeaseRun {
        run_id: RunId::new(run_id).expect("a run id"),
        command_id: CommandId::new(command_id.to_owned()).expect("a command id"),
    }
}

fn change(
    reason: &str,
    version: u64,
    holder: Option<&str>,
    previous: Option<&str>,
) -> (String, u64, Option<String>, Option<String>) {
    (
        reason.to_owned(),
        version,
        holder.map(str::to_owned),
        previous.map(str::to_owned),
    )
}

fn refusal_code<T>(result: Result<T, DomainError>) -> RefusalCode {
    result.err().expect("the act was refused").code
}

const SUBSCRIPTION_1: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001";
const SUBSCRIPTION_2: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0002";
const SUBSCRIPTION_3: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0003";
const RUN_A: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0a01";

#[tokio::test]
async fn one_of_two_racing_takes_wins_and_the_loser_neither_takes_nor_writes() {
    let under_test = LeaseUnderTest::open();
    let laptop = caller("device-laptop", 1, SUBSCRIPTION_1);
    let phone = caller("device-phone", 2, SUBSCRIPTION_2);
    let land = under_test.hold_next_broadcast();
    let laptop_take = tokio::spawn({
        let lease = Arc::clone(&under_test.lease);
        let laptop = laptop.clone();
        async move { lease.take(&laptop, false).await }
    });
    under_test.sent(1).await;
    let phone_take = tokio::spawn({
        let lease = Arc::clone(&under_test.lease);
        let phone = phone.clone();
        async move { lease.take(&phone, false).await }
    });
    tokio::task::yield_now().await;
    land.send(true).expect("the broadcast waits");

    let taken = laptop_take
        .await
        .expect("the take ran")
        .expect("the first take wins");
    assert_eq!(taken.holder_device_id, device("device-laptop"));
    let refused = phone_take.await.expect("the take ran");
    let refusal = refused.expect_err("the second take loses to the holder it waited out");
    assert_eq!(refusal.code, RefusalCode::TerminalControlHeldByOther);
    assert_eq!(
        refusal.detail.expect("the refusal names the holder")["holderDeviceId"],
        "device-laptop"
    );
    assert_eq!(
        refusal_code(under_test.write(&ShellWriter::Device(phone.clone())).await),
        RefusalCode::TerminalControlNotHeld
    );
    under_test
        .write(&ShellWriter::Device(laptop))
        .await
        .expect("the holder writes");

    under_test
        .lease
        .release_connection(TransportId(1))
        .await
        .expect("the release is broadcast");
    under_test
        .lease
        .take(&phone, false)
        .await
        .expect("a shell nobody holds is taken");
    assert_eq!(
        under_test.changes(),
        vec![
            change("taken", 1, Some("device-laptop"), None),
            change("autoReleasedDisconnect", 2, None, Some("device-laptop")),
            change("taken", 3, Some("device-phone"), None),
        ]
    );
}

#[tokio::test]
async fn a_take_whose_broadcast_fails_is_undone_failing_the_write_that_joined_it() {
    let under_test = LeaseUnderTest::open();
    let laptop = caller("device-laptop", 1, SUBSCRIPTION_1);
    let fail = under_test.hold_next_broadcast();
    let take = tokio::spawn({
        let lease = Arc::clone(&under_test.lease);
        let laptop = laptop.clone();
        async move { lease.take(&laptop, false).await }
    });
    under_test.sent(1).await;
    let wrote = Arc::new(Mutex::new(false));
    let write = tokio::spawn({
        let lease = Arc::clone(&under_test.lease);
        let writer = ShellWriter::Device(laptop.clone());
        let wrote = Arc::clone(&wrote);
        async move {
            lease
                .admit_write(&writer, move || {
                    *wrote.lock().expect("unpoisoned") = true;
                })?
                .admitted()
                .await
        }
    });
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    fail.send(false).expect("the broadcast waits");

    assert_eq!(
        refusal_code(take.await.expect("the take ran")),
        RefusalCode::SystemInternalError
    );
    assert_eq!(
        refusal_code(write.await.expect("the write ran")),
        RefusalCode::SystemInternalError
    );
    assert!(
        !*wrote.lock().expect("unpoisoned"),
        "no byte reaches an unannounced holder"
    );
    let reading = under_test.lease.read_holder().await;
    assert_eq!(reading.holder, None);
    assert_eq!(
        reading.lease_version.get(),
        2,
        "the undo raises the version again"
    );

    // A release to nobody whose broadcast fails still stands.
    under_test
        .lease
        .take(&laptop, false)
        .await
        .expect("the take lands");
    let fail = under_test.hold_next_broadcast();
    fail.send(false).expect("the broadcast is held");
    assert_eq!(
        refusal_code(under_test.lease.release_connection(TransportId(1)).await),
        RefusalCode::SystemInternalError
    );
    let reading = under_test.lease.read_holder().await;
    assert_eq!(reading.holder, None);
    assert_eq!(reading.lease_version.get(), 4);
}

#[tokio::test]
async fn force_moves_a_device_but_nothing_moves_a_run_which_hands_the_shell_back() {
    let under_test = LeaseUnderTest::open();
    let laptop = caller("device-laptop", 1, SUBSCRIPTION_1);
    let phone = caller("device-phone", 2, SUBSCRIPTION_2);
    under_test.lease.take(&laptop, false).await.expect("taken");
    under_test
        .lease
        .take(&phone, true)
        .await
        .expect("taken by force");
    assert_eq!(
        refusal_code(under_test.write(&ShellWriter::Device(laptop.clone())).await),
        RefusalCode::TerminalControlNotHeld
    );

    let command_a = run(RUN_A, "command-a");
    assert!(
        !under_test
            .lease
            .take_for_run(&command_a, || false)
            .await
            .expect("nothing fails"),
        "a run waits while something is typed at the prompt"
    );
    assert!(
        under_test
            .lease
            .take_for_run(&command_a, || true)
            .await
            .expect("taken")
    );
    let refusal = under_test
        .lease
        .take(&phone, true)
        .await
        .expect_err("no take moves a run");
    assert_eq!(refusal.code, RefusalCode::TerminalControlHeldByOther);
    let detail = refusal.detail.expect("the refusal names the run");
    assert_eq!(detail["holderDeviceId"], "device-machine");
    assert_eq!(detail["holderCommandId"], "command-a");
    assert_eq!(
        refusal_code(
            under_test
                .lease
                .admit_close(&device("device-phone"), true, || ())
                .await
        ),
        RefusalCode::TerminalControlHeldByOther
    );
    under_test
        .write(&ShellWriter::Run(command_a.run_id))
        .await
        .expect("the run writes");

    under_test
        .lease
        .release_command(&run(RUN_A, "command-b"))
        .await
        .expect("another command's end changes nothing");
    under_test
        .lease
        .release_command(&command_a)
        .await
        .expect("handed back");
    under_test
        .write(&ShellWriter::Device(phone.clone()))
        .await
        .expect("the hold kept aside writes again");

    under_test
        .lease
        .release_connection(TransportId(2))
        .await
        .expect("released");
    assert!(
        under_test
            .lease
            .take_for_run(&command_a, || true)
            .await
            .expect("taken")
    );
    under_test
        .lease
        .release_run(command_a.run_id)
        .await
        .expect("released");
    assert_eq!(
        under_test.changes(),
        vec![
            change("taken", 1, Some("device-laptop"), None),
            change(
                "takenByForce",
                2,
                Some("device-phone"),
                Some("device-laptop")
            ),
            change("taken", 3, Some("device-machine"), Some("device-phone")),
            change(
                "autoReleasedCommandEnded",
                4,
                Some("device-phone"),
                Some("device-machine")
            ),
            change("autoReleasedDisconnect", 5, None, Some("device-phone")),
            change("taken", 6, Some("device-machine"), None),
            change("autoReleasedRunIdle", 7, None, Some("device-machine")),
        ]
    );
}

#[tokio::test]
async fn only_a_bound_connection_sizes_the_shell_and_typing_binds_its_pane() {
    let under_test = LeaseUnderTest::open();
    let first_pane = caller("device-laptop", 1, SUBSCRIPTION_1);
    let second_pane = caller("device-laptop", 1, SUBSCRIPTION_2);
    let other_window = caller("device-laptop", 3, SUBSCRIPTION_3);
    under_test
        .write(&ShellWriter::Device(first_pane.clone()))
        .await
        .expect("a write takes a shell nobody holds");
    assert_eq!(
        refusal_code(
            under_test
                .lease
                .admit_from_holding_connection(&other_window.connection, || ())
                .await
        ),
        RefusalCode::TerminalControlNotHeld
    );
    assert_eq!(
        refusal_code(
            under_test
                .lease
                .admit_from_holding_connection(
                    &caller("device-phone", 2, SUBSCRIPTION_3).connection,
                    || ()
                )
                .await
        ),
        RefusalCode::TerminalControlHeldByOther
    );
    under_test
        .lease
        .admit_from_holding_connection(&first_pane.connection, || ())
        .await
        .expect("the holding connection sizes the shell");

    under_test
        .write(&ShellWriter::Device(second_pane))
        .await
        .expect("the holding connection types through another pane");
    let first = SubscriptionId::new(SUBSCRIPTION_1).expect("a subscription id");
    let second = SubscriptionId::new(SUBSCRIPTION_2).expect("a subscription id");
    under_test
        .lease
        .release_subscriptions(&[first])
        .await
        .expect("released");
    assert_eq!(
        under_test.changes().len(),
        1,
        "the pane typed through keeps the hold"
    );
    under_test
        .lease
        .release_subscriptions(&[second])
        .await
        .expect("released");
    assert_eq!(
        under_test.changes(),
        vec![
            change("taken", 1, Some("device-laptop"), None),
            change("autoReleasedPaneClosed", 2, None, Some("device-laptop")),
        ]
    );
}

#[tokio::test]
async fn writes_waiting_on_a_take_are_admitted_in_the_order_they_came() {
    let under_test = LeaseUnderTest::open();
    let laptop = ShellWriter::Device(caller("device-laptop", 1, SUBSCRIPTION_1));
    let phone = ShellWriter::Device(caller("device-phone", 2, SUBSCRIPTION_2));
    let written = Arc::new(Mutex::new(Vec::new()));
    let write = |text: &'static str| {
        let written = Arc::clone(&written);
        move || written.lock().expect("unpoisoned").push(text)
    };
    let land = under_test.hold_next_broadcast();

    // The first write takes the shell nobody holds; the rest wait in line on that take.
    let admissions = [
        under_test.lease.admit_write(&laptop, write("l")),
        under_test.lease.admit_write(&laptop, write("s")),
        under_test.lease.admit_write(&phone, write("phone")),
        under_test.lease.admit_write(&laptop, write("\n")),
    ];
    under_test.sent(1).await;
    assert!(
        written.lock().expect("unpoisoned").is_empty(),
        "no write goes before the take is broadcast"
    );
    land.send(true).expect("the broadcast waits");

    let mut answers = Vec::new();
    for admission in admissions {
        answers.push(admission.expect("each write is in line").admitted().await);
    }
    assert_eq!(*written.lock().expect("unpoisoned"), ["l", "s", "\n"]);
    assert_eq!(
        refusal_code(answers.remove(2)),
        RefusalCode::TerminalControlNotHeld
    );
    assert!(answers.into_iter().all(|answer| answer.is_ok()));
    assert_eq!(
        under_test.changes(),
        vec![change("taken", 1, Some("device-laptop"), None)]
    );
}
