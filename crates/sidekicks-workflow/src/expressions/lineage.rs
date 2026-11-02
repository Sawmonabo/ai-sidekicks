//! The steps a run has taken so far, as an expression reads them, and the walk back through each
//! item's `pairedItem` from the current item to the item of an earlier node that it came from.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the evaluator thread, which holds a run's step outputs for its expressions"
    )
)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowPairedItem, WorkflowPairedItems,
};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepSource;

/// One execution of a node: the node and which of its executions, counted through the run.
#[derive(Clone, Debug)]
pub(crate) struct StepKey {
    /// The node.
    pub(crate) node_id: WorkflowNodeId,
    /// Which execution of it.
    pub(crate) execution_index: u64,
}

/// What one execution of a node read and wrote: the feed of each input slot and the items of
/// each output handle.
#[derive(Debug)]
pub(crate) struct StepOutput {
    /// Per input slot, the output that fed it, or `None` for a slot nothing fed.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
    /// Per output handle, the items it wrote; empty for a step still running.
    pub(crate) outputs: Vec<Vec<WorkflowItem>>,
}

/// A run's steps as its expressions read them: each node's executions in order, and the id index
/// that resolves a label to its node, so a renamed node is still found by its new label. The tick
/// clones it once per turn for the steps that turn dispatches, at one pointer per execution
/// recorded plus the shared labels.
#[derive(Clone, Debug, Default)]
pub(crate) struct StepOutputs {
    /// The labels of the run's nodes, which every clone shares.
    labels: Arc<NodeLabels>,
    /// Each node's executions by execution index.
    steps: HashMap<WorkflowNodeId, BTreeMap<u64, Arc<StepOutput>>>,
}

/// The labels of a run's nodes, both ways.
#[derive(Debug, Default)]
struct NodeLabels {
    /// Each node's id by its label.
    node_ids_by_label: HashMap<String, WorkflowNodeId>,
    /// Each node's label by its id.
    labels_by_node_id: HashMap<WorkflowNodeId, String>,
}

impl StepOutputs {
    /// The steps of a run over `nodes`, each a node's id and label, before any step ran.
    pub(crate) fn new(nodes: impl IntoIterator<Item = (WorkflowNodeId, String)>) -> Self {
        let mut labels = NodeLabels::default();
        for (node_id, label) in nodes {
            labels
                .node_ids_by_label
                .insert(label.clone(), node_id.clone());
            labels.labels_by_node_id.insert(node_id, label);
        }
        Self {
            labels: Arc::new(labels),
            steps: HashMap::new(),
        }
    }

    /// Records what the execution `key` read and wrote, replacing what it held.
    pub(crate) fn record(&mut self, key: StepKey, output: StepOutput) {
        self.steps
            .entry(key.node_id)
            .or_default()
            .insert(key.execution_index, Arc::new(output));
    }

    /// The node labeled `label`; fails with [`LineageError::UnknownLabel`] when no node is.
    pub(crate) fn node_id(&self, label: &str) -> Result<&WorkflowNodeId, LineageError> {
        self.labels
            .node_ids_by_label
            .get(label)
            .ok_or_else(|| LineageError::UnknownLabel {
                label: label.to_owned(),
            })
    }

    /// The latest execution of `node_id`, or `None` while it has not run.
    pub(crate) fn latest_step(&self, node_id: &WorkflowNodeId) -> Option<&StepOutput> {
        self.steps
            .get(node_id)
            .and_then(|executions| executions.last_key_value())
            .map(|(_, output)| output.as_ref())
    }

    /// The execution `key`, or `None` when it has not run.
    pub(crate) fn step(&self, key: &StepKey) -> Option<&StepOutput> {
        self.steps
            .get(&key.node_id)
            .and_then(|executions| executions.get(&key.execution_index))
            .map(Arc::as_ref)
    }

    /// The label a person reads for `node_id`.
    fn label(&self, node_id: &WorkflowNodeId) -> String {
        self.labels
            .labels_by_node_id
            .get(node_id)
            .expect("every step runs a node of the run's document, which the labels hold")
            .clone()
    }

    /// How many executions the run recorded, which bounds a walk back through them.
    fn execution_count(&self) -> usize {
        self.steps.values().map(BTreeMap::len).sum()
    }
}

/// Why `$item('<label>')` found no item: no node has the label, the item's way back never passes
/// it, a node on the way back recorded no lineage for the item, or a node on the way back made the
/// item from several.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum LineageError {
    /// No node is labeled `label`.
    #[error("No node is labeled '{label}'.")]
    UnknownLabel {
        /// The label the expression named.
        label: String,
    },
    /// The item's way back reaches the trigger or a slot nothing fed before it reaches `label`.
    #[error(
        "Can't follow this item back to '{label}': it didn't come through '{label}'. Use \
         $first('{label}'), $last('{label}') or $all('{label}')[i] instead."
    )]
    NotUpstream {
        /// The label the expression named.
        label: String,
    },
    /// `at_node` recorded no item this item came from, so the walk back to `label` stops there.
    #[error(
        "Can't follow this item back to '{label}': '{at_node}' doesn't record which item it came \
         from. Use $first('{label}'), $last('{label}') or $all('{label}')[i] instead."
    )]
    LineageMissing {
        /// The label the expression named.
        label: String,
        /// The label of the node whose item has no lineage.
        at_node: String,
    },
    /// `at_node` made this item from several items, so the walk back to `label` has no one answer.
    #[error(
        "Can't follow this item back to '{label}': '{at_node}' made it from several items. Use \
         $first('{label}'), $last('{label}') or $all('{label}')[i] instead."
    )]
    Ambiguous {
        /// The label the expression named.
        label: String,
        /// The label of the node that made the item from several.
        at_node: String,
    },
}

/// The item of the node labeled `to_label` that input item `item_index` of the execution `from`
/// came from, found by walking each item's `pairedItem` back through the slot its `input` names.
/// Fails with [`LineageError::UnknownLabel`] for a label no node has, with
/// [`LineageError::NotUpstream`] where the walk reaches the trigger or a slot nothing fed, with
/// [`LineageError::LineageMissing`] where an item on the way records no lineage or the walk goes
/// round more steps than the run recorded, which only a cycle in the records does, and with
/// [`LineageError::Ambiguous`] where an item came from several.
pub(crate) fn walk_paired_item<'steps>(
    steps: &'steps StepOutputs,
    from: &StepKey,
    item_index: usize,
    to_label: &str,
) -> Result<&'steps WorkflowItem, LineageError> {
    let target = steps.node_id(to_label)?;
    let lineage_missing = |node_id: &WorkflowNodeId| LineageError::LineageMissing {
        label: to_label.to_owned(),
        at_node: steps.label(node_id),
    };
    let mut at = from.clone();
    let mut paired_item = WorkflowPairedItem {
        item: u64::try_from(item_index)
            .ok()
            .and_then(SafeInt::new)
            .ok_or_else(|| lineage_missing(&at.node_id))?,
        input: None,
    };
    // Each hop reaches an earlier execution, so a walk past the run's executions is in a cycle.
    for _ in 0..steps.execution_count() {
        let step = steps
            .step(&at)
            .ok_or_else(|| lineage_missing(&at.node_id))?;
        let source = usize::try_from(paired_item.input.map_or(0, SafeInt::get))
            .ok()
            .and_then(|slot| step.sources.get(slot))
            .and_then(Option::as_ref)
            .ok_or_else(|| LineageError::NotUpstream {
                label: to_label.to_owned(),
            })?;
        let upstream = StepKey {
            node_id: source.node_id.clone(),
            execution_index: source.execution_index.get(),
        };
        let upstream_step = steps
            .step(&upstream)
            .ok_or_else(|| lineage_missing(&upstream.node_id))?;
        let item = usize::try_from(source.output_index.get())
            .ok()
            .and_then(|output| upstream_step.outputs.get(output))
            .and_then(|items| {
                usize::try_from(paired_item.item.get())
                    .ok()
                    .and_then(|index| items.get(index))
            })
            .ok_or_else(|| lineage_missing(&upstream.node_id))?;
        if upstream.node_id == *target {
            return Ok(item);
        }
        // A step nothing feeds, the trigger, starts every way back, so the label is not on this one.
        if upstream_step.sources.is_empty() {
            return Err(LineageError::NotUpstream {
                label: to_label.to_owned(),
            });
        }
        paired_item = match &item.paired_item {
            Some(WorkflowPairedItems::One(only)) => *only,
            Some(WorkflowPairedItems::Many(several)) => match several.as_slice() {
                [only] => *only,
                [] => return Err(lineage_missing(&upstream.node_id)),
                [_, _, ..] => {
                    return Err(LineageError::Ambiguous {
                        label: to_label.to_owned(),
                        at_node: steps.label(&upstream.node_id),
                    });
                }
            },
            None => return Err(lineage_missing(&upstream.node_id)),
        };
        at = upstream;
    }
    Err(lineage_missing(&at.node_id))
}

#[cfg(test)]
mod tests;
