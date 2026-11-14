use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::unix_time::read_unix_time_ms;
use tokio::time::Instant;

use super::{
    CodexExportedIdentity, CodexHeldRolloutRequest, CodexRolloutDecisions, HELD_REQUESTS_KEPT,
};
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_ARRIVAL_BOUND;
use crate::driver::codex::telemetry::rollouts::file::{CodexRolloutRequest, CodexRolloutTier};
use crate::usage_delta_accountant::UsageAxisCounts;

const THREAD: &str = "thread-1";

fn counts(input: u64) -> UsageAxisCounts {
    UsageAxisCounts {
        input: Some(input),
        total: Some(input),
        ..UsageAxisCounts::default()
    }
}

// A request of `input` tokens on the thread, its line stamped at `at_ms`.
fn held(session_id: SessionId, input: u64, at_ms: u64) -> CodexHeldRolloutRequest {
    let request = CodexRolloutRequest {
        response_id: format!("response-{input}"),
        model: "gpt-5".to_owned(),
        tier: CodexRolloutTier::Snapshot(None),
        counts: counts(input),
        at_ms,
    };
    CodexHeldRolloutRequest::new(session_id, THREAD.to_owned(), None, request)
}

fn inputs(requests: &[CodexHeldRolloutRequest]) -> Vec<Option<u64>> {
    requests
        .iter()
        .map(|held| held.request.counts.input)
        .collect()
}

// A request is held while no export read carries a record later than its stamp, then decided
// once: passed over where its own late batch carried it, priced where its batch was lost or where
// an equal request's record already took the one exported match, kept while the newest record
// only equals its stamp, priced as no export can still arrive with it or as the launch ends, and
// the oldest decided, never dropped, once the hold is full. Killed by pricing at the read with no
// hold (the late batch's response priced too), by a later record taken as at or past the stamp
// (the same-millisecond one decided early), by a match left in place for the next equal request
// (the second equal one passed over too), by a held request never matched against the exports
// read after it (the late one priced), by no deadline, by a launch's end that drops what it holds,
// and by a full hold that forgets its oldest.
#[test]
fn a_held_rollout_request_is_decided_once_by_the_first_export_past_its_stamp() {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let at_ms = read_unix_time_ms();
    let mut decisions = CodexRolloutDecisions::default();

    assert!(decisions.hold(held(session_id, 5, at_ms), None).is_none());
    assert!(decisions.hold(held(session_id, 5, at_ms), None).is_none());
    assert!(
        decisions
            .hold(held(session_id, 9, at_ms + 50), None)
            .is_none()
    );
    assert!(
        decisions
            .hold(held(session_id, 7, at_ms + 100), Some(at_ms + 100))
            .is_none()
    );
    assert_eq!(
        decisions
            .hold(held(session_id, 3, at_ms), Some(at_ms + 1))
            .map(|held| held.request.at_ms),
        Some(at_ms),
        "a request an export read already passed is priced at once"
    );

    decisions.remember_exported(vec![CodexExportedIdentity {
        thread_id: THREAD.to_owned(),
        counts: counts(5),
        observed_at_ms: at_ms - 2,
    }]);
    assert_eq!(
        inputs(&decisions.decide_stamped_before(at_ms + 100)),
        [Some(5), Some(9)]
    );
    assert!(decisions.decide_due(Instant::now()).is_empty());
    assert_eq!(
        inputs(&decisions.decide_due(Instant::now() + CODEX_EXPORT_ARRIVAL_BOUND)),
        [Some(7)]
    );

    assert!(
        decisions
            .hold(held(session_id, 11, at_ms + 200), None)
            .is_none()
    );
    assert_eq!(inputs(&decisions.decide_all()), [Some(11)]);

    for input in 0..HELD_REQUESTS_KEPT {
        let input = u64::try_from(input).expect("the bound is small");
        assert!(
            decisions
                .hold(held(session_id, input, at_ms + 300), None)
                .is_none()
        );
    }
    let oldest = decisions.hold(held(session_id, 1_000, at_ms + 300), None);
    assert_eq!(oldest.map(|held| held.request.counts.input), Some(Some(0)));
}
