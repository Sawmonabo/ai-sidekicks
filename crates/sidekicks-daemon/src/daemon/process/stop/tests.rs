use std::path::PathBuf;

use rstest::rstest;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;

use super::DaemonStopReason::{self, Erase, Restart, Stop};
use crate::daemon::process::database::DatabaseFileOpenError;
use crate::daemon::process::start::error::DaemonStartError;
use crate::daemon::start_stopped_error::DaemonStartStoppedError;

// Each ask's reason and the intent the drivers are told for it: the person's stop replaces a
// restart and every other later ask keeps the first; a start the person's stop cut short on
// the repairing socket stops, and any other failed start restarts; a stop and an erase end
// every service. Killed by a failed start's release left on `Stop`, by an erase that tells the
// drivers `Restart`, and by a stop that does not replace a restart.
#[rstest]
#[case::a_stop_replaces_a_restart(Restart.joined(Stop), Stop, DaemonStopIntent::Stop)]
#[case::a_restart_keeps_a_stop(Stop.joined(Restart), Stop, DaemonStopIntent::Stop)]
#[case::an_erase_keeps_a_restart(Restart.joined(Erase), Restart, DaemonStopIntent::Restart)]
#[case::a_stop_keeps_an_erase(Erase.joined(Stop), Erase, DaemonStopIntent::Stop)]
#[case::a_restart_keeps_an_erase(Erase.joined(Restart), Erase, DaemonStopIntent::Stop)]
#[case::an_erase_keeps_a_stop(Stop.joined(Erase), Stop, DaemonStopIntent::Stop)]
#[case::a_start_the_person_stopped_in_its_repair(
    DaemonStopReason::of_failed_start(&DaemonStartError::DatabaseFile(
        DatabaseFileOpenError::Stopped(Stop)
    )),
    Stop,
    DaemonStopIntent::Stop
)]
#[case::a_start_another_build_failed(
    DaemonStopReason::of_failed_start(&DaemonStartError::DatabaseFile(
        DatabaseFileOpenError::SavedSessionsFromAnotherVersion {
            path: PathBuf::from("store")
        }
    )),
    Restart,
    DaemonStopIntent::Restart
)]
#[case::a_start_a_stop_cut_short_past_its_repair(
    DaemonStopReason::of_failed_start(&DaemonStartError::Stopped(DaemonStartStoppedError {
        step: "binding the socket"
    })),
    Restart,
    DaemonStopIntent::Restart
)]
fn each_stop_ask_maps_to_its_reason(
    #[case] reason: DaemonStopReason,
    #[case] expected: DaemonStopReason,
    #[case] intent: DaemonStopIntent,
) {
    assert_eq!(reason, expected);
    assert_eq!(reason.driver_intent(), intent);
}

// Asks joined where they land, over the socket or the repairing socket: the first ask is taken,
// the person's stop replaces a restart asked before it, and a restart asked after a stop keeps the
// stop and changes nothing. Killed by the first ask winning and by a kept ask told as a change.
#[test]
fn each_ask_joins_the_one_held() {
    let mut asked = None;

    let changes =
        [Restart, Stop, Restart].map(|reason| DaemonStopReason::join_ask(&mut asked, reason));

    assert_eq!(changes, [true, true, false]);
    assert_eq!(asked, Some(Stop));
}
