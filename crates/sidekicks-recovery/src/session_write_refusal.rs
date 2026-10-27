//! The one refusal a session with damaged history, or one the restart's pass is still rebuilding,
//! gives each write: at the wire for a call that names it, and at the append for every event of
//! it, whoever writes and however the writer found the session, until the pass comes to settle the
//! session's runs.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::recovery::SessionHistoryDamagedRecovery;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_store::events::log_service::SessionAppendRefusal;
use sidekicks_store::events::session::skipped_ranges::DAMAGED_EVENTS_SKIPPED_TYPE;

use crate::status::{RecoveryStatusTracker, SessionWriteRefusal};

/// Refuses a call naming the session with `session.rebuilding` while the restart's pass is still
/// rebuilding it, or `session.history.damaged` once its history is damaged; `method` names the
/// call refused.
pub(crate) fn refuse_call_naming_session(
    tracker: &RecoveryStatusTracker,
    session_id: &SessionId,
    method: &str,
) -> Result<(), DomainError> {
    tracker
        .read_session_call_refusal(session_id)
        .map_or(Ok(()), |refusal| {
            Err(session_write_refusal(refusal, method).into())
        })
}

/// Refuses an event of a session whose history is damaged with `session.history.damaged`, except
/// the one event that continues it from its last good point, and an event of a session the
/// restart's pass is still rebuilding and has yet to settle the runs of with `session.rebuilding`.
pub fn refuse_session_event(
    tracker: &RecoveryStatusTracker,
    session_id: &SessionId,
    event_type: &str,
) -> Result<(), SessionAppendRefusal> {
    if event_type == DAMAGED_EVENTS_SKIPPED_TYPE.as_str() {
        return Ok(());
    }
    tracker
        .read_session_append_refusal(session_id)
        .map_or(Ok(()), |refusal| {
            Err(session_write_refusal(refusal, event_type))
        })
}

fn session_write_refusal(refusal: SessionWriteRefusal, write: &str) -> SessionAppendRefusal {
    match refusal {
        SessionWriteRefusal::Rebuilding(details) => SessionAppendRefusal::Rebuilding {
            message: format!(
                "Session {} is not taking {write}: the restart's recovery is rebuilding it",
                details.session_id
            ),
            details,
        },
        SessionWriteRefusal::HistoryDamaged(details) => {
            let damage = match details.recovery {
                SessionHistoryDamagedRecovery::Degraded => "degraded",
                SessionHistoryDamagedRecovery::Damaged => "damaged",
            };
            SessionAppendRefusal::HistoryDamaged {
                message: format!(
                    "Session {} is not taking {write}: its history is damaged ({damage})",
                    details.session_id
                ),
                details,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::daemon::recovery::DaemonWriteRefusedRecovery;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_store::events::session::skipped_ranges::DAMAGED_EVENTS_SKIPPED_TYPE;

    use super::{refuse_call_naming_session, refuse_session_event};
    use crate::status::{LastGoodPoint, RecoveryStatusTracker};

    const METHOD: &str = "agent.run.create";
    const EVENT_TYPE: &str = "agent.message.sent";

    // Where the pass and the session stand when a write arrives.
    #[derive(Clone, Copy, Debug)]
    enum Stage {
        // The pass has yet to list the sessions it must rebuild.
        Listing,
        // The pass listed the session as one it must rebuild.
        Listed,
        // The pass settles the listed session's runs.
        Settling,
        // The pass ended with the session open at its last good point.
        EndedDegraded,
        // The pass ended with no event of the session readable.
        EndedUnreadable,
        // The local store failed after the pass ended.
        StoreFailed,
    }

    fn tracker_at(stage: Stage, session_id: &SessionId) -> RecoveryStatusTracker {
        let tracker = RecoveryStatusTracker::new();
        match stage {
            Stage::Listing => {}
            Stage::Listed => {
                tracker.mark_session_rebuilding(session_id);
                tracker.mark_pass_listed();
            }
            Stage::Settling => {
                tracker.mark_session_rebuilding(session_id);
                tracker.mark_pass_listed();
                tracker.mark_session_settling(session_id);
            }
            Stage::EndedDegraded => {
                tracker.mark_session_at_last_good_point(
                    session_id,
                    LastGoodPoint {
                        last_sequence: SafeInt::new(4).expect("4 is a safe integer"),
                        last_occurred_at: WireInstant::try_from(
                            "2026-10-14T09:30:00.000Z".to_owned(),
                        )
                        .expect("the instant is well formed"),
                        damaged_from_sequence: SafeInt::new(5).expect("5 is a safe integer"),
                    },
                );
                tracker.mark_pass_ended();
            }
            Stage::EndedUnreadable => {
                tracker.mark_session_unreadable(session_id);
                tracker.mark_pass_ended();
            }
            Stage::StoreFailed => {
                tracker.mark_pass_ended();
                tracker.mark_store_failed();
            }
        }
        tracker
    }

    // Each stage's answer to a call naming the session, to an event of it, and to the whole
    // daemon's write of a call that names a session and of one that names none, whose refusal is
    // `daemon.writeRefused`.
    #[rstest]
    #[case::listing(
        Stage::Listing,
        None,
        None,
        Some(DaemonWriteRefusedRecovery::Rebuilding),
        Some(DaemonWriteRefusedRecovery::Rebuilding)
    )]
    #[case::listed(
        Stage::Listed,
        Some((RefusalCode::SessionRebuilding, None)),
        Some((RefusalCode::SessionRebuilding, None)),
        None,
        Some(DaemonWriteRefusedRecovery::Rebuilding)
    )]
    #[case::settling(
        Stage::Settling,
        Some((RefusalCode::SessionRebuilding, None)),
        None,
        None,
        Some(DaemonWriteRefusedRecovery::Rebuilding)
    )]
    #[case::ended_degraded(
        Stage::EndedDegraded,
        Some((RefusalCode::SessionHistoryDamaged, Some("degraded"))),
        Some((RefusalCode::SessionHistoryDamaged, Some("degraded"))),
        None,
        None
    )]
    #[case::ended_unreadable(
        Stage::EndedUnreadable,
        Some((RefusalCode::SessionHistoryDamaged, Some("damaged"))),
        Some((RefusalCode::SessionHistoryDamaged, Some("damaged"))),
        None,
        None
    )]
    #[case::store_failed(
        Stage::StoreFailed,
        None,
        None,
        Some(DaemonWriteRefusedRecovery::Blocked),
        Some(DaemonWriteRefusedRecovery::Blocked)
    )]
    fn refuses_each_write_by_where_the_session_stands(
        #[case] stage: Stage,
        #[case] call_refusal: Option<(RefusalCode, Option<&str>)>,
        #[case] event_refusal: Option<(RefusalCode, Option<&str>)>,
        #[case] daemon_refusal: Option<DaemonWriteRefusedRecovery>,
        #[case] daemon_refusal_naming_none: Option<DaemonWriteRefusedRecovery>,
    ) {
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let tracker = tracker_at(stage, &session_id);

        let refusal_of = |answer: Result<(), DomainError>| {
            answer.err().map(|error| {
                let detail = error
                    .detail
                    .expect("a session's refusal carries its fields");
                assert_eq!(detail.get("sessionId"), Some(&json!(session_id)));
                let recovery = detail.get("recovery").map(|recovery| {
                    recovery
                        .as_str()
                        .expect("a refusal's recovery is text")
                        .to_owned()
                });
                (error.code, recovery)
            })
        };
        let expected = |refusal: Option<(RefusalCode, Option<&str>)>| {
            refusal.map(|(code, recovery)| (code, recovery.map(str::to_owned)))
        };
        assert_eq!(
            refusal_of(refuse_call_naming_session(&tracker, &session_id, METHOD)),
            expected(call_refusal),
            "a call naming the session"
        );
        assert_eq!(
            refusal_of(
                refuse_session_event(&tracker, &session_id, EVENT_TYPE).map_err(DomainError::from)
            ),
            expected(event_refusal),
            "an event of the session"
        );
        // The event that continues a damaged session from its last good point always passes.
        assert!(
            refuse_session_event(&tracker, &session_id, DAMAGED_EVENTS_SKIPPED_TYPE.as_str())
                .is_ok()
        );
        assert_eq!(
            tracker.read_daemon_write_refusal(true),
            daemon_refusal,
            "the daemon's write of a call naming a session"
        );
        assert_eq!(
            tracker.read_daemon_write_refusal(false),
            daemon_refusal_naming_none,
            "the daemon's write of a call naming no session"
        );
    }
}
