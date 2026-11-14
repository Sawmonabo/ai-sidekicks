use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::daemon::service_status::{
    DaemonCannotStart, DaemonCannotStop, DaemonStopStep, ServiceStatusFile,
};
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, process_identity};
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_std::scheduler::{JobCondition, ScheduledJobHandle, ScheduledJobOutcome, Scheduler};
use sidekicks_std::settle_all::SettleFailures;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{STOP_WAIT, TestHome};
use crate::daemon::process::DAEMON_STOP_DRAIN_BOUND;
use crate::daemon::process::database::DatabaseFileOpenError;
use crate::daemon::process::start::error::DaemonStartError;
use crate::daemon::process::stop::{
    DaemonStopFailure, DaemonStopReason, close_data_folder, stop_work,
};
use crate::daemon::service_status::record_start_failure;

// How the started daemon stops.
#[derive(Clone, Copy, Debug)]
enum Case {
    // `daemon.stop`, held at the scheduler's step.
    Stop,
    // `daemon.restart`, held at the scheduler's step.
    Restart,
    // `daemon.stop`, held inside the drivers' shutdown.
    DriversHeld,
    // `daemon.stop` with a folder where the intent's file goes.
    UnsavedIntent,
    // The erase's step that ends the work, held at the scheduler's step, then the erase's close
    // and the stop that follows it.
    EraseStep,
    // A failed start's release, held at the scheduler's step.
    FailedStart,
}

// The scheduler's job that holds the stop at its step: it reports once the stop cancels its token,
// then holds until released.
struct SchedulerHold {
    // Kept so the job stays scheduled.
    _job: ScheduledJobHandle,
    // Answers once the stop has reached the scheduler's step.
    stop_reached: oneshot::Receiver<()>,
    // Ends the hold.
    release: oneshot::Sender<()>,
}

impl SchedulerHold {
    // Schedules the hold on `scheduler` and waits until the job runs.
    async fn start(scheduler: &Scheduler) -> Self {
        let (started, job_started) = oneshot::channel();
        let (step_begun, stop_reached) = oneshot::channel();
        let (release, released) = oneshot::channel::<()>();
        let mut job = Some((started, step_begun, released));
        let held = scheduler
            .schedule(
                "held test job",
                JobCondition::Always,
                Duration::ZERO,
                move |token| {
                    let (started, step_begun, released) = job.take().expect("the job runs once");
                    Box::pin(async move {
                        started.send(()).expect("the test waits for the start");
                        token.cancelled().await;
                        step_begun.send(()).expect("the test waits for the stop");
                        // A release dropped ends the hold as well.
                        released.await.unwrap_or_default();
                        ScheduledJobOutcome::Ok(())
                    })
                },
            )
            .expect("the job is scheduled");
        tokio::time::timeout(STOP_WAIT, job_started)
            .await
            .expect("the job starts")
            .expect("the job reports its start");
        Self {
            _job: held,
            stop_reached,
            release,
        }
    }

    // Waits for the stop to reach the scheduler's step, reads the status file there, then ends
    // the hold.
    async fn read_at_hold(self, home: &TestHome) -> Option<ServiceStatusFile> {
        tokio::time::timeout(STOP_WAIT, self.stop_reached)
            .await
            .expect("the stop reaches the scheduler")
            .expect("the job reports the stop");
        let status = read_status(home);
        // The job is gone once the bound ended it.
        self.release.send(()).unwrap_or_default();
        status
    }
}

// The status file `home`'s daemon wrote, `None` where there is none.
fn read_status(home: &TestHome) -> Option<ServiceStatusFile> {
    match std::fs::read(&home.run_folder.status_path) {
        Ok(bytes) => Some(serde_json::from_slice(&bytes).expect("the status file parses")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => panic!("the status file could not be read: {error}"),
    }
}

// The error a start fails with on saved sessions from another version.
fn another_version() -> DaemonStartError {
    DaemonStartError::DatabaseFile(DatabaseFileOpenError::SavedSessionsFromAnotherVersion {
        path: PathBuf::from("store"),
    })
}

// Each stop of a running service records its steps, a Stop and a Restart alike: at the
// scheduler's step the file names that step, this process and when the stop began, inside the
// drivers' shutdown it names the providers' step, and the stop's return removes it, unless the
// intent could not be saved, which leaves `cannotStop`. The erase's step and a failed start's
// release record no step, nor does the stop after the erase let the lock go, and the release
// leaves why the start failed. Killed by the record not written or written after the step's wait
// (the file names an earlier step), by the providers' step not written (the file names the search
// index's), by the record left behind, by the failed stop's record removed, by the record begun in
// `stop_work` or begun past the lock's release, so the erase writes it, by the record begun only
// for the person's Stop, and by the release recording no start failure.
#[rstest]
#[case::stop(Case::Stop)]
#[case::restart(Case::Restart)]
#[case::drivers_held(Case::DriversHeld)]
#[case::unsaved_intent(Case::UnsavedIntent)]
#[case::erase_step(Case::EraseStep)]
#[case::failed_start(Case::FailedStart)]
#[tokio::test(flavor = "multi_thread")]
async fn each_stop_of_a_running_service_records_its_steps_and_ends_with_one_fact(
    #[case] case: Case,
) {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let mut process = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");
    let scheduler = Arc::clone(
        process
            .scheduler
            .as_ref()
            .expect("the daemon runs its scheduler"),
    );

    match case {
        Case::Stop | Case::Restart => {
            let reason = if matches!(case, Case::Stop) {
                DaemonStopReason::Stop
            } else {
                DaemonStopReason::Restart
            };
            let hold = SchedulerHold::start(&scheduler).await;
            let before = jiff::Timestamp::now().as_millisecond();
            let (_stopped, (at_hold, after)) = tokio::join!(process.stop(reason), async {
                let at_hold = hold.read_at_hold(&home).await;
                (at_hold, jiff::Timestamp::now().as_millisecond())
            });

            let Some(ServiceStatusFile::Stopping(stopping)) = at_hold else {
                panic!("the file names the stop under way: {at_hold:?}");
            };
            assert_eq!(stopping.step, DaemonStopStep::Scheduler);
            assert_eq!(
                stopping.process,
                process_identity(std::process::id())
                    .expect("this process reads")
                    .expect("this process runs")
            );
            let stop_started = stopping
                .stop_started
                .unix_millisecond()
                .expect("the stop's start parses");
            assert!(
                (before..=after).contains(&stop_started),
                "{before} <= {stop_started} <= {after}"
            );
            assert_eq!(
                read_status(&home),
                None,
                "the stop's return removes the record"
            );
        }
        Case::DriversHeld => {
            let (reached, shutdown_reached) = oneshot::channel();
            let (release, released) = oneshot::channel::<()>();
            let mut gate = Some((reached, released));
            let mut driver = MockProviderDriver::new();
            driver
                .expect_shutdown()
                .times(1)
                .returning(move |_intent, _deadline| {
                    let (reached, released) = gate.take().expect("the drivers shut down once");
                    async move {
                        reached.send(()).expect("the test waits for the shutdown");
                        // A release dropped ends the hold as well.
                        released.await.unwrap_or_default();
                    }
                    .boxed()
                });
            // The stop shuts down this driver in place of the ones the start built.
            process
                .providers
                .as_mut()
                .expect("the start keeps the providers")
                .registry = Arc::new(registry_of_first_provider(Arc::new(driver)));

            let (_stopped, at_hold) = tokio::join!(process.stop(DaemonStopReason::Stop), async {
                tokio::time::timeout(STOP_WAIT, shutdown_reached)
                    .await
                    .expect("the stop reaches the drivers")
                    .expect("the driver reports its shutdown");
                let status = read_status(&home);
                release.send(()).expect("the driver waits for the release");
                status
            });

            let Some(ServiceStatusFile::Stopping(stopping)) = at_hold else {
                panic!("the file names the stop under way: {at_hold:?}");
            };
            assert_eq!(stopping.step, DaemonStopStep::Providers);
            assert_eq!(
                read_status(&home),
                None,
                "the stop's return removes the record"
            );
        }
        Case::UnsavedIntent => {
            std::fs::create_dir(process.stop_intent.path())
                .expect("a folder takes the file's place");

            let stopped = process.stop(DaemonStopReason::Stop).await;

            let failures = match stopped {
                Ok(()) => Vec::new(),
                Err(SettleFailures::One(failure)) => vec![failure],
                Err(SettleFailures::Many { failures, .. }) => failures,
            };
            assert!(
                failures
                    .iter()
                    .any(|failure| matches!(failure, DaemonStopFailure::StopIntent(_))),
                "{failures:?}"
            );
            assert_eq!(
                read_status(&home),
                Some(ServiceStatusFile::CannotStop(
                    DaemonCannotStop::StopIntent {}
                ))
            );
        }
        Case::EraseStep => {
            let hold = SchedulerHold::start(&scheduler).await;
            let (_failures, at_hold) = tokio::join!(
                stop_work(
                    &mut process,
                    DaemonStopReason::Erase,
                    DAEMON_STOP_DRAIN_BOUND
                ),
                hold.read_at_hold(&home)
            );
            drop(close_data_folder(&mut process).await);
            let after_close = read_status(&home);
            // What a start that took the freed lock would leave; the stop that follows, whose git
            // trees' step is still there to run, must not replace or remove it.
            record_start_failure(&home.run_folder, &another_version()).await;
            drop(process.stop(DaemonStopReason::Erase).await);

            assert_eq!(at_hold, None, "the erase's step writes no record");
            assert_eq!(after_close, None);
            assert_eq!(
                read_status(&home),
                Some(ServiceStatusFile::CannotStart(
                    DaemonCannotStart::SavedSessionsFromAnotherVersion {}
                )),
                "the stop after the erase writes nothing"
            );
        }
        Case::FailedStart => {
            let hold = SchedulerHold::start(&scheduler).await;
            let (_release, at_hold) =
                tokio::join!(process.release(another_version()), hold.read_at_hold(&home));

            assert_eq!(at_hold, None, "the release records no step");
            assert_eq!(
                read_status(&home),
                Some(ServiceStatusFile::CannotStart(
                    DaemonCannotStart::SavedSessionsFromAnotherVersion {}
                ))
            );
        }
    }
}
