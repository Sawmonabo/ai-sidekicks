use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use sidekicks_contracts::daemon::service_status::{
    DaemonCannotStart, DaemonCannotStop, DaemonStopStep, ServiceStatusFile,
};
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, process_identity};
use sidekicks_std::scheduler::{JobCondition, ScheduledJobHandle, ScheduledJobOutcome, Scheduler};
use sidekicks_std::settle_all::SettleFailures;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{STOP_WAIT, TestHome};
use crate::daemon::process::DAEMON_STOP_DRAIN_BOUND;
use crate::daemon::process::database::DatabaseFileOpenError;
use crate::daemon::process::start_error::DaemonStartError;
use crate::daemon::process::stop::{
    DaemonStopFailure, DaemonStopReason, close_data_folder, stop_work,
};
use crate::daemon::service_status::record_start_failure;

// How the started daemon stops.
#[derive(Clone, Copy, Debug)]
enum Case {
    // `daemon.stop`, held at the scheduler's step.
    Stop,
    // `daemon.stop` with a folder where the intent's file goes.
    UnsavedIntent,
    // The erase's step that ends the work, held at the scheduler's step.
    EraseStep,
    // A failed start's release, held at the scheduler's step, then the start's own record.
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

// Only the person's Stop records its steps: at the scheduler's step the file names that step,
// this process and when the stop began, and the stop's return removes it, unless the intent could
// not be saved, which leaves `cannotStop`. The erase's step and a failed start's release write
// nothing, and the start's own record stands after the release. Killed by the record not written
// or written after the step's wait (the file names an earlier step), by the record left behind, by
// the failed stop's record removed, by the record begun in `stop_work`, so the erase writes it,
// and by the release handed the record.
#[rstest]
#[case::stop(Case::Stop)]
#[case::unsaved_intent(Case::UnsavedIntent)]
#[case::erase_step(Case::EraseStep)]
#[case::failed_start(Case::FailedStart)]
#[tokio::test(flavor = "multi_thread")]
async fn only_the_stop_records_its_steps_and_it_ends_with_one_fact(#[case] case: Case) {
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
        Case::Stop => {
            let hold = SchedulerHold::start(&scheduler).await;
            let before = jiff::Timestamp::now().as_millisecond();
            let (_stopped, (at_hold, after)) =
                tokio::join!(process.stop(DaemonStopReason::Stop), async {
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

            assert_eq!(at_hold, None, "the erase's step writes no record");
            assert_eq!(read_status(&home), None);
        }
        Case::FailedStart => {
            let hold = SchedulerHold::start(&scheduler).await;
            let (_release, at_hold) =
                tokio::join!(process.release(another_version()), hold.read_at_hold(&home));
            record_start_failure(&home.run_folder, &another_version());

            assert_eq!(at_hold, None, "the release writes no record");
            assert_eq!(
                read_status(&home),
                Some(ServiceStatusFile::CannotStart(
                    DaemonCannotStart::SavedSessionsFromAnotherVersion {}
                ))
            );
        }
    }
}
