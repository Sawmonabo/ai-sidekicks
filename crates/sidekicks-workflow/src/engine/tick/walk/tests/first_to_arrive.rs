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
/// place, and its losers are only the live steps whose branch feeds nothing else; its won round,
/// whose unfed slots those losers alone feed, closes at the win, a straggler's late feed readies no
/// second step, and a loser readied after the win from a shared ancestor (C, from X) is canceled;
/// with every branch empty nothing wins and the flush skips it. Mutations: let an empty input win;
/// cancel a shared ancestor (X); let a straggler ready the node again; ready a loser decided after
/// the win; use the slot index as the spec position; keep a won round its losers alone feed open.
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
    assert_eq!(open_rounds(&walk, "M"), Vec::<u64>::new());
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
        walk.ready_inputs(&a_turn.ready[0].step, &a_turn.ready[0].sources, &outputs),
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
    for (turn, node_id) in [(&a_turn, "M"), (&x_turn, "Y")] {
        assert_eq!(
            describe(&walk.settle(&readied(turn, node_id), &[1])),
            Vec::<String>::new()
        );
    }
    assert_eq!(describe(&walk.flush()), Vec::<String>::new());
    assert_eq!(every_open_round(&walk), Vec::<String>::new());

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
/// comes back round to that branch, and that loser's late feed readies nothing: the next pass's
/// feed opens the next round and wins it, naming the next pass's loser. A loser readied earlier
/// in the turn of its win is taken back from the turn's ready steps and canceled, and one decided
/// later in that turn, run, skipped or won as a first-to-arrive node itself, is canceled before it
/// can feed the winner a second round, the won round closing at the win. Mutations: follow a
/// loop's back edge to the losers, so none loses; let the loser's late feed open a round; leave a
/// same-turn loser ready; ready or skip a loser decided after the win; let a first-to-arrive loser
/// decided after the win win its own round; keep the won round open.
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
        assert_eq!(open_rounds(&walk, "M"), Vec::<u64>::new());
    }
}

/// A loser readied in a later turn than its win, from a step the win overtook, is canceled, and
/// that step's other descendants never feed the winner a second round: the trigger feeds A, Y and
/// P; A and Z feed M's first main slot, Y feeds Z and B's first slot, P feeds B's second, and B
/// feeds M's second. Inside a loop, a step the win overtook feeds the loop node holding M nothing,
/// so it never starts a new pass, while the loop node's round, decided in the win's visit after
/// it, is never overtaken and starts one, whose feeds win again. Mutations: leave a step or round
/// the win overtook unread at its decision (B readied by the flush); let a feed the win overtook
/// open another round (M readied again from Z); admit the loop's new pass from a step the win
/// overtook (L readied from Y); let the win overtake the round of the loop node holding it (M
/// never runs on pass 1).
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
    assert_eq!(describe(&y_turn), ["canceled B exec 5"]);
    walk.settle(&readied(&a_turn, "M"), &[1]);
    assert_eq!(describe(&walk.flush()), Vec::<String>::new());
    assert_eq!(every_open_round(&walk), Vec::<String>::new());

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("M", "test.first", 1, false),
            node("L", "test.loop", 2, false),
            node("S", "test.step", 3, false),
            node("B", "test.step", 4, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("L", 1, "S", 0),
            edge("L", 1, "B", 0),
            edge("S", 0, "M", 0),
            edge("B", 0, "M", 1),
            edge("S", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    let s_turn = walk.settle(&readied(&l_turn, "S"), &[1]);
    assert_eq!(
        describe(&s_turn),
        [
            "ready M run 0 exec 4 from S:0@2 - -",
            "ready L run 1 exec 5 from S:0@2",
            "win M exec 4 losers [B@3]"
        ]
    );
    walk.drop_step(&readied(&l_turn, "B"));
    walk.settle(&readied(&s_turn, "M"), &[1]);
    let next_l_turn = walk.settle(&readied(&s_turn, "L"), &[0, 1]);
    assert_eq!(
        describe(&walk.settle(&readied(&next_l_turn, "S"), &[1])),
        [
            "ready M run 1 exec 8 from S:0@6 - -",
            "ready L run 2 exec 9 from S:0@6",
            "win M exec 8 losers [B@7]"
        ]
    );
}

/// A loop's next pass closes a round its last pass's win left open once nothing can fill it, and
/// the next pass's feeds fill fresh rounds: the loop node L feeds A, Y and Q; A feeds M's first
/// main slot, Y and Q feed the pair P2, which feeds M's second, and M feeds C, which wires back
/// into L. On pass 0, Y fills half of P2's round before A wins and Q, the only feed of its other
/// half, is canceled; the next pass's start cancels P2's spent round, and on pass 1, Y and Q fill
/// P2's next round, which runs and wins M. Mutations: keep the spent round open, so
/// `every_open_round` still lists `P2:0` once the next pass starts; drop it without a record, so
/// the next pass's start answers no `canceled P2`.
#[test]
fn a_loops_next_pass_closes_the_rounds_its_last_pass_left_spent() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("A", "test.step", 2, false),
            node("Y", "test.step", 3, false),
            node("Q", "test.step", 4, false),
            node("P2", "test.pair", 5, false),
            node("M", "test.first", 6, false),
            node("C", "test.step", 7, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("L", 1, "A", 0),
            edge("L", 1, "Y", 0),
            edge("L", 1, "Q", 0),
            edge("A", 0, "M", 0),
            edge("Y", 0, "P2", 0),
            edge("Q", 0, "P2", 1),
            edge("P2", 0, "M", 1),
            edge("M", 0, "C", 0),
            edge("C", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    walk.settle(&readied(&l_turn, "Y"), &[1]);
    let a_turn = walk.settle(&readied(&l_turn, "A"), &[1]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 5 from A:0@2 - -",
            "win M exec 5 losers [Q@4]"
        ]
    );
    assert_eq!(every_open_round(&walk), ["P2:0"]);
    walk.drop_step(&readied(&l_turn, "Q"));
    let m_turn = walk.settle(&readied(&a_turn, "M"), &[1]);
    let c_turn = walk.settle(&readied(&m_turn, "C"), &[1]);
    assert_eq!(
        describe(&c_turn),
        ["ready L run 1 exec 7 from C:0@6", "canceled P2 exec 8"]
    );
    assert_eq!(every_open_round(&walk), Vec::<String>::new());
    let next_l_turn = walk.settle(&readied(&c_turn, "L"), &[0, 1]);
    walk.settle(&readied(&next_l_turn, "Y"), &[1]);
    let q_turn = walk.settle(&readied(&next_l_turn, "Q"), &[1]);
    assert_eq!(
        describe(&q_turn),
        ["ready P2 run 1 exec 12 from Y:0@10 Q:0@11"]
    );
    assert_eq!(
        describe(&walk.settle(&readied(&q_turn, "P2"), &[1])),
        [
            "ready M run 1 exec 13 from - P2:0@12 -",
            "win M exec 13 losers [A@9]"
        ]
    );
}

/// A loop's next pass leaves open a round its last pass's win overtook while a live step of that
/// pass can still fill it: the loop node L feeds A, Y, R and S; A and the plain join J feed M's
/// first main slot and Y its second; R and S feed J's two slots, and M feeds C, which wires back
/// into L. R fills half of J's round, A wins M, and L's next pass is readied before S settles;
/// S's feed then completes J's round, which runs on both R's and S's items. With R2 also feeding
/// J's first slot, R and S settle empty, A wins M, and L's next pass is readied before R2
/// settles; R2's items then complete J's round. Mutations: close every round the win overtook
/// when the next pass starts, so S's feed opens a new round and J never runs; count a slot
/// settled empty as fed while R2 is live, so the round closes and `every_open_round` is empty.
#[test]
fn a_loops_next_pass_keeps_a_round_a_live_step_of_its_last_pass_still_fills() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("A", "test.step", 2, false),
            node("Y", "test.step", 3, false),
            node("R", "test.step", 4, false),
            node("S", "test.step", 5, false),
            node("J", "test.pair", 6, false),
            node("M", "test.first", 7, false),
            node("C", "test.step", 8, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("L", 1, "A", 0),
            edge("L", 1, "Y", 0),
            edge("L", 1, "R", 0),
            edge("L", 1, "S", 0),
            edge("A", 0, "M", 0),
            edge("Y", 0, "M", 1),
            edge("R", 0, "J", 0),
            edge("S", 0, "J", 1),
            edge("J", 0, "M", 0),
            edge("M", 0, "C", 0),
            edge("C", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    walk.settle(&readied(&l_turn, "R"), &[1]);
    let a_turn = walk.settle(&readied(&l_turn, "A"), &[1]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 6 from A:0@2 - -",
            "win M exec 6 losers [Y@3]"
        ]
    );
    walk.drop_step(&readied(&l_turn, "Y"));
    let m_turn = walk.settle(&readied(&a_turn, "M"), &[1]);
    let c_turn = walk.settle(&readied(&m_turn, "C"), &[1]);
    assert_eq!(describe(&c_turn), ["ready L run 1 exec 8 from C:0@7"]);
    assert_eq!(every_open_round(&walk), ["J:0"]);
    assert_eq!(
        describe(&walk.settle(&readied(&l_turn, "S"), &[1])),
        ["ready J run 0 exec 9 from R:0@4 S:0@5"]
    );

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("A", "test.step", 2, false),
            node("Y", "test.step", 3, false),
            node("R", "test.step", 4, false),
            node("R2", "test.step", 5, false),
            node("S", "test.step", 6, false),
            node("J", "test.pair", 7, false),
            node("M", "test.first", 8, false),
            node("C", "test.step", 9, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("L", 1, "A", 0),
            edge("L", 1, "Y", 0),
            edge("L", 1, "R", 0),
            edge("L", 1, "R2", 0),
            edge("L", 1, "S", 0),
            edge("A", 0, "M", 0),
            edge("Y", 0, "M", 1),
            edge("R", 0, "J", 0),
            edge("R2", 0, "J", 0),
            edge("S", 0, "J", 1),
            edge("J", 0, "M", 0),
            edge("M", 0, "C", 0),
            edge("C", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    for node_id in ["R", "S"] {
        walk.settle(&readied(&l_turn, node_id), &[0]);
    }
    let a_turn = walk.settle(&readied(&l_turn, "A"), &[1]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 7 from A:0@2 - -",
            "win M exec 7 losers [Y@3]"
        ]
    );
    walk.drop_step(&readied(&l_turn, "Y"));
    let m_turn = walk.settle(&readied(&a_turn, "M"), &[1]);
    let c_turn = walk.settle(&readied(&m_turn, "C"), &[1]);
    assert_eq!(describe(&c_turn), ["ready L run 1 exec 9 from C:0@8"]);
    assert_eq!(every_open_round(&walk), ["J:0"]);
    assert_eq!(
        describe(&walk.settle(&readied(&l_turn, "R2"), &[1])),
        ["ready J run 0 exec 10 from R2:0@5 S:0@6"]
    );
}

/// A win overtakes its losing branches and what leads into its node on its pass, a loop node before
/// it that does not hold it among them, but not a step that leads into it only through the loop
/// node holding it. First, the trigger feeds the loop node L and S, which also feeds L; L feeds A
/// and B, A feeds M's first main slot and B its second, and M wires back into L: A wins M while S
/// is live, and S's feed then starts L's next pass. Second, the trigger feeds L and W; W feeds L
/// and M's second main slot, L's loop output feeds A, which feeds M's first, and M feeds C, which
/// wires back into L: A wins M while W is live, W's feed into M enters the won round, its feed into
/// L starts L's next pass, and that pass's A wins M again. Third, the trigger feeds A, B and V; A
/// feeds M's first main slot and B its second, and V feeds the loop node L2, whose done output
/// feeds M's first slot and whose loop output feeds Q, which wires back into L2: A wins M while L2
/// is live, Q's feed still starts L2's next pass, and L2's later done output readies nothing.
/// Fourth, the trigger feeds A, P and F's first slot, P feeds F's second, F feeds the loop node L2,
/// whose loop output feeds Q, which feeds M's second slot and wires back into L2, and A feeds M's
/// first: after A wins, the flush cancels F's half-filled round. Mutations: let the win overtake
/// every live step of its loop passes (S's feed into L dropped); drop a feed the win overtook into
/// the loop node holding M whatever the feeding step's place (W's feed into L dropped, so L never
/// runs again); keep the win on the loop node's next pass (pass 1's A overtaken, its feed into M
/// dropped, so M never runs on pass 1); leave out every loop node before M (M readied again from
/// L2's done output); drop a feed the win overtook into every loop node before M (Q's feed into L2
/// dropped); leave the losing places out of what the win overtakes (F readied).
#[test]
fn a_win_overtakes_its_losing_branches_and_what_leads_into_its_node() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("S", "test.step", 2, false),
            node("A", "test.step", 3, false),
            node("B", "test.step", 4, false),
            node("M", "test.first", 5, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("trigger", 0, "S", 0),
            edge("S", 0, "L", 0),
            edge("L", 1, "A", 0),
            edge("L", 1, "B", 0),
            edge("A", 0, "M", 0),
            edge("B", 0, "M", 1),
            edge("M", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    assert_eq!(
        describe(&walk.settle(&readied(&l_turn, "A"), &[1])),
        [
            "ready M run 0 exec 5 from A:0@3 - -",
            "win M exec 5 losers [B@4]"
        ]
    );
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "S"), &[1])),
        ["ready L run 1 exec 6 from S:0@2"]
    );

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("W", "test.step", 2, false),
            node("A", "test.step", 3, false),
            node("M", "test.first", 4, false),
            node("C", "test.step", 5, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("trigger", 0, "W", 0),
            edge("W", 0, "L", 0),
            edge("W", 0, "M", 1),
            edge("L", 1, "A", 0),
            edge("A", 0, "M", 0),
            edge("M", 0, "C", 0),
            edge("C", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let l_turn = walk.settle(&readied(&trigger_turn, "L"), &[0, 1]);
    assert_eq!(
        describe(&walk.settle(&readied(&l_turn, "A"), &[1])),
        [
            "ready M run 0 exec 4 from A:0@3 - -",
            "win M exec 4 losers []"
        ]
    );
    let w_turn = walk.settle(&readied(&trigger_turn, "W"), &[1]);
    assert_eq!(describe(&w_turn), ["ready L run 1 exec 5 from W:0@2"]);
    assert_eq!(open_rounds(&walk, "M"), Vec::<u64>::new());
    let next_l_turn = walk.settle(&readied(&w_turn, "L"), &[0, 1]);
    assert_eq!(
        describe(&walk.settle(&readied(&next_l_turn, "A"), &[1])),
        [
            "ready M run 1 exec 7 from A:0@6 - -",
            "win M exec 7 losers []"
        ]
    );

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("B", "test.step", 2, false),
            node("V", "test.step", 3, false),
            node("L2", "test.loop", 4, false),
            node("Q", "test.step", 5, false),
            node("M", "test.first", 6, false),
        ],
        &[
            edge("trigger", 0, "A", 0),
            edge("trigger", 0, "B", 0),
            edge("trigger", 0, "V", 0),
            edge("A", 0, "M", 0),
            edge("B", 0, "M", 1),
            edge("V", 0, "L2", 0),
            edge("L2", 0, "M", 0),
            edge("L2", 1, "Q", 0),
            edge("Q", 0, "L2", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let v_turn = walk.settle(&readied(&trigger_turn, "V"), &[1]);
    assert_eq!(describe(&v_turn), ["ready L2 run 0 exec 4 from V:0@3"]);
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "A"), &[1])),
        [
            "ready M run 0 exec 5 from A:0@1 - -",
            "win M exec 5 losers [B@2]"
        ]
    );
    let l2_turn = walk.settle(&readied(&v_turn, "L2"), &[0, 1]);
    assert_eq!(describe(&l2_turn), ["ready Q run 0 exec 6 from L2:1@4"]);
    let q_turn = walk.settle(&readied(&l2_turn, "Q"), &[1]);
    assert_eq!(describe(&q_turn), ["ready L2 run 1 exec 7 from Q:0@6"]);
    assert_eq!(
        describe(&walk.settle(&readied(&q_turn, "L2"), &[1, 0])),
        Vec::<String>::new()
    );

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("P", "test.step", 2, false),
            node("F", "test.pair", 3, false),
            node("L2", "test.loop", 4, false),
            node("Q", "test.step", 5, false),
            node("M", "test.first", 6, false),
        ],
        &[
            edge("trigger", 0, "A", 0),
            edge("trigger", 0, "P", 0),
            edge("trigger", 0, "F", 0),
            edge("P", 0, "F", 1),
            edge("F", 0, "L2", 0),
            edge("L2", 1, "Q", 0),
            edge("Q", 0, "L2", 0),
            edge("Q", 0, "M", 1),
            edge("A", 0, "M", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let a_turn = walk.settle(&readied(&trigger_turn, "A"), &[1]);
    assert_eq!(
        describe(&a_turn),
        [
            "ready M run 0 exec 3 from A:0@1 - -",
            "win M exec 3 losers [P@2]"
        ]
    );
    walk.drop_step(&readied(&trigger_turn, "P"));
    walk.settle(&readied(&a_turn, "M"), &[1]);
    assert_eq!(describe(&walk.flush()), ["canceled F exec 4"]);
}

/// A loop node on a losing branch of a win is a loser like any other: a feed into it from a step
/// the win reached readies its round, which is canceled, and never starts its next pass. The
/// trigger feeds A, L and W; A and W feed M's first main slot, L's loop output feeds B, which feeds
/// M's second and wires back into L, and W also feeds L. A wins M while L and W are live, so L
/// loses; W's feed into L is canceled. Mutation: clear the wins L's body holds from the feed in
/// `fill` rather than from L's step in `ready`, so W's feed readies L's next pass.
#[test]
fn a_loop_on_a_losing_branch_is_canceled_when_a_step_the_win_reached_feeds_it() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("L", "test.loop", 2, false),
            node("W", "test.step", 3, false),
            node("B", "test.step", 4, false),
            node("M", "test.first", 5, false),
        ],
        &[
            edge("trigger", 0, "A", 0),
            edge("trigger", 0, "L", 0),
            edge("trigger", 0, "W", 0),
            edge("A", 0, "M", 0),
            edge("W", 0, "M", 0),
            edge("W", 0, "L", 0),
            edge("L", 1, "B", 0),
            edge("B", 0, "M", 1),
            edge("B", 0, "L", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "A"), &[1])),
        [
            "ready M run 0 exec 4 from A:0@1 - -",
            "win M exec 4 losers [L@2]"
        ]
    );
    walk.drop_step(&readied(&trigger_turn, "L"));
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "W"), &[1])),
        ["canceled L exec 5"]
    );
}

/// A win reaches only the steps of its own loop pass: the loop node L feeds A and Y, A feeds M's
/// first main slot, Y feeds B, which feeds M's second, and wires back into L. Y settles before A,
/// so L's next pass starts and readies A again before pass 0's win; that win cancels pass 0's B
/// alone, and pass 1's A then wins M on its own pass. Mutation: mark every live step with the win
/// whatever its pass, so pass 1's A is overtaken, its feed into M is dropped, and M never runs on
/// pass 1.
#[test]
fn a_win_reaches_only_its_own_loop_pass() {
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
    let y_turn = walk.settle(&readied(&l_turn, "Y"), &[1]);
    assert_eq!(
        describe(&y_turn),
        [
            "ready L run 1 exec 4 from Y:0@3",
            "ready B run 0 exec 5 from Y:0@3"
        ]
    );
    let next_l_turn = walk.settle(&readied(&y_turn, "L"), &[0, 1]);
    assert_eq!(
        describe(&walk.settle(&readied(&l_turn, "A"), &[1])),
        [
            "ready M run 0 exec 8 from A:0@2 - -",
            "win M exec 8 losers [B@5]"
        ]
    );
    walk.drop_step(&readied(&y_turn, "B"));
    assert_eq!(
        describe(&walk.settle(&readied(&next_l_turn, "A"), &[1])),
        [
            "ready M run 1 exec 9 from A:0@6 - -",
            "win M exec 9 losers []"
        ]
    );
}
