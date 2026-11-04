//! Where the session of a tool call receipt the stop left in flight stands, as the recovery pass
//! knows it: the restart's sweep resumes each receipt by this answer.

use std::collections::BTreeSet;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_mcp::client::dispatch::restart_sweep::McpReceiptSession;
use sidekicks_session::run::read::RunRead;

use crate::stop_intent::StopIntent;

/// Where the session of a receipt's `run` stands: missing with no row, damaged when it is among
/// `damaged`, stopped when `snapshot`, the intent the pass read at its start, names it, and
/// otherwise going on.
pub(super) fn receipt_session(
    run: Option<&RunRead>,
    snapshot: Option<&StopIntent>,
    damaged: &BTreeSet<SessionId>,
) -> McpReceiptSession {
    match run {
        None => McpReceiptSession::Missing,
        Some(run) if damaged.contains(&run.session_id) => McpReceiptSession::Damaged,
        Some(run) if snapshot.is_some_and(|intent| intent.names(&run.session_id)) => {
            McpReceiptSession::Stopped(run.session_id)
        }
        Some(run) => McpReceiptSession::Continues(run.session_id),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use rstest::rstest;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_mcp::client::dispatch::restart_sweep::McpReceiptSession;
    use sidekicks_session::run::read::RunRead;

    use super::receipt_session;
    use crate::stop_intent::StopIntent;

    // The intent the pass read at its start, as each case gives it.
    #[derive(Clone, Copy, Debug)]
    enum Snapshot {
        Absent,
        Whole,
        NamingTheSession,
        NamingAnother,
    }

    // The answer each case expects, the session filled in by the test.
    #[derive(Clone, Copy, Debug)]
    enum Expected {
        Missing,
        Damaged,
        Continues,
        Stopped,
    }

    fn mint_session_id() -> SessionId {
        SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is an id")
    }

    #[rstest]
    #[case::a_run_with_no_row(false, false, Snapshot::Whole, Expected::Missing)]
    #[case::a_damaged_session(true, true, Snapshot::Absent, Expected::Damaged)]
    #[case::no_intent(true, false, Snapshot::Absent, Expected::Continues)]
    #[case::a_whole_intent(true, false, Snapshot::Whole, Expected::Stopped)]
    #[case::an_intent_naming_it(true, false, Snapshot::NamingTheSession, Expected::Stopped)]
    #[case::an_intent_naming_another(true, false, Snapshot::NamingAnother, Expected::Continues)]
    fn a_receipt_s_session_reads_the_snapshot_and_the_damaged_sessions(
        #[case] has_row: bool,
        #[case] is_damaged: bool,
        #[case] snapshot: Snapshot,
        #[case] expected: Expected,
    ) {
        let session_id = mint_session_id();
        let run = RunRead {
            version: 1,
            session_id,
            state: RunState::Running,
        };
        let damaged = if is_damaged {
            BTreeSet::from([session_id])
        } else {
            BTreeSet::new()
        };
        let intent = match snapshot {
            Snapshot::Absent => None,
            Snapshot::Whole => Some(StopIntent::Whole),
            Snapshot::NamingTheSession => Some(StopIntent::Sessions(BTreeSet::from([session_id]))),
            Snapshot::NamingAnother => {
                Some(StopIntent::Sessions(BTreeSet::from([mint_session_id()])))
            }
        };
        let expected = match expected {
            Expected::Missing => McpReceiptSession::Missing,
            Expected::Damaged => McpReceiptSession::Damaged,
            Expected::Continues => McpReceiptSession::Continues(session_id),
            Expected::Stopped => McpReceiptSession::Stopped(session_id),
        };

        let answer = receipt_session(has_row.then_some(&run), intent.as_ref(), &damaged);

        assert_eq!(answer, expected);
    }
}
