//! What a node's own settings do to the items around its executor: a pin replaces the run, an
//! execute-once node reads only its first items, a per-item kind runs once per item, the engine
//! fills the lineage a kind leaves unset, and an always-output node never outputs nothing.

use serde_json::{Map, Value};
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::workflow::definition::document::WorkflowNode;
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowPairedItem, WorkflowPairedItems, WorkflowPinnedItem,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;

/// The outputs a pinned node gives in place of running, honored only in a manual run: its pinned
/// items on the first main output and every other of its `main_output_count` outputs empty, or
/// `None` when the run is not manual or nothing is pinned onto the node.
pub(crate) fn pinned_outputs(
    mode: WorkflowRunMode,
    pin_data: Option<&Record<String, Vec<WorkflowPinnedItem>>>,
    node: &WorkflowNode,
    main_output_count: usize,
) -> Option<Vec<Vec<WorkflowItem>>> {
    if mode != WorkflowRunMode::Manual {
        return None;
    }
    let pinned = pin_data?.as_map().get(node.id.as_str())?;
    let mut outputs = vec![pinned.iter().cloned().map(pinned_item).collect::<Vec<_>>()];
    outputs.resize_with(main_output_count.max(1), Vec::new);
    Some(outputs)
}

/// The inputs an execute-once node runs over: every input list, of every input handle, cut to
/// its first item; the inputs unchanged when the node does not set it.
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
pub(crate) fn per_item_calls(main_input: Vec<WorkflowItem>) -> Vec<Vec<Vec<WorkflowItem>>> {
    main_input
        .into_iter()
        .map(|item| vec![vec![item]])
        .collect()
}

/// A per-item kind's outputs: its calls' outputs joined handle by handle in call order, each
/// item's lineage pointing at the input item its call saw, since each call saw only that one.
/// No calls join to no outputs.
pub(crate) fn join_per_item_outputs(calls: Vec<Vec<Vec<WorkflowItem>>>) -> Vec<Vec<WorkflowItem>> {
    let mut joined: Vec<Vec<WorkflowItem>> = Vec::new();
    for (call_index, call_outputs) in calls.into_iter().enumerate() {
        let call_item = index(call_index);
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
/// among them, is left for the kind to set.
pub(crate) fn fill_paired_items(
    main_inputs: &[Vec<WorkflowItem>],
    outputs: &mut [Vec<WorkflowItem>],
) {
    let is_single_item = matches!(main_inputs, [only] if only.len() == 1);
    let is_same_count = matches!(
        (main_inputs, &*outputs),
        ([input], [output]) if input.len() == output.len()
    );
    if !is_single_item && !is_same_count {
        return;
    }
    for output in outputs.iter_mut() {
        for (position, item) in output.iter_mut().enumerate() {
            if item.paired_item.is_none() {
                let source = if is_single_item { 0 } else { position };
                item.paired_item = Some(WorkflowPairedItems::One(WorkflowPairedItem {
                    item: index(source),
                    input: None,
                }));
            }
        }
    }
}

/// Gives an always-output node one empty item on its first output where that output is missing
/// or empty, its lineage every item of every main input, input by input; the outputs unchanged
/// when the node does not set it or its first output holds an item.
pub(crate) fn ensure_output_item(
    node: &WorkflowNode,
    main_inputs: &[Vec<WorkflowItem>],
    outputs: &mut Vec<Vec<WorkflowItem>>,
) {
    if node.always_output_data != Some(true)
        || outputs.first().is_some_and(|first| !first.is_empty())
    {
        return;
    }
    let lineage = main_inputs
        .iter()
        .enumerate()
        .flat_map(|(input_index, input)| {
            (0..input.len()).map(move |item_index| WorkflowPairedItem {
                item: index(item_index),
                input: Some(index(input_index)),
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

fn index(position: usize) -> SafeInt<0> {
    u64::try_from(position)
        .ok()
        .and_then(SafeInt::new)
        .expect("a list held in memory is shorter than 2^53 items")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use rstest::rstest;
    use serde_json::json;

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
            item: index(item),
            input: None,
        })
    }

    /// A pin shows only in a manual run, on output 0 alone. Mutations: drop the mode check (test
    /// data in a production run); copy the pins onto every output.
    #[rstest]
    #[case::manual_with_pin(WorkflowRunMode::Manual, "pinned", true)]
    #[case::trigger_with_pin(WorkflowRunMode::Trigger, "pinned", false)]
    #[case::manual_without_pin(WorkflowRunMode::Manual, "other", false)]
    fn a_pin_replaces_the_run_only_in_a_manual_run(
        #[case] mode: WorkflowRunMode,
        #[case] node_id: &str,
        #[case] is_pinned: bool,
    ) {
        let pinned: WorkflowPinnedItem =
            serde_json::from_value(json!({ "json": { "a": 1 }, "pairedItem": { "item": 0 } }))
                .expect("the test's pinned item reads");
        let pin_data = Record::new(BTreeMap::from([("pinned".to_owned(), vec![pinned])]))
            .expect("the test's pin data reads");

        let outputs = pinned_outputs(mode, Some(&pin_data), &node(node_id, None, None), 2);

        let expected = is_pinned.then(|| {
            let mut pinned_item = item(&json!({ "a": 1 }));
            pinned_item.paired_item = Some(one(0));
            vec![vec![pinned_item], Vec::new()]
        });
        assert_eq!(outputs, expected);
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
        let main_inputs: Vec<_> = input_counts.iter().map(|count| items(*count)).collect();
        let mut outputs: Vec<_> = output_counts.iter().map(|count| items(*count)).collect();
        if let Some(source) = item_one_set_to {
            outputs[0][1].paired_item = Some(one(source));
        }

        fill_paired_items(&main_inputs, &mut outputs);

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

    /// An always-output node with nothing on output 0 gives one empty item paired to every input
    /// item, input by input. Mutations: drop the input index; add the item when output 0 has items.
    #[rstest]
    #[case::empty(Some(true), 0, true)]
    #[case::has_items(Some(true), 1, false)]
    #[case::unset(None, 0, false)]
    fn an_always_output_node_never_outputs_nothing(
        #[case] always_output_data: Option<bool>,
        #[case] output_count: usize,
        #[case] is_added: bool,
    ) {
        let mut outputs = vec![items(output_count), items(1)];

        ensure_output_item(
            &node("node", None, always_output_data),
            &[items(2), items(1)],
            &mut outputs,
        );

        let paired = |item: usize, input: usize| WorkflowPairedItem {
            item: index(item),
            input: Some(index(input)),
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
