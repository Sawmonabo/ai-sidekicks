//! The flush: what a quiet run decides of the rounds still waiting.

use rstest::rstest;

use super::{RunWalk, always_output_node, describe, edge, every_open_round, node, readied, start};

/// The walk after the trigger feeds X, X settles empty into Y and Y would feed Z; Y always
/// outputs data when `is_always_output`.
fn empty_feed_walk(is_always_output: bool) -> RunWalk {
    let y = if is_always_output {
        always_output_node("Y", 2)
    } else {
        node("Y", "test.step", 2, false)
    };
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("X", "test.step", 1, false),
            y,
            node("Z", "test.step", 3, false),
        ],
        &[
            edge("trigger", 0, "X", 0),
            edge("X", 0, "Y", 0),
            edge("Y", 0, "Z", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    walk.settle(&readied(&trigger_turn, "X"), &[0]);
    walk
}

/// A quiet walk whose Y was fed only an empty input.
fn empty_feed_quiet_walk() -> RunWalk {
    empty_feed_walk(false)
}

/// A quiet walk whose Y, marked to always output data, was fed only an empty input.
fn always_output_quiet_walk() -> RunWalk {
    empty_feed_walk(true)
}

/// A quiet walk whose M ran its round 0 on P and R, Q's feed waiting in round 1 for its slot 1.
fn second_round_quiet_walk() -> RunWalk {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("P", "test.step", 1, false),
            node("Q", "test.step", 2, false),
            node("R", "test.step", 3, false),
            node("M", "test.pair", 4, false),
        ],
        &[
            edge("trigger", 0, "P", 0),
            edge("trigger", 0, "Q", 0),
            edge("trigger", 0, "R", 0),
            edge("P", 0, "M", 0),
            edge("Q", 0, "M", 0),
            edge("R", 0, "M", 1),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    walk.settle(&readied(&trigger_turn, "P"), &[1]);
    walk.settle(&readied(&trigger_turn, "Q"), &[1]);
    let r_turn = walk.settle(&readied(&trigger_turn, "R"), &[1]);
    walk.settle(&readied(&r_turn, "M"), &[1, 0]);
    walk
}

/// A walk whose Y was fed only an empty input while W is still live.
fn live_step_walk() -> RunWalk {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("X", "test.step", 1, false),
            node("W", "test.step", 2, false),
            node("Y", "test.step", 3, false),
        ],
        &[
            edge("trigger", 0, "X", 0),
            edge("trigger", 0, "W", 0),
            edge("X", 0, "Y", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    walk.settle(&readied(&trigger_turn, "X"), &[0]);
    walk
}

/// A quiet walk whose M (order 1) holds P's feed and waits on A (order 5), whose own round waits
/// on Q, dropped before it fed A.
fn feeder_sorted_after_target_quiet_walk() -> RunWalk {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("M", "test.pair", 1, false),
            node("P", "test.step", 2, false),
            node("Q", "test.step", 3, false),
            node("A", "test.pair", 5, false),
        ],
        &[
            edge("trigger", 0, "P", 0),
            edge("trigger", 0, "Q", 0),
            edge("trigger", 0, "A", 0),
            edge("P", 0, "M", 0),
            edge("Q", 0, "A", 1),
            edge("A", 0, "M", 1),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    walk.settle(&readied(&trigger_turn, "P"), &[1]);
    walk.drop_step(&readied(&trigger_turn, "Q"));
    walk
}

/// A quiet walk whose loop node J holds the trigger's feed and waits on B, its loop's other node,
/// whose own round holds X's feed and waits on J.
fn loop_quiet_walk() -> RunWalk {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("J", "test.pair", 1, false),
            node("B", "test.pair", 2, false),
            node("X", "test.step", 3, false),
            node("D", "test.step", 4, false),
        ],
        &[
            edge("trigger", 0, "J", 0),
            edge("B", 0, "J", 1),
            edge("J", 0, "D", 0),
            edge("J", 1, "B", 0),
            edge("trigger", 0, "X", 0),
            edge("X", 0, "B", 1),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    walk.settle(&readied(&trigger_turn, "X"), &[1]);
    walk
}

/// A quiet walk whose first-to-arrive M won on A and ran, B, which also feeds D and so is no
/// loser, dropped before it fed M.
fn won_round_quiet_walk() -> RunWalk {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("B", "test.step", 2, false),
            node("M", "test.first", 3, false),
            node("D", "test.step", 4, false),
        ],
        &[
            edge("trigger", 0, "A", 0),
            edge("trigger", 0, "B", 0),
            edge("A", 0, "M", 0),
            edge("B", 0, "M", 1),
            edge("B", 0, "D", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let a_turn = walk.settle(&readied(&trigger_turn, "A"), &[1]);
    walk.drop_step(&readied(&trigger_turn, "B"));
    walk.settle(&readied(&a_turn, "M"), &[1]);
    walk
}

/// The flush decides what waits only once the run is quiet: an empty-only round is skipped and
/// feeds nothing whatever the node's settings, a waiting round with items runs with no source on
/// its missing slot, a won round is dropped unreadied, a node waits while an ancestor that sorts
/// after it still waits, and a loop's nodes, never each other's ancestors, still flush.
/// Mutations: flush while a step is live; let a `noItems` skip feed onward; let always-output data
/// ready an unfed node; give a missing slot a source; ready a won round; flush in `(order, id)`
/// alone; count a loop's back edge as a forward one, so the loop's two waiting nodes hold each
/// other.
#[rstest]
#[case::an_empty_feed_is_skipped(empty_feed_quiet_walk, &[
    "skipped Y NoItems run 0 exec 2 from X:0@1 outputs [0]",
], &[])]
#[case::always_output_data_does_not_run_an_unfed_node(always_output_quiet_walk, &[
    "skipped Y NoItems run 0 exec 2 from X:0@1 outputs [0]",
], &[])]
#[case::a_waiting_round_runs_without_its_missing_slot(second_round_quiet_walk, &[
    "ready M run 1 exec 5 from Q:0@2 -",
], &[])]
#[case::a_live_step_holds_the_flush(live_step_walk, &[], &["Y:0"])]
#[case::a_won_round_is_dropped(won_round_quiet_walk, &[], &[])]
#[case::a_feeder_sorted_after_its_target_flushes_first(feeder_sorted_after_target_quiet_walk, &[
    "ready A run 0 exec 3 from trigger:0@0 -",
], &["M:0"])]
#[case::a_loop_still_flushes(loop_quiet_walk, &[
    "ready J run 0 exec 2 from trigger:0@0 -",
], &["B:0"])]
fn a_quiet_run_flushes_what_waits_and_a_skip_feeds_nothing(
    #[case] quiet_walk: fn() -> RunWalk,
    #[case] expected: &[&str],
    #[case] still_open: &[&str],
) {
    let mut walk = quiet_walk();
    assert_eq!(describe(&walk.flush()), expected);
    assert_eq!(every_open_round(&walk), still_open);
}
