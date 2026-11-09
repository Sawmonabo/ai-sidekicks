//! The environment-name rule, the settings file's read and the environment row's entry bound.

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    ENVIRONMENT_ENTRY_MAX_UNITS, EnvironmentNameRefusalReason, MachineSettingsUpdateRequest,
    environment_name_refusal, parse_machine_settings_file,
};
use crate::project::ProjectEnvironmentUpdateRequest;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentNameCase {
    name: String,
    refusal: Option<EnvironmentNameRefusalReason>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFileCase {
    file: Value,
    settings: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MachineSettingsCases {
    environment_names: Vec<EnvironmentNameCase>,
    settings_files: Vec<SettingsFileCase>,
}

fn cases() -> MachineSettingsCases {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/machine-settings.json"
    ))
    .expect("the case table parses")
}

#[test]
fn a_row_name_is_refused_for_the_reason_the_table_gives() {
    for case in cases().environment_names {
        assert_eq!(
            environment_name_refusal(&case.name),
            case.refusal,
            "{}",
            case.name
        );
    }
}

#[test]
fn a_settings_file_reads_over_the_defaults_or_is_refused_whole() {
    for case in cases().settings_files {
        let read = parse_machine_settings_file(case.file.clone())
            .ok()
            .map(|settings| serde_json::to_value(settings).expect("settings serialize"));
        assert_eq!(read, case.settings, "{}", case.file);
    }
}

// A name and a value that each fit their own cap still make an entry Windows refuses once
// `NAME=value` and its NUL pass the bound, counted in UTF-16 units: a value of emoji, two units and
// four bytes each, sits at the bound in units. Fails when `EnvironmentRow`'s `fits_one_entry` check
// is dropped, leaves out the `=` or the NUL, or counts bytes or code points (the emoji value is
// refused at the bound, or accepted past it), or when the machine update's, the file's or the
// project update's `#[garde(dive)]` toward the rows is.
#[test]
fn a_row_whose_whole_entry_passes_the_bound_is_refused() {
    let name = "A".repeat(ENVIRONMENT_ENTRY_MAX_UNITS / 2);
    let value_units = ENVIRONMENT_ENTRY_MAX_UNITS - name.len() - 2;
    let ascii_at_bound = "b".repeat(value_units);
    let emoji_at_bound = "\u{1F600}".repeat(value_units / 2);
    for (value, is_accepted) in [
        (ascii_at_bound.clone(), true),
        (format!("{ascii_at_bound}b"), false),
        (emoji_at_bound.clone(), true),
        (format!("{emoji_at_bound}b"), false),
    ] {
        let rows = json!([{ "name": name, "value": value }]);
        let request: MachineSettingsUpdateRequest =
            serde_json::from_value(json!({ "change": { "environmentRows": rows } }))
                .expect("each field fits its own cap");
        assert_eq!(garde::Validate::validate(&request).is_ok(), is_accepted);
        let file = parse_machine_settings_file(json!({ "environmentRows": rows }));
        assert_eq!(file.is_ok(), is_accepted);
        let project: ProjectEnvironmentUpdateRequest = serde_json::from_value(json!({
            "projectId": "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e01", "environmentRows": rows,
        }))
        .expect("each field fits its own cap");
        assert_eq!(garde::Validate::validate(&project).is_ok(), is_accepted);
    }
}
