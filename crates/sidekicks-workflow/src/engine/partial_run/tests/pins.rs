//! A node whose pin changed since its step executes, and the nodes it feeds after it.

use std::collections::HashMap;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowContentHash;
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use super::{
    CHAIN, FIRST_RUN_ID, FIRST_VERSION_ID, RunRow, body, chain, chain_nodes, kept_runs, names,
    planned, reused_from, row, store_run_rows, store_versions,
};
use crate::engine::tick::RunPin;
use crate::test_rows::{test_node_id, workflow_tables};

/// The chain's `A`, switched off in both versions where `is_disabled`, ran in run 1 on the pin
/// whose hash is `recorded`, or was skipped as disabled, and this run pins `pinned` onto it: a pin
/// added, changed or removed makes `A` execute, and `B` and `C` after it, in either scope; the same
/// pin, or a pinned `A` still skipped as disabled, reuses `T`, `A` and `B`. Mutations: compare the
/// pin's presence only (`changed` reuses `A`); skip the comparison (`added`, `changed` and
/// `removed` reuse `A`); read a disabled skip's missing hash as a pin it ran on (`still_disabled`
/// executes `A`).
#[rstest]
#[case::added(false, None, Some("b3:pin"), true)]
#[case::changed(false, Some("b3:old"), Some("b3:new"), true)]
#[case::removed(false, Some("b3:old"), None, true)]
#[case::same(false, Some("b3:old"), Some("b3:old"), false)]
#[case::still_disabled(true, None, Some("b3:pin"), false)]
fn pins(
    #[case] is_disabled: bool,
    #[case] recorded: Option<&str>,
    #[case] pinned: Option<&str>,
    #[case] executes_pinned_node: bool,
    #[values(WorkflowNodeExecuteScope::FromHere, WorkflowNodeExecuteScope::Node)]
    scope: WorkflowNodeExecuteScope,
) {
    let connection = workflow_tables();
    let nodes = if is_disabled {
        chain_nodes("A", &json!({ "disabled": true }))
    } else {
        chain()
    };
    let chain = body(&nodes, CHAIN);
    store_versions(&connection, &chain, &chain);
    let pinned_step = RunRow {
        pin_hash: recorded,
        status: if is_disabled {
            WorkflowStepStatus::Skipped
        } else {
            WorkflowStepStatus::Succeeded
        },
        ..row("A", &[("T", 0)])
    };
    let rows = [
        row("T", &[]),
        pinned_step,
        row("B", &[("A", 1)]),
        row("C", &[("B", 2)]),
    ];
    store_run_rows(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, &rows);
    let pins: HashMap<_, _> = pinned
        .map(|hash| {
            let hash = NonEmptyText::new(hash.to_owned()).expect("the test's hash");
            let pin = RunPin {
                items: Vec::new(),
                hash: WorkflowContentHash(hash),
            };
            (test_node_id("A"), pin)
        })
        .into_iter()
        .collect();
    let (executed, kept) = if executes_pinned_node {
        (names(&["A", "B", "C"]), reused_from(FIRST_RUN_ID, &["T"]))
    } else {
        (names(&["C"]), reused_from(FIRST_RUN_ID, &["T", "A", "B"]))
    };
    let (reused, inputs) = match scope {
        WorkflowNodeExecuteScope::FromHere => (kept, Vec::new()),
        WorkflowNodeExecuteScope::Node => (Vec::new(), kept),
    };
    assert_eq!(
        kept_runs(planned(&connection, &chain, "C", scope, &pins)),
        (executed, reused, inputs)
    );
}
