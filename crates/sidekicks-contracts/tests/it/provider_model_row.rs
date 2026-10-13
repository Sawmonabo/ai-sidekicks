//! The catalog row a model choice names, read from the case table the TypeScript suite also reads.

use std::path::Path;

use serde::Deserialize;
use sidekicks_contracts::provider::driver::capabilities::{ProviderModel, find_provider_model_row};

/// The case table: one catalog and the choices made against it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseTable {
    rows: Vec<ProviderModel>,
    cases: Vec<Case>,
}

/// One choice and the row it must find, by index, or none.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    model_id: String,
    larger_window: bool,
    expected_index: Option<usize>,
}

#[test]
fn finds_the_row_by_model_id_and_window() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/provider-model-row.json");
    let text = std::fs::read_to_string(path).expect("the case table reads");
    let table: CaseTable = serde_json::from_str(&text).expect("the case table parses");
    for case in &table.cases {
        let found =
            find_provider_model_row(&table.rows, &case.model_id, case.larger_window).map(|row| {
                table
                    .rows
                    .iter()
                    .position(|candidate| std::ptr::eq(candidate, row))
                    .expect("the found row is one of the rows")
            });
        assert_eq!(found, case.expected_index, "{}", case.name);
    }
}
