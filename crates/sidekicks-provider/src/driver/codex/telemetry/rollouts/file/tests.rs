use rstest::rstest;
use serde_json::{Value, json};

use super::{CodexRolloutFile, CodexRolloutRequest, CodexRolloutTier};
use crate::driver::codex::pricing::tests::{PLAN, price};
use crate::pricing::rule::RequestPricing;

const PARENT: &str = "parent-thread";
const CHILD: &str = "child-thread";
const PARENT_TURN: &str = "parent-turn";
const CHILD_TURN: &str = "child-turn";

// Every record a test writes is priced: the reading starts at the epoch.
const FROM_THE_EPOCH: u64 = 0;

fn line(at: &str, kind: &str, payload: Value) -> String {
    let mut line = json!({"timestamp": at, "type": kind});
    line["payload"] = payload;
    line.to_string()
}

// The file's first line: `thread` forked from the parent, or spawned from it as a helper.
fn session_meta(at: &str, thread: &str, is_spawned: bool) -> String {
    let source = if is_spawned {
        json!({"subagent": {"thread_spawn": {"parent_thread_id": PARENT, "depth": 1}}})
    } else {
        json!("cli")
    };
    let forked_from = (!is_spawned).then_some(PARENT);
    line(
        at,
        "session_meta",
        json!({"id": thread, "forked_from_id": forked_from, "source": source}),
    )
}

fn turn_context(at: &str, turn: &str, model: &str) -> String {
    line(at, "turn_context", json!({"turn_id": turn, "model": model}))
}

fn settings(at: &str, thread: &str, tier: &str) -> String {
    let snapshot = json!({"model": "gpt-6.1-sol", "service_tier": tier});
    let event = json!({"type": "thread_settings_applied", "thread_id": thread,
        "thread_settings": snapshot});
    line(at, "event_msg", event)
}

// A record of `input` and `output` tokens, its turn's and thread's totals far larger, as a
// resumed or forked thread's running totals are.
fn record(at: &str, thread: &str, turn: &str, response: &str, input: u64, output: u64) -> String {
    let usage = |input: u64, output: u64| {
        json!({"input_tokens": input, "cached_input_tokens": 0, "output_tokens": output,
            "reasoning_output_tokens": 0, "total_tokens": input + output})
    };
    let payload = json!({"thread_id": thread, "turn_id": turn, "session_id": PARENT,
        "root_turn_id": turn, "response_id": response, "usage": usage(input, output),
        "turn_token_usage": usage(input * 5, output * 5),
        "thread_token_usage": usage(input * 50, output * 50)});
    line(at, "token_usage_record", payload)
}

fn token_count(at: &str, total: u64) -> String {
    let event = json!({"type": "token_count", "info": {"total_token_usage": {
        "input_tokens": total, "cached_input_tokens": 0, "output_tokens": total,
        "reasoning_output_tokens": 0, "total_tokens": total * 2}}});
    line(at, "event_msg", event)
}

fn turn_end(at: &str, kind: &str, turn: &str, error: Option<&str>) -> String {
    let error = error.map(|message| json!({"message": message}));
    line(
        at,
        "event_msg",
        json!({"type": kind, "turn_id": turn, "error": error}),
    )
}

// A legacy fork's or a spawned helper's rollout: its own first line, the parent's history copied
// whole (its line, turn, settings, record and running totals), then its own settings at
// `own_tier`, its turn's context, `between`, and its two records, the first written again.
fn child_rollout(
    is_spawned: bool,
    own_tier: &str,
    between: Vec<String>,
    stamps: [&str; 2],
) -> Vec<String> {
    let mut lines = vec![
        session_meta("2026-11-09T09:59:00.000Z", CHILD, is_spawned),
        session_meta("2026-11-09T09:00:00.000Z", PARENT, false),
        turn_context("2026-11-09T09:00:01.000Z", PARENT_TURN, "gpt-5.3-codex"),
        settings("2026-11-09T09:00:01.000Z", PARENT, "flex"),
        record(
            "2026-11-09T09:00:02.000Z",
            PARENT,
            PARENT_TURN,
            "parent-response",
            7_000,
            700,
        ),
        token_count("2026-11-09T09:00:02.000Z", 7_000),
        settings("2026-11-09T09:59:01.000Z", CHILD, own_tier),
        turn_context("2026-11-09T09:59:02.000Z", CHILD_TURN, "gpt-6.1-sol"),
    ];
    lines.extend(between);
    let [first, second] = stamps;
    lines.extend([
        record(first, CHILD, CHILD_TURN, "child-response-1", 1_000, 100),
        token_count(first, 58_000),
        record(second, CHILD, CHILD_TURN, "child-response-2", 1_000, 100),
        record(second, CHILD, CHILD_TURN, "child-response-1", 1_000, 100),
    ]);
    lines
}

fn unix_ms(stamp: &str) -> u64 {
    super::read_unix_ms(stamp).expect("the test's stamp reads")
}

// What `request` costs on a plan at its own snapshot's tier; a spawned helper's, whose root
// thread's tier the session's stored rows answer as it is decided, at the standard rates here.
fn cost(request: &CodexRolloutRequest) -> u64 {
    let tier = match &request.tier {
        CodexRolloutTier::Snapshot(tier) => tier.clone(),
        CodexRolloutTier::RootThread => None,
    };
    let counts = &request.counts;
    let count = |axis: Option<u64>| axis.expect("a record carries every count");
    let cached = count(counts.cached_input);
    let input = [
        count(counts.input) - cached,
        count(counts.output),
        cached,
        count(counts.cache_write_input),
    ];
    match price(&request.model, tier.as_deref(), None, PLAN, input) {
        RequestPricing::Priced { shares, .. } => shares.iter().map(|share| share.0.get()).sum(),
        RequestPricing::HeldForPrice | RequestPricing::HeldForSignInKind => {
            panic!("the test's table prices the request")
        }
    }
}

// Each of the child's own records priced once at its own turn's model and its own tier, and
// nothing else: 6,000 µ$ a request at `gpt-6.1-sol` priority, 3,000 at the standard rates.
// Killed by pricing a copied record (the parent's 7,000 tokens), by no dedupe by `response_id` (a
// third request), by pricing from a running total, by the last `turn_context` or the last
// snapshot of any owner (the parent's lines between), and by a spawned helper's own snapshot
// taken in place of its root thread's tier.
#[rstest]
#[case::copied_history_skipped(
    false,
    "priority",
    Vec::new(),
    CodexRolloutTier::Snapshot(Some("priority".to_owned())),
    12_000
)]
#[case::another_owners_lines_between(
    false,
    "priority",
    vec![
        turn_context("2026-11-09T09:59:03.000Z", PARENT_TURN, "gpt-5.3-codex"),
        settings("2026-11-09T09:59:03.000Z", PARENT, "default"),
    ],
    CodexRolloutTier::Snapshot(Some("priority".to_owned())),
    12_000
)]
#[case::spawned_helper_at_the_root_tier(
    true,
    "priority",
    Vec::new(),
    CodexRolloutTier::RootThread,
    6_000
)]
fn a_child_rollout_prices_its_own_records_once(
    #[case] is_spawned: bool,
    #[case] own_tier: &str,
    #[case] between: Vec<String>,
    #[case] tier: CodexRolloutTier,
    #[case] total_micros: u64,
) {
    let stamps = ["2026-11-09T10:00:10.000Z", "2026-11-09T10:00:50.000Z"];
    let mut file = CodexRolloutFile::default();
    let requests: Vec<CodexRolloutRequest> = child_rollout(is_spawned, own_tier, between, stamps)
        .iter()
        .filter_map(|line| file.read_line(line.as_bytes(), FROM_THE_EPOCH, &mut |_, _, _| false))
        .collect();

    let priced: Vec<&str> = requests
        .iter()
        .map(|request| request.response_id.as_str())
        .collect();
    assert_eq!(priced, ["child-response-1", "child-response-2"]);
    assert_eq!(
        requests
            .iter()
            .map(|request| request.at_ms)
            .collect::<Vec<_>>(),
        stamps.map(unix_ms)
    );
    assert!(requests.iter().all(|request| request.tier == tier));
    let total: u64 = requests.iter().map(cost).sum();
    assert_eq!(total, total_micros);
}

// A turn that settled with no record names the file, its next record clears the name, and an
// aborted or failed turn names nothing; a turn's end before the file's own first snapshot is a
// copied one and names nothing. Killed by naming a turn's end before the own snapshot, by a
// record that leaves the name standing, and by naming an aborted or failed turn.
#[test]
fn a_turn_settled_with_no_record_names_the_file_until_a_record_clears_it() {
    let at = "2026-11-09T10:00:00.000Z";
    let steps = [
        (session_meta(at, CHILD, false), false),
        (turn_end(at, "task_complete", PARENT_TURN, None), false),
        (settings(at, CHILD, "priority"), false),
        (turn_context(at, "turn-1", "gpt-6.1-sol"), false),
        (turn_end(at, "task_complete", "turn-1", None), true),
        (turn_context(at, "turn-2", "gpt-6.1-sol"), true),
        (record(at, CHILD, "turn-2", "response-2", 10, 1), false),
        (turn_end(at, "task_complete", "turn-2", None), false),
        (turn_end(at, "turn_aborted", "turn-3", None), false),
        (
            turn_end(at, "task_complete", "turn-4", Some("failed")),
            false,
        ),
    ];
    let mut file = CodexRolloutFile::default();
    for (index, (line, is_unreadable)) in steps.iter().enumerate() {
        file.read_line(line.as_bytes(), FROM_THE_EPOCH, &mut |_, _, _| false);
        assert_eq!(file.is_unreadable(), *is_unreadable, "after line {index}");
    }
}

// Of two equal responses on one thread, one exported, the exported one's record stamped before
// the reading's start still takes the one exported match, so the unexported one after the start is
// priced. Killed by a record offered to the exports only from the start on (the later one takes
// the match and is counted nowhere).
#[test]
fn a_record_before_the_reading_s_start_takes_its_own_exported_match() {
    let (before, after) = ("2026-11-09T10:00:01.000Z", "2026-11-09T10:00:20.000Z");
    let lines = [
        session_meta(before, CHILD, false),
        turn_context(before, CHILD_TURN, "gpt-6.1-sol"),
        record(before, CHILD, CHILD_TURN, "response-exported", 10, 1),
        record(after, CHILD, CHILD_TURN, "response-unexported", 10, 1),
    ];
    let mut exported_matches = 1;
    let mut file = CodexRolloutFile::default();
    let priced: Vec<String> = lines
        .iter()
        .filter_map(|line| {
            file.read_line(line.as_bytes(), unix_ms(after), &mut |_, _, _| {
                let is_match = exported_matches > 0;
                exported_matches -= u32::from(is_match);
                is_match
            })
        })
        .map(|request| request.response_id)
        .collect();

    assert_eq!(priced, ["response-unexported"]);
}
