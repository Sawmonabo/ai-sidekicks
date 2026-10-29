//! The permission mode a live Claude Code process runs in, as the daemon's own sends set it and as
//! Claude Code reports it, so a report the daemon's own send caused is told apart from a mode
//! changed in Claude Code itself, which is handed to the daemon to follow.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::watch;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::permission_level::claude_level_of_mode;
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::contract::ProviderReportedLevel;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::port::session_level_follower::SessionLevelFollower;

/// One live process's permission mode: the mode it runs, last acknowledged; the daemon's
/// `set_permission_mode` sends in flight, counted per mode; and Claude Code's newest report.
pub(crate) struct ClaudePermissionModeRecord {
    sends: Mutex<ClaudePermissionModeSends>,
    newest_report: watch::Sender<Option<ClaudePermissionMode>>,
    // The unknown mode words already logged on this process's connection.
    unknown_reports: Mutex<OnceReportedDiagnostics>,
}

// The mode the process runs and the daemon's sends not yet settled, behind one lock.
struct ClaudePermissionModeSends {
    running: ClaudePermissionMode,
    in_flight: HashMap<ClaudePermissionMode, usize>,
}

impl ClaudePermissionModeRecord {
    /// The record of a process started in `running`, with no report yet.
    pub(crate) fn new(running: ClaudePermissionMode) -> Self {
        Self {
            sends: Mutex::new(ClaudePermissionModeSends {
                running,
                in_flight: HashMap::new(),
            }),
            newest_report: watch::Sender::new(None),
            unknown_reports: Mutex::default(),
        }
    }

    /// Counts a `set_permission_mode` to `mode` in flight until the guard settles: acknowledged,
    /// `mode` becomes the mode the process runs; dropped, as on a failed send, it only settles.
    pub(crate) fn begin_send(&self, mode: ClaudePermissionMode) -> ClaudePermissionModeSend<'_> {
        *lock(&self.sends).in_flight.entry(mode).or_default() += 1;
        ClaudePermissionModeSend {
            record: self,
            mode,
            is_settled: false,
        }
    }

    /// Takes the mode word Claude Code reported on a `raw_wire_type` frame as its newest report,
    /// storing it and awaiting nothing. A word that names no mode is never taken as one and is
    /// logged once per connection against `provider_account_id`.
    pub(crate) fn note_report(
        &self,
        word: &str,
        raw_wire_type: &str,
        provider_account_id: &ProviderAccountId,
    ) {
        match word.parse::<ClaudePermissionMode>() {
            Ok(mode) => {
                self.newest_report.send_replace(Some(mode));
            }
            Err(_) => {
                lock(&self.unknown_reports).report(&DriverDiagnosticRecord {
                    provider: DESCRIPTOR.provider_id(),
                    provider_account_id: Some(provider_account_id.clone()),
                    kind: DriverDiagnosticKind::PermissionModeUnknown,
                    raw_wire_type: Some(raw_wire_type.to_owned()),
                    disposition_reason: "Claude Code reported a permission mode the driver does \
                                         not know, so it is not taken as a mode"
                        .to_owned(),
                    details: Map::from_iter([("permissionMode".to_owned(), Value::from(word))]),
                });
            }
        }
    }

    /// Takes `mode`, which Claude Code reported running and the daemon followed, as the mode the
    /// process runs, so that report no longer reads as Claude Code's own.
    pub(crate) fn adopt_report(&self, mode: ClaudePermissionMode) {
        lock(&self.sends).running = mode;
    }

    /// A receiver woken on each of Claude Code's reports, which ends once the record drops.
    pub(crate) fn report_changes(&self) -> watch::Receiver<Option<ClaudePermissionMode>> {
        self.newest_report.subscribe()
    }

    /// The mode Claude Code last reported, whoever caused it; `None` before any report.
    pub(crate) fn newest_report(&self) -> Option<ClaudePermissionMode> {
        *self.newest_report.borrow()
    }

    /// The level and session mode Claude Code's newest report moved the session to, when Claude
    /// Code itself moved it: `None` with no report, or while the report equals the mode the
    /// process runs or a mode the daemon's own send has in flight, since that report is the
    /// daemon's own.
    pub(crate) fn reported_level(&self) -> Option<ProviderReportedLevel> {
        let reported = self.newest_report()?;
        let sends = lock(&self.sends);
        if reported == sends.running || sends.in_flight.contains_key(&reported) {
            return None;
        }
        drop(sends);
        let (level, session_mode) = claude_level_of_mode(reported);
        Some(ProviderReportedLevel {
            level,
            session_mode,
        })
    }

    // Settles one send of `mode`, which becomes the mode the process runs when acknowledged. A
    // failed send wakes the follow on the report it held, which no longer reads as the daemon's.
    fn settle(&self, mode: ClaudePermissionMode, is_acknowledged: bool) {
        let mut sends = lock(&self.sends);
        if is_acknowledged {
            sends.running = mode;
        }
        if let Some(count) = sends.in_flight.get_mut(&mode) {
            *count -= 1;
            if *count == 0 {
                sends.in_flight.remove(&mode);
            }
        }
        drop(sends);
        if !is_acknowledged {
            self.newest_report
                .send_if_modified(|report| report.is_some());
        }
    }
}

/// Hands each of `session_id`'s reports that reads as Claude Code's own to the registered
/// follower, until `record` drops at the process's close; with no follower registered the report
/// is dropped, and a failed follow is logged. Holds the record weakly, so it never keeps it alive.
pub(crate) async fn follow_claude_reported_levels(
    record: Weak<ClaudePermissionModeRecord>,
    mut reports: watch::Receiver<Option<ClaudePermissionMode>>,
    session_id: SessionId,
    followers: Arc<PortRegistration<Arc<dyn SessionLevelFollower>>>,
) {
    while reports.changed().await.is_ok() {
        let Some(record) = record.upgrade() else {
            break;
        };
        // A report the daemon's own send explains is not followed.
        if record.reported_level().is_none() {
            continue;
        }
        drop(record);
        let Some(follower) = followers.port().cloned() else {
            continue;
        };
        if let Err(error) = follower.follow_reported_level(session_id).await {
            record_unheard_claude_failure(
                DriverDiagnosticKind::DeliveryDispatchFailed,
                Some(session_id),
                "the follow of a reported level",
                error.as_ref(),
            );
        }
    }
}

/// One `set_permission_mode` send in flight, settled once: by [`Self::acknowledge`] on Claude
/// Code's success reply, else when dropped.
pub(crate) struct ClaudePermissionModeSend<'a> {
    record: &'a ClaudePermissionModeRecord,
    mode: ClaudePermissionMode,
    is_settled: bool,
}

impl ClaudePermissionModeSend<'_> {
    /// Settles the send as taken: its mode is the mode the process runs from now.
    pub(crate) fn acknowledge(mut self) {
        self.is_settled = true;
        self.record.settle(self.mode, true);
    }
}

impl Drop for ClaudePermissionModeSend<'_> {
    fn drop(&mut self) {
        if !self.is_settled {
            self.record.settle(self.mode, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

    use super::{ClaudePermissionModeRecord, ClaudePermissionModeSend};
    use crate::driver::claude::session::transport::control::ClaudePermissionMode;
    use crate::driver::contract::ProviderReportedLevel;
    use crate::driver::diagnostics::RecordedEvents;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A step of a session's life as the record sees it.
    #[derive(Clone, Copy)]
    enum Step {
        // The daemon sends the mode and Claude Code has not yet replied.
        Send(ClaudePermissionMode),
        // Claude Code acknowledges every send in flight.
        AcknowledgeAll,
        // Every send in flight fails.
        FailAll,
        // Claude Code reports a mode word.
        Report(&'static str),
    }

    const UNKNOWN_MODE_COUNTER: &str = "driver.permissionMode.unknown";

    // Killed by dropping the in-flight check (the report of a send not yet acknowledged reads as
    // Claude Code's own), by a failed send that never settles (its mode stays the daemon's), by
    // reading the first report rather than the newest, by mapping `plan` to a level, by reading
    // `manual` as no mode, and by taking an unknown word as a mode or not logging it.
    #[rstest]
    #[case::report_of_a_mode_in_flight(
        &[Step::Send(ClaudePermissionMode::Auto), Step::Report("auto")],
        None,
        0,
    )]
    #[case::report_after_its_acknowledgment(
        &[Step::Send(ClaudePermissionMode::Auto), Step::AcknowledgeAll, Step::Report("auto")],
        None,
        0,
    )]
    #[case::the_same_report_after_a_failed_send(
        &[Step::Send(ClaudePermissionMode::Auto), Step::FailAll, Step::Report("auto")],
        Some((Some(PermissionLevel::Reviewed), SessionMode::Build)),
        0,
    )]
    #[case::another_mode_while_one_is_in_flight(
        &[Step::Send(ClaudePermissionMode::Auto), Step::Report("bypassPermissions")],
        Some((Some(PermissionLevel::Yolo), SessionMode::Build)),
        0,
    )]
    #[case::only_the_newest_of_two_reports(
        &[Step::Report("bypassPermissions"), Step::Report("acceptEdits")],
        Some((Some(PermissionLevel::Ask), SessionMode::Build)),
        0,
    )]
    #[case::plan_is_never_a_level(
        &[Step::Report("plan")],
        Some((None, SessionMode::Plan)),
        0,
    )]
    #[case::manual_is_read_only(
        &[Step::Send(ClaudePermissionMode::Auto), Step::AcknowledgeAll, Step::Report("manual")],
        Some((Some(PermissionLevel::Readonly), SessionMode::Build)),
        0,
    )]
    #[case::an_unknown_word(&[Step::Report("delegate")], None, 1)]
    fn a_report_reads_as_claude_codes_own_only_when_no_send_of_the_daemon_explains_it(
        #[case] steps: &[Step],
        #[case] expected: Option<(Option<PermissionLevel>, SessionMode)>,
        #[case] unknown_mode_diagnostics: usize,
    ) {
        // The process starts in Read-only's mode.
        let record = ClaudePermissionModeRecord::new(ClaudePermissionMode::Default);
        let account = test_provider_account_id();
        let events = RecordedEvents::default();
        events.record_during(|| {
            let mut in_flight = Vec::new();
            for step in steps {
                match *step {
                    Step::Send(mode) => in_flight.push(record.begin_send(mode)),
                    Step::AcknowledgeAll => in_flight
                        .drain(..)
                        .for_each(ClaudePermissionModeSend::acknowledge),
                    Step::FailAll => in_flight.clear(),
                    Step::Report(word) => record.note_report(word, "system/status", &account),
                }
            }
            assert_eq!(
                record.reported_level(),
                expected.map(|(level, session_mode)| ProviderReportedLevel {
                    level,
                    session_mode,
                }),
            );
        });

        assert_eq!(
            events
                .counters()
                .iter()
                .filter(|counter| *counter == UNKNOWN_MODE_COUNTER)
                .count(),
            unknown_mode_diagnostics,
        );
        if unknown_mode_diagnostics > 0 {
            assert_eq!(record.newest_report(), None);
        }
    }

    // A send that fails while Claude Code's report of its mode is held wakes the follow, since the
    // report now reads as Claude Code's own; an acknowledged send wakes nothing. Killed by not
    // waking the follow on a failed send.
    #[rstest]
    #[case::failed(false, true)]
    #[case::acknowledged(true, false)]
    fn a_failed_send_wakes_the_follow_on_the_report_it_held(
        #[case] is_acknowledged: bool,
        #[case] is_woken: bool,
    ) {
        let record = ClaudePermissionModeRecord::new(ClaudePermissionMode::Default);
        let mut reports = record.report_changes();
        let send = record.begin_send(ClaudePermissionMode::Auto);
        record.note_report("auto", "system/status", &test_provider_account_id());
        reports.borrow_and_update();
        assert_eq!(record.reported_level(), None);

        if is_acknowledged {
            send.acknowledge();
        } else {
            drop(send);
        }

        assert_eq!(
            reports.has_changed().expect("the record still stands"),
            is_woken
        );
        assert_eq!(record.reported_level().is_some(), is_woken);
    }
}
