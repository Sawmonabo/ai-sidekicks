use rstest::rstest;
use serde_json::{Value, json};

use super::fill_workflow_trigger_inputs;
use crate::workflow::definition::document::WorkflowTriggerInput;
use crate::workflow::definition::item::WorkflowItem;

/// A required text input and an optional flag that starts on `true`.
fn declared() -> Vec<WorkflowTriggerInput> {
    serde_json::from_value(json!([
        { "name": "branch", "type": "string", "required": true, "default": "" },
        { "name": "dryRun", "type": "boolean", "default": true },
    ]))
    .expect("the inputs read")
}

#[rstest]
#[case::a_required_input_left_out(declared(), json!({ "dryRun": false }), Err(vec!["branch"]))]
#[case::inputs_given_values_that_do_not_fit(
    declared(),
    json!({ "branch": 7, "dryRun": "yes" }),
    Err(vec!["branch", "dryRun"]),
)]
#[case::an_optional_input_left_out_takes_its_default(
    declared(),
    json!({ "branch": "main" }),
    Ok(json!({ "branch": "main", "dryRun": true })),
)]
#[case::every_input_filled(
    declared(),
    json!({ "branch": "main", "dryRun": false }),
    Ok(json!({ "branch": "main", "dryRun": false })),
)]
#[case::no_declared_inputs_on_an_empty_start(vec![], Value::Null, Ok(json!({})))]
fn a_start_fills_the_declared_inputs_or_names_those_it_lacks(
    #[case] declared: Vec<WorkflowTriggerInput>,
    #[case] start: Value,
    #[case] expected: Result<Value, Vec<&str>>,
) {
    let input: Vec<WorkflowItem> = if start.is_null() {
        vec![]
    } else {
        serde_json::from_value(json!([{ "json": start }])).expect("the items read")
    };
    let filled = fill_workflow_trigger_inputs(&declared, &input)
        .map(|values| serde_json::to_value(values).expect("the values write"))
        .map_err(|details| {
            let names = details.input_names.as_slice().iter();
            names
                .map(|name| name.as_str().to_owned())
                .collect::<Vec<_>>()
        });
    let expected: Result<Value, Vec<String>> =
        expected.map_err(|names| names.into_iter().map(str::to_owned).collect());
    assert_eq!(filled, expected);
}
