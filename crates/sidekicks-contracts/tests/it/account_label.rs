//! The label an account is named by, read from the case table the TypeScript suite also reads.

use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::label::account_label;
use sidekicks_contracts::provider::account::record::ProviderAccount;

/// The case table: one account and the members each case lays over it.
#[derive(Deserialize)]
struct CaseTable {
    account: Map<String, Value>,
    cases: Vec<Case>,
}

/// One account's overrides and the label it must read, or none.
#[derive(Deserialize)]
struct Case {
    name: String,
    overrides: Map<String, Value>,
    label: Option<String>,
}

#[test]
fn names_each_account_as_the_case_table_says() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/account-label.json");
    let text = std::fs::read_to_string(path).expect("the case table reads");
    let table: CaseTable = serde_json::from_str(&text).expect("the case table parses");
    for case in table.cases {
        let mut members = table.account.clone();
        members.extend(case.overrides);
        let account: ProviderAccount =
            serde_json::from_value(Value::Object(members)).expect("the case's account parses");
        assert_eq!(account_label(&account), case.label, "{}", case.name);
    }
}
