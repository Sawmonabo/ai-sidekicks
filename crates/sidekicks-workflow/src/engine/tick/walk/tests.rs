mod flush;

use std::collections::HashMap;
use std::sync::Arc;

use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::workflow::definition::document::{WorkflowEdge, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{WorkflowStepKey, WorkflowStepSource};

use super::{RunGraph, RunWalk, WalkTurn};
use crate::expressions::lineage::{StepKey, StepOutput, StepOutputs};
use crate::kinds::step_context::StepContext;
use crate::kinds::{
    NodeExecutor, NodeKind, NodeKindTable, PassThroughExecutor, StepFailure, StepOutcome, test_kind,
};

/// A test executor whose step runs on its first main input with items, passing its inputs on.
struct FirstInputExecutor;

impl NodeExecutor for FirstInputExecutor {
    fn execute<'step>(
        &'step self,
        _context: &'step StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> BoxFuture<'step, Result<StepOutcome, StepFailure>> {
        Box::pin(async move { Ok(StepOutcome::Outputs(inputs)) })
    }

    fn readies_on_first_input(&self, _node: &WorkflowNode) -> bool {
        true
    }
}

/// The test kind `name` with `inputs` main inputs and `outputs` main outputs.
fn kind(name: &str, inputs: usize, outputs: usize) -> NodeKind {
    let handles = |side: &str, count: usize| -> Value {
        (0..count)
            .map(|index| {
                json!({ "type": "main", "id": format!("{side}/main/{index}"), "label": "H" })
            })
            .collect()
    };
    test_kind(
        json!({
            "kind": name, "version": 1, "category": "developer",
            "displayName": "Test", "description": "A test kind.", "icon": "test",
            "params": [], "outputsDeriveFromParams": false,
            "inputs": handles("inputs", inputs), "outputs": handles("outputs", outputs),
        }),
        None,
        Box::new(PassThroughExecutor),
    )
}

/// The loop kind `test.loop`, with one main input and its done and loop outputs.
fn loop_kind() -> NodeKind {
    let mut loop_kind = kind("test.loop", 1, 2);
    loop_kind.is_loop = true;
    loop_kind
}

/// The kinds the tests' graphs use.
fn kinds() -> NodeKindTable {
    NodeKindTable::new(vec![
        kind("test.trigger", 0, 1),
        kind("test.step", 1, 1),
        kind("test.pair", 2, 2),
        loop_kind(),
        kind("test.triple", 3, 1),
        test_kind(
            json!({
                "kind": "test.first", "version": 1, "category": "developer",
                "displayName": "Test", "description": "A first-to-arrive test kind.",
                "icon": "test", "params": [], "outputsDeriveFromParams": false,
                "inputs": [
                    { "type": "tool", "id": "inputs/tool/0", "label": "T" },
                    { "type": "main", "id": "inputs/main/0", "label": "H" },
                    { "type": "main", "id": "inputs/main/1", "label": "H" },
                    { "type": "main", "id": "inputs/main/2", "label": "H" },
                ],
                "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "H" }],
            }),
            None,
            Box::new(FirstInputExecutor),
        ),
    ])
    .expect("the test kinds build")
}

/// A node `id` of `kind` at `order`, switched off when `is_disabled`.
fn node(id: &str, kind: &str, order: i64, is_disabled: bool) -> WorkflowNode {
    serde_json::from_value(json!({
        "id": id, "kind": kind, "kindVersion": 1, "name": id, "order": order, "params": {},
        "disabled": is_disabled,
    }))
    .expect("the test's node reads")
}

/// The node `id` of the kind `test.step` at `order`, marked to always output data.
fn always_output_node(id: &str, order: i64) -> WorkflowNode {
    serde_json::from_value(json!({
        "id": id, "kind": "test.step", "kindVersion": 1, "name": id, "order": order,
        "params": {}, "alwaysOutputData": true,
    }))
    .expect("the test's node reads")
}

/// An edge from `source`'s main output `output` into `target`'s main input `input`.
fn edge(source: &str, output: usize, target: &str, input: usize) -> WorkflowEdge {
    serde_json::from_value(json!({
        "id": format!("{source}-{output}-{target}-{input}"),
        "source": source, "sourceHandle": format!("outputs/main/{output}"),
        "target": target, "targetHandle": format!("inputs/main/{input}"),
    }))
    .expect("the test's edge reads")
}

/// A walk over `nodes`, the `trigger` among them, and `edges`, built from its own node map, with
/// the turn that starts it.
fn start(nodes: Vec<WorkflowNode>, edges: &[WorkflowEdge]) -> (RunWalk, WalkTurn) {
    let nodes: HashMap<_, _> = nodes
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect();
    let trigger = nodes
        .keys()
        .find(|id| id.as_str() == "trigger")
        .expect("the graph has a trigger")
        .clone();
    let graph = RunGraph::new(&nodes, &trigger, edges, &kinds()).expect("the graph builds");
    let run_id = WorkflowRunId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62").expect("a run id");
    let mut walk = RunWalk::new(Arc::new(graph), run_id);
    let turn = walk.start();
    (walk, turn)
}

/// The first-to-arrive graph: the trigger feeds A, B and X; A feeds M's first main slot, B its
/// second, and X feeds C, which feeds its third, and Y. M's kind lists a tool input first.
fn first_to_arrive_walk() -> (RunWalk, WalkTurn) {
    start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("B", "test.step", 2, false),
            node("X", "test.step", 3, false),
            node("C", "test.step", 4, false),
            node("Y", "test.step", 5, false),
            node("M", "test.first", 6, false),
        ],
        &[
            edge("trigger", 0, "A", 0),
            edge("trigger", 0, "B", 0),
            edge("trigger", 0, "X", 0),
            edge("X", 0, "C", 0),
            edge("X", 0, "Y", 0),
            edge("A", 0, "M", 0),
            edge("B", 0, "M", 1),
            edge("C", 0, "M", 2),
        ],
    )
}

/// The key of the step `turn` readied for `node_id`.
fn readied(turn: &WalkTurn, node_id: &str) -> WorkflowStepKey {
    turn.ready
        .iter()
        .find(|ready| ready.step.node_id.as_str() == node_id)
        .map(|ready| ready.step.clone())
        .expect("the turn readied the node")
}

/// Each answer of `turn` as one line: ready steps, then skipped ones, each with its node, run
/// index, execution index and sources as `node:output@execution`, `-` for an unfed slot.
fn describe(turn: &WalkTurn) -> Vec<String> {
    let sources = |sources: &[Option<WorkflowStepSource>]| -> String {
        sources
            .iter()
            .map(|source| {
                source.as_ref().map_or_else(
                    || "-".to_owned(),
                    |source| {
                        format!(
                            "{}:{}@{}",
                            source.node_id.as_str(),
                            source.output_index.get(),
                            source.execution_index.get()
                        )
                    },
                )
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    let ready = turn.ready.iter().map(|ready| {
        format!(
            "ready {} run {} exec {} from {}",
            ready.step.node_id.as_str(),
            ready.run_index,
            ready.step.execution_index.get(),
            sources(&ready.sources)
        )
    });
    let skipped = turn.skipped.iter().map(|skip| {
        format!(
            "skipped {} {:?} run {} exec {} from {} outputs {:?}",
            skip.step.node_id.as_str(),
            skip.reason,
            skip.run_index,
            skip.step.execution_index.get(),
            sources(&skip.sources),
            skip.output_lengths
        )
    });
    let wins = turn.wins.iter().map(|win| {
        let losers: Vec<String> = win
            .losers
            .iter()
            .map(|loser| format!("{}@{}", loser.node_id.as_str(), loser.execution_index.get()))
            .collect();
        format!(
            "win {} exec {} losers [{}]",
            win.deciding.node_id.as_str(),
            win.deciding.execution_index.get(),
            losers.join(" ")
        )
    });
    let canceled = turn.canceled.iter().map(|canceled| {
        format!(
            "canceled {} exec {}",
            canceled.step.node_id.as_str(),
            canceled.step.execution_index.get()
        )
    });
    ready.chain(skipped).chain(wins).chain(canceled).collect()
}

/// The open rounds of every node, as `node:run index`, in visiting order.
fn every_open_round(walk: &RunWalk) -> Vec<String> {
    (0..walk.graph.node_count())
        .flat_map(|place| {
            let node_id = walk.graph.node(place).id.as_str();
            walk.rounds[place]
                .open
                .keys()
                .map(move |run_index| format!("{node_id}:{run_index}"))
        })
        .collect()
}

/// The run indices of `node_id`'s open rounds, lowest first.
fn open_rounds(walk: &RunWalk, node_id: &str) -> Vec<u64> {
    (0..walk.graph.node_count())
        .find(|&place| walk.graph.node(place).id.as_str() == node_id)
        .map(|place| walk.rounds[place].open.keys().copied().collect())
        .expect("the graph has the node")
}

/// A node readies only once every main input has settled, its siblings readied by `order` and
/// not by the edges' order, each slot's source naming its feed and that feed's execution.
/// Mutations: ready on the first input; follow the edges' order; swap the slots; drop the source's
/// execution index.
#[test]
fn a_node_readies_once_its_main_inputs_settle_in_order_not_position() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 2, false),
            node("B", "test.step", 1, false),
            node("M", "test.pair", 3, false),
        ],
        &[
            edge("trigger", 0, "A", 0),
            edge("trigger", 0, "B", 0),
            edge("A", 0, "M", 0),
            edge("B", 0, "M", 1),
        ],
    );
    assert_eq!(describe(&start_turn), ["ready trigger run 0 exec 0 from "]);
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    assert_eq!(
        describe(&trigger_turn),
        [
            "ready B run 0 exec 1 from trigger:0@0",
            "ready A run 0 exec 2 from trigger:0@0"
        ]
    );
    let a_turn = walk.settle(&readied(&trigger_turn, "A"), &[1]);
    assert_eq!(describe(&a_turn), Vec::<String>::new());
    let b_turn = walk.settle(&readied(&trigger_turn, "B"), &[1]);
    assert_eq!(describe(&b_turn), ["ready M run 0 exec 3 from A:0@2 B:0@1"]);
}

/// An empty feed settles its slot but never decides a round alone, a later feed with items takes
/// its place, and a disabled node passes only its first slot on, feeding onward only items.
/// The graph: the trigger feeds X1 (order 1) and X2 (order 2), which feed T, which feeds S from
/// its first output. Mutations: decide an empty round on arrival; keep an empty feed over a later
/// one with items; pass slot 1 on; let a skip with empty outputs feed onward.
#[rstest]
#[case::an_empty_slot_keeps_its_source("test.pair", false, 1, 0, 2, &[
    "ready T run 0 exec 3 from X1:0@1 X2:0@2",
])]
#[case::items_replace_an_empty_feed("test.step", false, 0, 0, 4, &[
    "ready T run 0 exec 3 from X2:0@2",
])]
#[case::a_disabled_node_passes_its_first_input("test.pair", true, 1, 3, 5, &[
    "ready S run 0 exec 4 from T:0@3",
    "skipped T Disabled run 0 exec 3 from X1:0@1 X2:0@2 outputs [3, 0]",
])]
#[case::a_disabled_node_with_an_empty_first_input_feeds_nothing("test.pair", true, 1, 0, 5, &[
    "skipped T Disabled run 0 exec 3 from X1:0@1 X2:0@2 outputs [0, 0]",
])]
fn an_empty_input_waits_and_a_disabled_node_passes_its_first_input(
    #[case] target_kind: &str,
    #[case] is_disabled: bool,
    #[case] second_slot: usize,
    #[case] first_count: usize,
    #[case] second_count: usize,
    #[case] expected: &[&str],
) {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("X1", "test.step", 1, false),
            node("X2", "test.step", 2, false),
            node("T", target_kind, 3, is_disabled),
            node("S", "test.step", 4, false),
        ],
        &[
            edge("trigger", 0, "X1", 0),
            edge("trigger", 0, "X2", 0),
            edge("X1", 0, "T", 0),
            edge("X2", 0, "T", second_slot),
            edge("T", 0, "S", 0),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let first_turn = walk.settle(&readied(&trigger_turn, "X1"), &[first_count]);
    assert_eq!(describe(&first_turn), Vec::<String>::new());
    assert_eq!(open_rounds(&walk, "T"), [0]);
    let second_turn = walk.settle(&readied(&trigger_turn, "X2"), &[second_count]);
    assert_eq!(describe(&second_turn), expected);
    assert_eq!(open_rounds(&walk, "T"), Vec::<u64>::new());
    assert_eq!(open_rounds(&walk, "S"), Vec::<u64>::new());
}

/// A loop's back edge is the edge from its body into the loop node, whatever order the nodes take:
/// a body node also fed from outside, sorted before the loop, still has the loop node as a forward
/// feeder, and a loop nested in another's body takes the outer body's edge into it as its entry,
/// though the outer loop leads back round to that edge. Mutations: classify by a depth-first
/// walk's visiting order; take no kind as the loop; take every edge into a loop node from a node it
/// reaches as a back edge.
#[rstest]
#[case::fed_from_outside(
    vec![
        node("trigger", "test.trigger", 0, false),
        node("O", "test.step", 1, false),
        node("L", "test.loop", 2, false),
        node("B", "test.step", 3, false),
    ],
    vec![
        edge("trigger", 0, "O", 0),
        edge("trigger", 0, "L", 0),
        edge("O", 0, "B", 0),
        edge("L", 1, "B", 0),
        edge("B", 0, "L", 0),
    ],
    vec!["trigger <-", "O <- trigger", "L <- trigger", "B <- O L"]
)]
#[case::nested(
    vec![
        node("trigger", "test.trigger", 0, false),
        node("L1", "test.loop", 1, false),
        node("X", "test.step", 2, false),
        node("L2", "test.loop", 3, false),
        node("Y", "test.step", 4, false),
        node("Z", "test.step", 5, false),
    ],
    vec![
        edge("trigger", 0, "L1", 0),
        edge("L1", 1, "X", 0),
        edge("X", 0, "L2", 0),
        edge("L2", 1, "Y", 0),
        edge("Y", 0, "L2", 0),
        edge("L2", 0, "Z", 0),
        edge("Z", 0, "L1", 0),
    ],
    vec!["trigger <-", "L1 <- trigger", "X <- L1", "L2 <- X", "Y <- L2", "Z <- L2"]
)]
fn a_loops_back_edge_is_the_edge_from_its_body_into_it(
    #[case] nodes: Vec<WorkflowNode>,
    #[case] edges: Vec<WorkflowEdge>,
    #[case] expected: Vec<&str>,
) {
    let (walk, _start_turn) = start(nodes, &edges);
    let graph = &walk.graph;
    let feeders: Vec<String> = (0..graph.node_count())
        .map(|place| {
            let mut line = format!("{} <-", graph.node(place).id.as_str());
            for &feeder in graph.forward_feeders(place) {
                line.push(' ');
                line.push_str(graph.node(feeder).id.as_str());
            }
            line
        })
        .collect();
    assert_eq!(feeders, expected);
}

/// A node fed again runs under its next run index: a loop node counts its own passes, an empty
/// feed into a node with an open round is dropped, and a second feed into a filled slot opens the
/// next round instead of overwriting the first. Mutations: count the run index per run; let a
/// second feed overwrite the first; let an empty feed open a second round; ready a node on an
/// empty feed.
#[test]
fn a_node_fed_again_runs_under_its_next_run_index() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("B", "test.step", 2, false),
            node("D", "test.step", 3, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("B", 0, "L", 0),
            edge("L", 0, "D", 0),
            edge("L", 1, "B", 0),
        ],
    );
    let turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    assert_eq!(describe(&turn), ["ready L run 0 exec 1 from trigger:0@0"]);
    let turn = walk.settle(&readied(&turn, "L"), &[0, 2]);
    assert_eq!(describe(&turn), ["ready B run 0 exec 2 from L:1@1"]);
    assert_eq!(open_rounds(&walk, "D"), [0]);
    let turn = walk.settle(&readied(&turn, "B"), &[2]);
    assert_eq!(describe(&turn), ["ready L run 1 exec 3 from B:0@2"]);
    let turn = walk.settle(&readied(&turn, "L"), &[0, 2]);
    assert_eq!(describe(&turn), ["ready B run 1 exec 4 from L:1@3"]);
    assert_eq!(open_rounds(&walk, "D"), [0]);
    let turn = walk.settle(&readied(&turn, "B"), &[2]);
    assert_eq!(describe(&turn), ["ready L run 2 exec 5 from B:0@4"]);
    let turn = walk.settle(&readied(&turn, "L"), &[3, 0]);
    assert_eq!(describe(&turn), ["ready D run 0 exec 6 from L:0@5"]);
    assert_eq!(open_rounds(&walk, "D"), Vec::<u64>::new());

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
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "P"), &[1])),
        Vec::<String>::new()
    );
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "Q"), &[1])),
        Vec::<String>::new()
    );
    assert_eq!(open_rounds(&walk, "M"), [0, 1]);
    let r_turn = walk.settle(&readied(&trigger_turn, "R"), &[1]);
    assert_eq!(describe(&r_turn), ["ready M run 0 exec 4 from P:0@1 R:0@3"]);
    assert_eq!(open_rounds(&walk, "M"), [1]);
}

/// The answers of a walk over three siblings of equal `order` feeding one node, settled out of
/// their visiting order.
fn equal_order_siblings_answers() -> Vec<String> {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("c", "test.step", 1, false),
            node("a", "test.step", 1, false),
            node("b", "test.step", 1, false),
            node("J", "test.triple", 2, false),
        ],
        &[
            edge("trigger", 0, "c", 0),
            edge("trigger", 0, "a", 0),
            edge("trigger", 0, "b", 0),
            edge("c", 0, "J", 0),
            edge("a", 0, "J", 1),
            edge("b", 0, "J", 2),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let mut answer = describe(&trigger_turn);
    for sibling in ["b", "c", "a"] {
        answer.extend(describe(
            &walk.settle(&readied(&trigger_turn, sibling), &[1]),
        ));
    }
    answer
}

/// The answers of a walk over the first-to-arrive graph, every branch settling with items.
fn first_to_arrive_answers() -> Vec<String> {
    let (mut walk, start_turn) = first_to_arrive_walk();
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let mut answer = describe(&trigger_turn);
    for branch in ["A", "B"] {
        answer.extend(describe(
            &walk.settle(&readied(&trigger_turn, branch), &[1]),
        ));
    }
    let x_turn = walk.settle(&readied(&trigger_turn, "X"), &[1]);
    answer.extend(describe(&x_turn));
    answer.extend(describe(&walk.settle(&readied(&x_turn, "C"), &[1])));
    answer
}

/// Walks over graphs built from their own node maps answer the same settles alike, siblings of
/// equal `order` readied by id and a win's losers by execution index. Mutation: let a node map's
/// hash order reach an answer.
#[rstest]
#[case::equal_order_siblings(equal_order_siblings_answers, &[
    "ready a run 0 exec 1 from trigger:0@0",
    "ready b run 0 exec 2 from trigger:0@0",
    "ready c run 0 exec 3 from trigger:0@0",
    "ready J run 0 exec 4 from c:0@3 a:0@1 b:0@2",
])]
#[case::first_to_arrive(first_to_arrive_answers, &[
    "ready A run 0 exec 1 from trigger:0@0",
    "ready B run 0 exec 2 from trigger:0@0",
    "ready X run 0 exec 3 from trigger:0@0",
    "ready M run 0 exec 4 from A:0@1 - -",
    "win M exec 4 losers [B@2]",
    "ready C run 0 exec 5 from X:0@3",
    "ready Y run 0 exec 6 from X:0@3",
])]
fn the_same_settles_give_the_same_turns(
    #[case] walk_answers: fn() -> Vec<String>,
    #[case] expected: &[&str],
) {
    let answers: Vec<Vec<String>> = (0..8).map(|_| walk_answers()).collect();
    assert_eq!(answers[0], expected);
    assert!(
        answers.iter().all(|answer| *answer == answers[0]),
        "{answers:?}"
    );
}

/// A first-to-arrive node readies on its first input with items, passing that input in its spec
/// place, and its losers are only the live steps whose branch feeds nothing else; later feeds
/// close the won round without a second step, and with every branch empty nothing wins and the
/// flush skips it. Mutations: let an empty input win; cancel a shared ancestor (X); let a
/// straggler ready the node again; use the slot index as the spec position.
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
        [
            "ready C run 0 exec 5 from X:0@3",
            "ready Y run 0 exec 6 from X:0@3"
        ]
    );
    assert_eq!(open_rounds(&walk, "M"), [0]);
    assert_eq!(
        describe(&walk.settle(&readied(&x_turn, "C"), &[1])),
        Vec::<String>::new()
    );
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
/// turn's ready steps and canceled, and one decided later in that turn, run or skipped, is
/// canceled before it can feed the winner a second round. Mutations: follow a loop's back edge to
/// the losers, so none loses; let a won round take any feed; let it take none; leave a same-turn
/// loser ready; ready or skip a loser decided after the win.
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

    for is_disabled in [false, true] {
        let (mut walk, start_turn) = start(
            vec![
                node("trigger", "test.trigger", 0, false),
                node("M", "test.first", 1, false),
                node("B", "test.step", 2, is_disabled),
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

/// A disabled node's successor reads the items the skip passed on, through a chain of disabled
/// nodes, though no skip records outputs. Mutation: look a disabled skip up among the recorded
/// outputs, which panics.
#[test]
fn a_disabled_skips_successor_reads_the_items_it_passed_on() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("D1", "test.step", 1, true),
            node("D2", "test.step", 2, true),
            node("S", "test.step", 3, false),
        ],
        &[
            edge("trigger", 0, "D1", 0),
            edge("D1", 0, "D2", 0),
            edge("D2", 0, "S", 0),
        ],
    );
    let trigger_step = readied(&start_turn, "trigger");
    let turn = walk.settle(&trigger_step, &[1]);
    let s_ready = turn
        .ready
        .iter()
        .find(|ready| ready.step.node_id.as_str() == "S")
        .expect("the skips feed S");
    let items: Vec<WorkflowItem> = vec![
        serde_json::from_value(json!({ "json": { "number": 7 } })).expect("the test's item reads"),
    ];
    let mut outputs = StepOutputs::new([(trigger_step.node_id.clone(), "trigger".to_owned())]);
    outputs.record(
        StepKey {
            node_id: trigger_step.node_id.clone(),
            execution_index: 0,
        },
        StepOutput {
            sources: Vec::new(),
            outputs: vec![items.clone()],
        },
    );

    assert_eq!(walk.ready_inputs(s_ready, &outputs), [items]);
}

/// A retry readies the next attempt under the next execution index with the run index and sources
/// of the first, and the successor reads the retry's execution; a dropped step leaves the live
/// set, so the flush can ready what it fed no longer. Mutations: retry under a new run index;
/// reuse execution index 1, putting two rows on one key; leave a dropped step live.
#[test]
fn a_retry_keeps_its_run_index_and_a_dropped_step_frees_the_flush() {
    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("S", "test.step", 2, false),
        ],
        &[edge("trigger", 0, "A", 0), edge("A", 0, "S", 0)],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    let first_attempt = readied(&trigger_turn, "A");
    assert_eq!(
        (
            first_attempt.attempt.get(),
            first_attempt.execution_index.get()
        ),
        (1, 1)
    );
    let retry = walk.retry(&first_attempt);
    assert_eq!(
        (
            retry.step.attempt.get(),
            retry.step.execution_index.get(),
            retry.run_index
        ),
        (2, 2, 0)
    );
    assert_eq!(retry.sources, trigger_turn.ready[0].sources);
    assert_eq!(
        describe(&walk.settle(&retry.step, &[1])),
        ["ready S run 0 exec 3 from A:0@2"]
    );

    let (mut walk, start_turn) = start(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("P", "test.step", 1, false),
            node("Q", "test.step", 2, false),
            node("M", "test.pair", 3, false),
        ],
        &[
            edge("trigger", 0, "P", 0),
            edge("trigger", 0, "Q", 0),
            edge("P", 0, "M", 0),
            edge("Q", 0, "M", 1),
        ],
    );
    let trigger_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    assert_eq!(
        describe(&walk.settle(&readied(&trigger_turn, "P"), &[1])),
        Vec::<String>::new()
    );
    walk.drop_step(&readied(&trigger_turn, "Q"));
    assert_eq!(
        describe(&walk.flush()),
        ["ready M run 0 exec 3 from P:0@1 -"]
    );
}
