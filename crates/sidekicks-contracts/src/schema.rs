//! JSON Schemas of the contract types, closed so they refuse exactly the unknown members serde
//! refuses. The TypeScript checks, an agent tool's input schema and the check a received message
//! passes before its contract reads it all come from here.

use std::any::TypeId;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use schemars::generate::SchemaSettings;
use schemars::transform::RecursiveTransform;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde_json::{Value, json};

use crate::typescript::SchemaContract;

/// A draft 2020-12 generator for the schemas `contract` describes.
pub fn generator(contract: SchemaContract) -> SchemaGenerator {
    let settings = SchemaSettings::draft2020_12();
    let settings = match contract {
        SchemaContract::Read => settings.for_deserialize(),
        SchemaContract::Sent => settings.for_serialize(),
    };
    settings
        .with_transform(RecursiveTransform(enum_of_documented_words))
        .with_transform(RecursiveTransform(discriminate_tagged_arms))
        .into_generator()
}

/// Writes a closed set of words whose variants carry docs, which schemars spells as a `oneOf` of
/// one `const` each, as one `enum`, so a check compares one list instead of trying every arm.
fn enum_of_documented_words(schema: &mut Schema) {
    let Some(Value::Array(arms)) = schema.get("oneOf") else {
        return;
    };
    let words: Option<Vec<Value>> = arms
        .iter()
        .map(|arm| {
            let arm = arm.as_object()?;
            let is_word_only = arm
                .keys()
                .all(|key| matches!(key.as_str(), "const" | "type" | "description"));
            let is_string = arm.get("type").is_none_or(|kind| kind == "string");
            let word = arm.get("const").filter(|word| word.is_string())?;
            (is_word_only && is_string).then(|| word.clone())
        })
        .collect();
    let Some(words) = words.filter(|words| !words.is_empty()) else {
        return;
    };
    let object = schema.ensure_object();
    object.remove("oneOf");
    object.insert("type".into(), "string".into());
    object.insert("enum".into(), Value::Array(words));
}

/// Names the tag of an internally tagged union, a `oneOf` whose every arm is an object requiring
/// one member that holds a constant, as its `discriminator`, so Ajv picks the arm by the tag.
fn discriminate_tagged_arms(schema: &mut Schema) {
    let Some(Value::Array(arms)) = schema.get("oneOf") else {
        return;
    };
    if schema.get("discriminator").is_some() {
        return;
    }
    let tag_of_arm = |arm: &Value| -> Option<Vec<String>> {
        let required = arm.get("required")?.as_array()?;
        let properties = arm.get("properties")?.as_object()?;
        Some(
            required
                .iter()
                .filter_map(Value::as_str)
                .filter(|member| {
                    properties
                        .get(*member)
                        .is_some_and(|property| property.get("const").is_some())
                })
                .map(str::to_owned)
                .collect(),
        )
    };
    let Some(mut shared) = arms.first().and_then(tag_of_arm) else {
        return;
    };
    for arm in arms.iter().skip(1) {
        let Some(tags) = tag_of_arm(arm) else {
            return;
        };
        shared.retain(|tag| tags.contains(tag));
    }
    let [tag] = shared.as_slice() else {
        return;
    };
    let tag = tag.clone();
    schema
        .ensure_object()
        .insert("discriminator".into(), json!({ "propertyName": tag }));
}

/// `T`'s schema as a reader accepts it, with its definitions, closed by
/// [`close_composite_objects`]. Fails only where `T`'s schema does not serialize.
pub fn closed_schema_for<T: JsonSchema>() -> serde_json::Result<Value> {
    let mut schema =
        serde_json::to_value(generator(SchemaContract::Read).into_root_schema_for::<T>())?;
    close_composite_objects(&mut schema);
    Ok(schema)
}

/// `T`'s schema as the receiving side checks it: [`closed_schema_for`] with every Ajv `$data`
/// reference dropped by [`drop_data_references`]. Fails only where `T`'s schema does not
/// serialize.
pub fn received_schema_for<T: JsonSchema>() -> serde_json::Result<Value> {
    let mut schema = closed_schema_for::<T>()?;
    drop_data_references(&mut schema);
    Ok(schema)
}

/// Why the check of a received type could not be built.
#[derive(Debug, thiserror::Error)]
pub enum ReceivedCheckError {
    /// The type's schema does not serialize.
    #[error(transparent)]
    Schema(#[from] serde_json::Error),
    /// The checker refused the type's schema.
    #[error("the schema of {type_name} does not build a check")]
    Build {
        /// The type's schema name.
        type_name: String,
        /// The checker's refusal.
        #[source]
        source: Box<jsonschema::ValidationError<'static>>,
    },
}

/// The checks built so far, one per received type; bounded by the contract types, and an ordered
/// map, so making it draws no randomness.
static RECEIVED_CHECKS: Mutex<BTreeMap<TypeId, Arc<jsonschema::Validator>>> =
    Mutex::new(BTreeMap::new());

/// The check a received `T` passes before serde reads it: [`received_schema_for`] compiled on
/// first use and held for the process's life. Fails where the schema does not build a check.
pub fn received_check<T: JsonSchema + 'static>()
-> Result<Arc<jsonschema::Validator>, ReceivedCheckError> {
    let type_id = TypeId::of::<T>();
    let held = RECEIVED_CHECKS
        .lock()
        .expect("no holder of the checks panics")
        .get(&type_id)
        .cloned();
    if let Some(check) = held {
        return Ok(check);
    }
    let schema = received_schema_for::<T>()?;
    let check = jsonschema::validator_for(&schema).map_err(|source| ReceivedCheckError::Build {
        type_name: T::schema_name().into_owned(),
        source: Box::new(source),
    })?;
    let mut checks = RECEIVED_CHECKS
        .lock()
        .expect("no holder of the checks panics");
    Ok(Arc::clone(
        checks.entry(type_id).or_insert_with(|| Arc::new(check)),
    ))
}

/// A doc comment as a schema's `description`, as schemars writes a derived type's: each line
/// without the one space `///` leaves, joined, the whole trimmed.
pub fn doc_description(doc: &str) -> String {
    doc.lines()
        .map(|line| line.strip_prefix(' ').unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// Appends `rule` to `schema`'s `allOf`, the place a rule no shape holds is stated beside the
/// shape.
pub(crate) fn push_all_of(schema: &mut Schema, rule: Value) {
    let all_of = schema
        .ensure_object()
        .entry("allOf")
        .or_insert_with(|| Value::Array(Vec::new()));
    all_of
        .as_array_mut()
        .expect("JSON Schema holds `allOf` as an array")
        .push(rule);
}

/// The schema of an object that holds `member`, its type stated in place for Ajv's strict mode.
pub(crate) fn required_member(member: &str) -> Value {
    json!({ "type": "object", "properties": { member: {} }, "required": [member] })
}

/// Restores the refusal of unknown members where schemars drops it: an object that pairs its own
/// members with `oneOf`, `anyOf` or `allOf` (an internally tagged enum's arm holding another enum)
/// gets `unevaluatedProperties: false`. Only the outermost such object closes, since an arm's
/// `unevaluatedProperties` cannot see the tag its enclosing object holds; a `$ref`'d arm must be
/// `#[schemars(inline)]` for the same reason. An object that states `additionalProperties` (a
/// kept-unknown type states `true`) is left as it is.
pub fn close_composite_objects(schema: &mut Value) {
    close(schema, false);
}

/// Removes every keyword whose value is an Ajv `$data` reference (`{"$data": "1/count"}`): a
/// standard checker refuses one under `maxItems` or `minimum` when it builds, and compares one
/// under `const` as a literal, so the receiving side's copy leaves those rules to garde.
pub fn drop_data_references(schema: &mut Value) {
    match schema {
        Value::Object(object) => {
            object.retain(|_, value| !is_data_reference(value));
            object.values_mut().for_each(drop_data_references);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_data_references),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn is_data_reference(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.len() == 1 && object.contains_key("$data"))
}

fn close(schema: &mut Value, is_inside_closed: bool) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    let is_object = object.get("type").and_then(Value::as_str) == Some("object")
        || object.contains_key("properties");
    let is_composite = ["oneOf", "anyOf", "allOf"]
        .iter()
        .any(|key| object.contains_key(*key));
    let is_open = !object.contains_key("additionalProperties")
        && !object.contains_key("unevaluatedProperties");
    let is_closing = is_object && is_composite && is_open && !is_inside_closed;
    if is_closing {
        object.insert("unevaluatedProperties".into(), false.into());
    }
    // In-place applicators evaluate members of this same object.
    let is_carried = is_inside_closed || is_closing;
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(Value::Array(arms)) = object.get_mut(key) {
            for arm in arms.iter_mut() {
                close(arm, is_carried);
            }
        }
    }
    for key in ["if", "then", "else"] {
        if let Some(branch) = object.get_mut(key) {
            close(branch, is_carried);
        }
    }
    // Every other subschema describes another value, or is a definition: it starts over.
    for key in [
        "properties",
        "patternProperties",
        "$defs",
        "dependentSchemas",
    ] {
        if let Some(Value::Object(members)) = object.get_mut(key) {
            members.values_mut().for_each(|member| close(member, false));
        }
    }
    for key in [
        "additionalProperties",
        "unevaluatedProperties",
        "items",
        "contains",
        "propertyNames",
        "not",
    ] {
        if let Some(subschema) = object.get_mut(key) {
            close(subschema, false);
        }
    }
    if let Some(Value::Array(items)) = object.get_mut("prefixItems") {
        for item in items.iter_mut() {
            close(item, false);
        }
    }
}
