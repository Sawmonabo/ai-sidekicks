//! A received JSON object's members in the order JavaScript lists them, so a port of
//! `Object.keys` or `Object.entries` over provider JSON keeps the order Node gave: keys that are
//! array indexes first, ascending, then every other key in the order it first arrived.

use serde_json::{Map, Value};

/// The largest array index, 2^32 − 2; JavaScript lists a key past it with the other names.
const MAX_ARRAY_INDEX: u32 = u32::MAX - 1;

/// `object`'s members in the order JavaScript's `Object.entries` gives them. `serde_json`'s
/// `preserve_order` keeps each key where it first arrived, as `JSON.parse` does, so only the
/// array-index keys move.
pub(crate) fn members_in_javascript_order(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed = Vec::new();
    let mut named = Vec::with_capacity(object.len());
    for (key, value) in object {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_unstable_by_key(|&(index, _, _)| index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}

// The array index `key` spells: plain decimal digits with no sign and no leading zero, up to
// 2^32 − 2. `u32::from_str` alone would also take a leading `+`.
fn array_index(key: &str) -> Option<u32> {
    let is_canonical_digits = !key.is_empty()
        && key.bytes().all(|byte| byte.is_ascii_digit())
        && (key == "0" || !key.starts_with('0'));
    if !is_canonical_digits {
        return None;
    }
    key.parse::<u32>()
        .ok()
        .filter(|&index| index <= MAX_ARRAY_INDEX)
}

#[cfg(test)]
mod tests {
    use super::members_in_javascript_order;

    #[test]
    fn lists_members_in_the_order_node_lists_them() {
        // The key order Node 24 prints for `Object.keys(JSON.parse(text))`.
        let text =
            r#"{"b":1,"2":2,"1":3,"4294967295":4,"01":5,"4294967294":6,"+1":7,"-0":8,"b":9}"#;
        let object: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(text).expect("the text is an object");
        let members = members_in_javascript_order(&object);
        let keys: Vec<&str> = members.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(
            keys,
            ["1", "2", "4294967294", "b", "4294967295", "01", "+1", "-0"]
        );
        // A repeated key keeps its first place and its last value, as `JSON.parse` keeps them.
        assert_eq!(members[3].1, &serde_json::json!(9));
    }
}
