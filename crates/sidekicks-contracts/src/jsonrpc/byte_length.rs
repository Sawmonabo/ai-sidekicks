//! How many bytes a value takes on the wire, which the message cap and the page budget both
//! measure: the length of its RFC 8785 JSON, which equals what `JSON.stringify` writes. The one
//! check that holds a value to a byte cap lives here too.

use serde::Serialize;

/// The UTF-8 byte length of `value` written as JSON. Fails only where the value's own `Serialize`
/// fails.
pub fn json_utf8_byte_length<T: Serialize>(value: &T) -> serde_json::Result<usize> {
    Ok(serde_json_canonicalizer::to_string(value)?.len())
}

/// A garde check that `value` measures at most `budget_bytes` JSON bytes, counted as
/// [`json_utf8_byte_length`] counts them; a value that does not serialize is refused too.
pub fn fits_budget<T: Serialize>(value: &T, budget_bytes: usize) -> garde::Result {
    let measured_bytes = json_utf8_byte_length(value)
        .map_err(|error| garde::Error::new(format!("the value does not serialize: {error}")))?;
    if measured_bytes > budget_bytes {
        return Err(garde::Error::new(format!(
            "the value measures {measured_bytes} JSON bytes, over its {budget_bytes}-byte cap"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    use super::json_utf8_byte_length;

    /// One case of the table the TypeScript copy also reads: a value, or its JSON text where
    /// parsing changes how it is written, and its length.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ByteLengthCase {
        note: String,
        value: Option<Value>,
        value_text: Option<String>,
        bytes: usize,
    }

    #[test]
    fn a_value_measures_what_javascript_writes() {
        let cases: Vec<ByteLengthCase> = serde_json::from_str(include_str!(
            "../../tests/fixtures/jsonrpc/byte-length.json"
        ))
        .expect("the case table reads");
        for case in cases {
            let value = match (case.value, case.value_text) {
                (Some(value), None) => value,
                (None, Some(text)) => serde_json::from_str(&text).expect("the text is JSON"),
                (Some(_), Some(_)) | (None, None) => panic!("{}: one value per case", case.note),
            };
            assert_eq!(
                json_utf8_byte_length(&value).expect("a value serializes"),
                case.bytes,
                "{}",
                case.note
            );
        }
    }
}
