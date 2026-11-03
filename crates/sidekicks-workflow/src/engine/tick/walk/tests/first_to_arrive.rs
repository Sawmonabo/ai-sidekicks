//! First-to-arrive nodes: the win, its losers, and the rounds a win overtook, in its turn and in
//! later ones.

use serde_json::json;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;

use super::{
    describe, edge, every_open_round, first_to_arrive_walk, node, open_rounds, readied, start,
};
use crate::engine::tick::walk::{RunWalk, WalkTurn};
use crate::expressions::lineage::{StepKey, StepOutput, StepOutputs};

/// A first-to-arrive node readies on its first input with items, passing that input in its spec
/// place, and its losers are only the live steps whose branch feeds nothing else; a straggler's
/// late feed enters the won round without a second step, a loser readied after the win from a
/// shared ancestor (C, from X) is canceled, and the won round it never fed closes once the run is
/// quiet; with every branch empty nothing wins and the flush skips it. Mutations: let an empty
/// input win; cancel a shared ancestor (X); let a straggler ready the node again; ready a loser
/// decided after the win; use the slot index as the spec position.
#[test]
fn first_to_arrive_wins_on_items_and_cancels_only_its_losing_branch() {
    let (mut walk, start_turn) = first_to_arrive_walk();
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let a_step = readied(&trigger_turn, "A");
    let a_turn = walk.settle(&a_step, &[2]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 4 from A:0@1 - -",
            "win M exec 4 losers [B@2]"
        ]
    );
    let a_items: Vec<WorkflowItem> = (0..2)
        .map(|number| {
            serde_json::from_value(json!({ "json": { "number": number } }))
                .expect("the test's item reads")
        })
        .collect();
    let mut outputs = StepOutputs::new([(a_step.node_id.clone(), "A".to_owned())]);
    outputs.record(
        StepKey {
            node_id: a_step.node_id.clone(),
            execution_index: 1,
        },
        StepOutput {
            sources: Vec::new(),
            outputs: vec![a_items.clone()],
        },
    );
    assert_eq!(
        walk.ready_inputs(&a_turn.ready[0], &outputs),
        [Vec::new(), a_items, Vec::new(), Vec::new()]
    );
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "B"), &[1])),
        Vec::<String>::new()
    );
    let x_turn = walk.settle(&readied(&trigger_turn, "X"), &[1]);
    assert_eq!(
        describe(&x_turn),
        ["ready Y run 0 exec 6 from X:0@3", "canceled C exec 5"]
    );
    assert_eq!(open_rounds(&walk, "M"), [0]);
    for (turn, node_id) in [(&a_turn, "M"), (&x_turn, "Y")] {
        assert_eq!(
            describe(&walk.settle(&readied(turn, node_id), &[1])),
            Vec::<String>::new()
        );
    }
    assert_eq!(describe(&walk.flush()), Vec::<String>::new());
    assert_eq!(open_rounds(&walk, "M"), Vec::<u64>::new());

    let (mut walk, start_turn) = first_to_arrive_walk();
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    for branch in ["A", "B", "X"] {
        assert_eq!(
            describe(&walk.settle(&readied(&trigger_turn, branch), &[0])),
            Vec::<String>::new()
        );
    }
    assert_eq!(
        describe(&walk.flush()),
        [
            "skipped C NoItems run 0 exec 4 from X:0@3 outputs [0]",
            "skipped Y NoItems run 0 exec 5 from X:0@3 outputs [0]",
            "skipped M NoItems run 0 exec 6 from A:0@1 B:0@2 - outputs [0]",
        ]
    );
}

/// The loop the won-round tests run: the trigger feeds the loop node L, whose loop output feeds A
/// and B; A feeds M's first main slot and B its second, and M feeds C, which wires back into L.
fn looping_first_to_arrive_walk() -> (RunWalk, WalkTurn) {
    start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("A", "test.step", 2, false),
            node("B", "test.step", 3, false),
            node("M", "test.first", 4, false),
            node("C", "test.step", 5, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("L", 1, "A", 0),
            edge("L", 1, "B", 0),
            edge("A", 0, "M", 0),
            edge("B", 0, "M", 1),
            edge("M", 0, "C", 0),
            edge("C", 0, "L", 0),
        ],
    )
}

/// Inside a loop, a first-to-arrive win names the live step on its losing branch, though the loop
/// comes back round to that branch, and its round takes only its own pass's late feed: that
/// pass's straggler closes it, and the next pass's feed opens the next round and wins it, naming
/// the next pass's loser. A loser readied earlier in the turn of its win is taken back from the
/// turn's ready steps and canceled, and one decided later in that turn, run, skipped or won as a
/// first-to-arrive node itself, is canceled before it can feed the winner a second round.
/// Mutations: follow a loop's back edge to the losers, so none loses; let a won round take any
/// feed; let it take none; leave a same-turn loser ready; ready or skip a loser decided after the
/// win; let a first-to-arrive loser decided after the win win its own round.
#[test]
fn a_won_round_takes_only_its_own_pass_and_a_same_turn_loser_never_runs() {
    let (mut walk, start_turn) = looping_first_to_arrive_walk();
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    let a_turn = walk.settle(&readied(&l_turn, "A"), &[1]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 4 from A:0@2 - -",
            "win M exec 4 losers [B@3]"
        ]
    );
    assert_eq!(
        describe(&walk.settle(&readied(&l_turn, "B"), &[1])),
        Vec::<String>::new()
    );
    assert_eq!(open_rounds(&walk, "M"), Vec::<u64>::new());

    let (mut walk, start_turn) = looping_first_to_arrive_walk();
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    let a_turn = walk.settle(&readied(&l_turn, "A"), &[1]);
    walk.drop_step(&readied(&l_turn, "B"));
    let m_turn = walk.settle(&readied(&a_turn, "M"), &[1]);
    let c_turn = walk.settle(&readied(&m_turn, "C"), &[1]);
    assert_eq!(describe(&c_turn), ["ready L run 1 exec 6 from C:0@5"]);
    let next_l_turn = walk.settle(&readied(&c_turn, "L"), &[0, 1]);
    assert_eq!(
        describe(&next_l_turn),
        [
            "ready A run 1 exec 7 from L:1@6",
            "ready B run 1 exec 8 from L:1@6"
        ]
    );
    assert_eq!(
        describe(&walk.settle(&readied(&next_l_turn, "B"), &[1])),
        [
            "ready M run 1 exec 9 from - B:0@8 -",
            "win M exec 9 losers [A@7]"
        ]
    );

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("B", "test.step", 1, false),
            node("M", "test.first", 2, false),
        ],
        &[
            edge("trigger", 0, "M", 0),
            edge("trigger", 0, "B", 0),
            edge("B", 0, "M", 1),
        ],
    );
    assert_eq!(
        describe(&walk.settle(&readied(&start_turn, "trigger"), &[1])),
        [
            "ready M run 0 exec 2 from trigger:0@0 - -",
            "win M exec 2 losers []",
            "canceled B exec 1",
        ]
    );
    assert_eq!(walk.live.keys().copied().collect::<Vec<_>>(), [2]);

    for (b_kind, is_disabled) in [
        ("test.step", false),
        ("test.step", true),
        ("test.first", false),
    ] {
        let (mut walk, start_turn) = start(
            vec![
                node("trigger", "test.trigger", 0, false),
                node("M", "test.first", 1, false),
                node("B", b_kind, 2, is_disabled),
            ],
            &[
                edge("trigger", 0, "M", 0),
                edge("trigger", 0, "B", 0),
                edge("B", 0, "M", 1),
            ],
        );
        assert_eq!(
            describe(&walk.settle(&readied(&start_turn, "trigger"), &[1])),
            [
                "ready M run 0 exec 1 from trigger:0@0 - -",
                "win M exec 1 losers []",
                "canceled B exec 2",
            ]
        );
        assert_eq!(walk.live.keys().copied().collect::<Vec<_>>(), [1]);
        assert_eq!(open_rounds(&walk, "M"), [0]);
    }
}

/// A loser readied in a later turn than its win, from a step the win overtook, is canceled, and
/// that step's other descendants never feed the winner a second round: the trigger feeds A, Y and
/// P; A and Z feed M's first main slot, Y feeds Z and B's first slot, P feeds B's second, and B
/// feeds M's second. A loop node the win's node follows starts a new pass, whose feeds win again.
/// Mutations: leave a step or round the win overtook unread at its decision (B readied by the
/// flush); let a feed the win overtook open another round (M readied again from Z); keep the
/// overtaken wins across a loop's next pass (M never runs on pass 1).
#[test]
fn a_loser_readied_in_a_later_turn_never_runs_and_the_winner_runs_once_a_pass() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("Y", "test.step", 2, false),
            node("P", "test.step", 3, false),
            node("M", "test.first", 4, false),
            node("Z", "test.step", 5, false),
            node("B", "test.pair", 6, false),
        ],
        &[
            edge("trigger", 0, "A", 0),
            edge("trigger", 0, "Y", 0),
            edge("trigger", 0, "P", 0),
            edge("A", 0, "M", 0),
            edge("Y", 0, "Z", 0),
            edge("Z", 0, "M", 0),
            edge("Y", 0, "B", 0),
            edge("P", 0, "B", 1),
            edge("B", 0, "M", 1),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let a_turn = walk.settle(&readied(&trigger_turn, "A"), &[1]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 4 from A:0@1 - -",
            "win M exec 4 losers [P@3]"
        ]
    );
    walk.drop_step(&readied(&trigger_turn, "P"));
    let y_turn = walk.settle(&readied(&trigger_turn, "Y"), &[1]);
    assert_eq!(describe(&y_turn), ["ready Z run 0 exec 5 from Y:0@2"]);
    assert_eq!(
        describe(&walk.settle(&readied(&y_turn, "Z"), &[1])),
        Vec::<String>::new()
    );
    assert_eq!(
        describe(&walk.settle(&readied(&a_turn, "M"), &[1])),
        Vec::<String>::new()
    );
    assert_eq!(describe(&walk.flush()), ["canceled B exec 6"]);
    assert_eq!(every_open_round(&walk), Vec::<String>::new());

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("A", "test.step", 2, false),
            node("Y", "test.step", 3, false),
            node("M", "test.first", 4, false),
            node("B", "test.step", 5, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("L", 1, "A", 0),
            edge("L", 1, "Y", 0),
            edge("A", 0, "M", 0),
            edge("Y", 0, "B", 0),
            edge("B", 0, "M", 1),
            edge("Y", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    let a_turn = walk.settle(&readied(&l_turn, "A"), &[1]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 4 from A:0@2 - -",
            "win M exec 4 losers []"
        ]
    );
    let y_turn = walk.settle(&readied(&l_turn, "Y"), &[1]);
    assert_eq!(
        describe(&y_turn),
        ["ready L run 1 exec 5 from Y:0@3", "canceled B exec 6"]
    );
    walk.settle(&readied(&a_turn, "M"), &[1]);
    let next_l_turn = walk.settle(&readied(&y_turn, "L"), &[0, 1]);
    assert_eq!(
        describe(&walk.settle(&readied(&next_l_turn, "A"), &[1])),
        [
            "ready M run 1 exec 9 from A:0@7 - -",
            "win M exec 9 losers []"
        ]
    );
}
