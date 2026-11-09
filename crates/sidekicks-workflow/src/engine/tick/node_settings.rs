//! What a node's own settings do to the items around its executor: a pin replaces the run, an
//! execute-once node reads only its first items, a per-item kind runs once per item, the engine
//! fills the lineage a kind leaves unset, and an always-output node never outputs nothing.

use serde_json::{Map, Value};
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowNode;
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowPairedItem, WorkflowPairedItems, WorkflowPinnedItem,
};
use sidekicks_contracts::workflow::kind::{WorkflowNodeKindSpec, WorkflowOutputHandleSpec};

use super::RunPin;

/// The main inputs among a step's `inputs`, one list per input handle of `spec` in spec order: the
/// lists at the inputs whose `is_tool()` is false, in spec order, borrowed or taken as `inputs` is.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn main_inputs<Input>(
    spec: &WorkflowNodeKindSpec,
    inputs: impl IntoIterator<Item = Input>,
) -> impl Iterator<Item = Input> {
    spec.inputs
        .as_slice()
        .iter()
        .zip(inputs)
        .filter(|(handle, _)| !handle.is_tool())
        .map(|(_, items)| items)
}

/// How many main inputs a kind lists: its inputs whose `is_tool()` is false.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn main_input_count(spec: &WorkflowNodeKindSpec) -> usize {
    spec.inputs
        .as_slice()
        .iter()
        .filter(|input| !input.is_tool())
        .count()
}

/// How many items each of a step's main inputs holds, in spec order.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn main_input_lengths(
    spec: &WorkflowNodeKindSpec,
    inputs: &[Vec<WorkflowItem>],
) -> Vec<usize> {
    main_inputs(spec, inputs).map(Vec::len).collect()
}

/// How many main outputs `outputs` lists: those whose `is_tool()` is false. A kind's spec lists
/// only what its executor gives; a node's handles also count the error output it adds.
pub(crate) fn main_output_count(outputs: &[WorkflowOutputHandleSpec]) -> usize {
    outputs.iter().filter(|output| !output.is_tool()).count()
}

/// The outputs a pinned node gives in place of running: its `pin`'s items on the first main output
/// and every other of its `main_output_count` outputs empty. A run holds pins only when manual.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn pinned_outputs(pin: &RunPin, main_output_count: usize) -> Vec<Vec<WorkflowItem>> {
    let items = pin.items.iter().cloned().map(pinned_item).collect();
    place_on_first_output(items, main_output_count)
}

/// The outputs of a step that gives `items` whole: `items` on the first main output and every
/// other of its `main_output_count` outputs empty, one output at the least.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn place_on_first_output(
    items: Vec<WorkflowItem>,
    main_output_count: usize,
) -> Vec<Vec<WorkflowItem>> {
    let mut outputs = vec![items];
    outputs.resize_with(main_output_count.max(1), Vec::new);
    outputs
}

/// The inputs an execute-once node runs over: every input list, of every input handle, cut to
/// its first item; the inputs unchanged when the node does not set it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn execute_once_inputs(
    node: &WorkflowNode,
    mut inputs: Vec<Vec<WorkflowItem>>,
) -> Vec<Vec<WorkflowItem>> {
    if node.execute_once == Some(true) {
        for input in &mut inputs {
            input.truncate(1);
        }
    }
    inputs
}

/// The calls a per-item kind makes over its one main input: one call per item, in item order,
/// each call's inputs a single list holding that item.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn per_item_calls(main_input: Vec<WorkflowItem>) -> Vec<Vec<Vec<WorkflowItem>>> {
    main_input
        .into_iter()
        .map(|item| vec![vec![item]])
        .collect()
}

/// A per-item kind's outputs: its calls' outputs joined handle by handle in call order, each
/// item's lineage pointing at the input item its call saw, since each call saw only that one.
/// No calls join to no outputs.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn join_per_item_outputs(calls: Vec<Vec<Vec<WorkflowItem>>>) -> Vec<Vec<WorkflowItem>> {
    let mut joined: Vec<Vec<WorkflowItem>> = Vec::new();
    for (call_index, call_outputs) in calls.into_iter().enumerate() {
        let call_item = SafeInt::from_usize(call_index);
        if joined.len() < call_outputs.len() {
            joined.resize_with(call_outputs.len(), Vec::new);
        }
        for (joined_output, call_output) in joined.iter_mut().zip(call_outputs) {
            joined_output.extend(call_output.into_iter().map(|mut item| {
                item.paired_item = Some(lineage_at(item.paired_item.take(), call_item));
                item
            }));
        }
    }
    joined
}

/// Fills the lineage of every output item whose `pairedItem` is unset, where it can only be one
/// thing: every item came from the one item of a single main input, or a single main input and a
/// single output hold as many items each and item k came from item k. Any other shape, a collapse
/// among them, is left for the kind to set. `main_input_lengths` is how many items each main input
/// held.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn fill_paired_items(main_input_lengths: &[usize], outputs: &mut [Vec<WorkflowItem>]) {
    let is_single_item = matches!(main_input_lengths, [1]);
    let is_same_count = matches!(
        (main_input_lengths, &*outputs),
        ([input_length], [output]) if *input_length == output.len()
    );
    if !is_single_item && !is_same_count {
        return;
    }
    for output in outputs.iter_mut() {
        for (position, item) in output.iter_mut().enumerate() {
            if item.paired_item.is_none() {
                let source = if is_single_item { 0 } else { position };
                item.paired_item = Some(WorkflowPairedItems::One(WorkflowPairedItem {
                    item: SafeInt::from_usize(source),
                    input: None,
                }));
            }
        }
    }
}

/// Shapes the outputs a node gives, pinned or run, around main inputs holding as many items as
/// `main_input_lengths` says: the lineage it can only have is filled in, then an always-output node
/// gains its empty item.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn shape_outputs(
    node: &WorkflowNode,
    main_input_lengths: &[usize],
    outputs: &mut Vec<Vec<WorkflowItem>>,
) {
    fill_paired_items(main_input_lengths, outputs);
    ensure_output_item(node, main_input_lengths, outputs);
}

/// Gives an always-output node one empty item on its first output where that output is missing
/// or empty, its lineage every item of every main input, input by input, each main input holding
/// as many items as `main_input_lengths` says; the outputs unchanged when the node does not set it
/// or its first output holds an item.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn ensure_output_item(
    node: &WorkflowNode,
    main_input_lengths: &[usize],
    outputs: &mut Vec<Vec<WorkflowItem>>,
) {
    if node.always_output_data != Some(true)
        || outputs.first().is_some_and(|first| !first.is_empty())
    {
        return;
    }
    let lineage = main_input_lengths
        .iter()
        .enumerate()
        .flat_map(|(input_index, input_length)| {
            (0..*input_length).map(move |item_index| WorkflowPairedItem {
                item: SafeInt::from_usize(item_index),
                input: Some(SafeInt::from_usize(input_index)),
            })
        })
        .collect();
    let empty_item = WorkflowItem {
        json: AnyValue(Value::Object(Map::new())),
        binary: None,
        paired_item: Some(WorkflowPairedItems::Many(lineage)),
        error: None,
    };
    match outputs.first_mut() {
        Some(first) => *first = vec![empty_item],
        None => outputs.push(vec![empty_item]),
    }
}

/// A pinned item as the item it stands for; a pinned item never carries a binary value.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn pinned_item(pinned: WorkflowPinnedItem) -> WorkflowItem {
    WorkflowItem {
        json: pinned.json,
        binary: None,
        paired_item: pinned.paired_item,
        error: pinned.error,
    }
}

/// `lineage` with every entry pointing at input item `call_item`, its input kept; an unset one
/// becomes that item alone.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn lineage_at(lineage: Option<WorkflowPairedItems>, call_item: SafeInt<0>) -> WorkflowPairedItems {
    match lineage {
        None => WorkflowPairedItems::One(WorkflowPairedItem {
            item: call_item,
            input: None,
        }),
        Some(WorkflowPairedItems::One(entry)) => WorkflowPairedItems::One(WorkflowPairedItem {
            item: call_item,
            ..entry
        }),
        Some(WorkflowPairedItems::Many(entries)) => WorkflowPairedItems::Many(
            entries
                .into_iter()
                .map(|entry| WorkflowPairedItem {
                    item: call_item,
                    ..entry
                })
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::wire::text::NonEmptyText;
    use sidekicks_contracts::workflow::definition::document::WorkflowContentHash;

    use super::*;

    /// A node `id` with `executeOnce` and `alwaysOutputData` as given.
    fn node(
        id: &str,
        execute_once: Option<bool>,
        always_output_data: Option<bool>,
    ) -> WorkflowNode {
        let mut node = json!({
            "id": id, "kind": "test.step", "kindVersion": 1, "name": id, "order": 0, "params": {},
        });
        if let Some(execute_once) = execute_once {
            node["executeOnce"] = json!(execute_once);
        }
        if let Some(always_output_data) = always_output_data {
            node["alwaysOutputData"] = json!(always_output_data);
        }
        serde_json::from_value(node).expect("the test's node reads")
    }

    /// An item holding `value`, with no lineage.
    fn item(value: &Value) -> WorkflowItem {
        WorkflowItem {
            json: AnyValue(value.clone()),
            binary: None,
            paired_item: None,
            error: None,
        }
    }

    /// `count` items holding 0 to `count - 1`.
    fn items(count: usize) -> Vec<WorkflowItem> {
        (0..count).map(|position| item(&json!(position))).collect()
    }

    /// The lineage pointing at input item `item` on no named input.
    fn one(item: usize) -> WorkflowPairedItems {
        WorkflowPairedItems::One(WorkflowPairedItem {
            item: SafeInt::from_usize(item),
            input: None,
        })
    }

    /// A pin's items show on output 0 alone, their lineage kept. Mutation: copy the pins onto
    /// every output in `pinned_outputs`.
    #[test]
    fn a_pin_gives_its_items_on_the_first_output() {
        let pinned: WorkflowPinnedItem =
            serde_json::from_value(json!({ "json": { "a": 1 }, "pairedItem": { "item": 0 } }))
                .expect("the test's pinned item reads");
        let pin = RunPin {
            items: vec![pinned],
            hash: WorkflowContentHash(
                NonEmptyText::new("b3:pin".to_owned()).expect("the test's hash is text"),
            ),
        };

        let outputs = pinned_outputs(&pin, 2);

        let mut pinned_item = item(&json!({ "a": 1 }));
        pinned_item.paired_item = Some(one(0));
        assert_eq!(outputs, vec![vec![pinned_item], Vec::new()]);
    }

    /// Execute once cuts every input to its first item. Mutation: cut only input 0.
    #[rstest]
    #[case::set(Some(true), &[1, 1])]
    #[case::unset(None, &[3, 2])]
    fn execute_once_cuts_every_input_to_its_first_item(
        #[case] execute_once: Option<bool>,
        #[case] expected_counts: &[usize],
    ) {
        let inputs =
            execute_once_inputs(&node("node", execute_once, None), vec![items(3), items(2)]);

        let expected: Vec<_> = expected_counts.iter().map(|count| items(*count)).collect();
        assert_eq!(inputs, expected);
    }

    /// The engine fills lineage only where it can only be one thing. Mutations: add the many-to-one
    /// fill; overwrite a lineage the kind set; fill by equal count on a two-output node; fill
    /// across two inputs.
    #[rstest]
    #[case::one_item_in(&[1], &[2, 1], None, vec![vec![Some(0), Some(0)], vec![Some(0)]])]
    #[case::equal_count(&[3], &[3], None, vec![vec![Some(0), Some(1), Some(2)]])]
    #[case::collapse(&[3], &[1], None, vec![vec![None]])]
    #[case::kind_set(&[3], &[3], Some(2), vec![vec![Some(0), Some(2), Some(2)]])]
    #[case::equal_count_on_two_outputs(&[3], &[3, 0], None, vec![vec![None, None, None], vec![]])]
    #[case::two_inputs_of_one(&[1, 1], &[1], None, vec![vec![None]])]
    #[case::two_inputs_equal_count(&[2, 1], &[2], None, vec![vec![None, None]])]
    fn lineage_is_filled_only_where_it_is_certain(
        #[case] input_counts: &[usize],
        #[case] output_counts: &[usize],
        #[case] item_one_set_to: Option<usize>,
        #[case] expected: Vec<Vec<Option<usize>>>,
    ) {
        let mut outputs: Vec<_> = output_counts.iter().map(|count| items(*count)).collect();
        if let Some(source) = item_one_set_to {
            outputs[0][1].paired_item = Some(one(source));
        }

        fill_paired_items(input_counts, &mut outputs);

        let lineage: Vec<Vec<_>> = outputs
            .into_iter()
            .map(|output| output.into_iter().map(|item| item.paired_item).collect())
            .collect();
        let expected: Vec<Vec<_>> = expected
            .into_iter()
            .map(|output| output.into_iter().map(|source| source.map(one)).collect())
            .collect();
        assert_eq!(lineage, expected);
    }

    /// A kind whose inputs and outputs are each a main handle, a tool handle and a main handle.
    fn main_tool_main_spec() -> WorkflowNodeKindSpec {
        serde_json::from_value(json!({
            "kind": "test.step", "version": 1, "category": "developer",
            "displayName": "Test", "description": "A test kind.", "icon": "test",
            "params": [], "outputsDeriveFromParams": false,
            "inputs": [
                { "type": "main", "id": "inputs/main/0", "label": "A" },
                { "type": "tool", "id": "inputs/tool/0", "label": "Tool" },
                { "type": "main", "id": "inputs/main/1", "label": "B" },
            ],
            "outputs": [
                { "type": "main", "id": "outputs/main/0", "label": "A" },
                { "type": "tool", "id": "outputs/tool/0", "label": "Tool" },
                { "type": "main", "id": "outputs/main/1", "label": "B" },
            ],
        }))
        .expect("the test kind's spec reads")
    }

    /// An always-output node with nothing on output 0 gives one empty item paired to every item of
    /// its main inputs, input by input, its tool input skipped; the kind gives as many outputs as
    /// it has main ones. Mutations: drop the input index; add the item when output 0 has items;
    /// count a tool input; count a tool output.
    #[rstest]
    #[case::empty(Some(true), 0, true)]
    #[case::has_items(Some(true), 1, false)]
    #[case::unset(None, 0, false)]
    fn an_always_output_node_never_outputs_nothing(
        #[case] always_output_data: Option<bool>,
        #[case] output_count: usize,
        #[case] is_added: bool,
    ) {
        let spec = main_tool_main_spec();
        assert_eq!(main_output_count(spec.outputs.as_slice()), 2);
        let main_input_lengths = main_input_lengths(&spec, &[items(2), Vec::new(), items(1)]);
        assert_eq!(main_input_lengths, [2, 1]);
        let mut outputs = vec![items(output_count), items(1)];

        ensure_output_item(
            &node("node", None, always_output_data),
            &main_input_lengths,
            &mut outputs,
        );

        let paired = |item: usize, input: usize| WorkflowPairedItem {
            item: SafeInt::from_usize(item),
            input: Some(SafeInt::from_usize(input)),
        };
        let first = if is_added {
            vec![WorkflowItem {
                json: AnyValue(json!({})),
                binary: None,
                paired_item: Some(WorkflowPairedItems::Many(vec![
                    paired(0, 0),
                    paired(1, 0),
                    paired(0, 1),
                ])),
                error: None,
            }]
        } else {
            items(output_count)
        };
        assert_eq!(outputs, vec![first, items(1)]);
    }

    /// A per-item kind runs once per item, and its calls join in call order with each item paired
    /// to its call's input item, a lineage the kind set included. Mutations: drop the remap; join
    /// out of call order.
    #[test]
    fn per_item_calls_join_in_order_paired_to_their_item() {
        let calls = per_item_calls(items(2));
        assert_eq!(
            calls,
            vec![vec![vec![item(&json!(0))]], vec![vec![item(&json!(1))]]]
        );

        let mut kind_set = item(&json!("b1"));
        kind_set.paired_item = Some(one(0));
        let joined = join_per_item_outputs(vec![
            vec![vec![item(&json!("a"))]],
            vec![vec![kind_set, item(&json!("b2"))]],
        ]);

        let with_lineage = |value: &str, source: usize| {
            let mut joined_item = item(&json!(value));
            joined_item.paired_item = Some(one(source));
            joined_item
        };
        assert_eq!(
            joined,
            vec![vec![
                with_lineage("a", 0),
                with_lineage("b1", 1),
                with_lineage("b2", 1)
            ]]
        );
    }
}
