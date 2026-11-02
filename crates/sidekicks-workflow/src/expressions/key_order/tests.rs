use jsonata_core::evaluator::Evaluator;
use jsonata_core::parser::parse;
use serde_json::{Value, json};

use super::to_jsonata_value;

/// What `expression` answers over `data` once converted, read back as JSON.
fn evaluated(expression: &str, data: &Value) -> Value {
    let result = Evaluator::new()
        .evaluate(
            &parse(expression).expect("the expression parses"),
            &to_jsonata_value(data),
        )
        .expect("the expression evaluates");
    Value::from(&result)
}

/// Array-index keys come first in ascending number, then every other key in input order: a
/// leading-zero key and `4294967295`, which no JavaScript array can index, are ordinary keys. The
/// order holds for an object inside an array too.
#[test]
fn objects_read_their_keys_in_javascript_order() {
    let example = json!({ "b": 1, "2": 2, "1": 3, "4294967295": 4, "01": 5 });
    assert_eq!(
        evaluated("$keys($)", &example),
        json!(["1", "2", "b", "4294967295", "01"])
    );

    let nested = json!({ "rows": [{ "z": 1, "10": 2, "9": 3, "0": 4 }] });
    assert_eq!(
        evaluated("$keys(rows[0])", &nested),
        json!(["0", "9", "10", "z"])
    );
}
