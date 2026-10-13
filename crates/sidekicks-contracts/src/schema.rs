//! JSON Schemas of the contract types, closed so they refuse exactly the unknown members serde
//! refuses. The TypeScript checks, an agent tool's input schema and the check a received message
//! passes before its contract reads it all come from here.

use std::any::TypeId;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

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
/// one member that holds a constant, as its `discriminator`, so Ajv picks the arm by the tag. Only
/// a tag whose every arm holds a different string qualifies, the one form Ajv compiles.
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
    // Ajv takes a discriminator only over string tags, each arm's its own.
    let words: Option<Vec<&str>> = arms
        .iter()
        .map(|arm| arm.get("properties")?.get(tag)?.get("const")?.as_str())
        .collect();
    let Some(mut words) = words else {
        return;
    };
    words.sort_unstable();
    let arm_count = words.len();
    words.dedup();
    if words.len() != arm_count {
        return;
    }
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

/// `T`'s schema as the receiving side checks it: [`closed_schema_for`] cut to its shape by
/// [`received_shape`]. Fails where `T`'s schema does not serialize or cannot be cut to its shape.
pub fn received_schema_for<T: JsonSchema>() -> Result<Value, ReceivedCheckError> {
    received_shape(&closed_schema_for::<T>()?).map_err(|source| ReceivedCheckError::Shape {
        type_name: T::schema_name().into_owned(),
        source,
    })
}

/// Why the check of a received type could not be built.
#[derive(Debug, thiserror::Error)]
pub enum ReceivedCheckError {
    /// The type's schema does not serialize.
    #[error(transparent)]
    Schema(#[from] serde_json::Error),
    /// The type's schema holds a keyword the shape would drop although a kept keyword reads it.
    #[error("the schema of {type_name} cannot be cut to its shape")]
    Shape {
        /// The type's schema name.
        type_name: String,
        /// The keyword in the way.
        #[source]
        source: ShapeError,
    },
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
/// map, so making it draws no randomness. Reads share the lock; only a first build writes.
static RECEIVED_CHECKS: RwLock<BTreeMap<TypeId, Arc<jsonschema::Validator>>> =
    RwLock::new(BTreeMap::new());

/// The check a received `T` passes before serde reads it: [`received_schema_for`] compiled on
/// first use and held for the process's life, the first one built kept when two race. Fails where
/// the schema does not build a check.
pub fn received_check<T: JsonSchema + 'static>()
-> Result<Arc<jsonschema::Validator>, ReceivedCheckError> {
    let type_id = TypeId::of::<T>();
    let held = RECEIVED_CHECKS
        .read()
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
        .write()
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

/// Why a schema cannot be cut to its shape.
#[derive(Debug, thiserror::Error)]
#[error(
    "`{keyword}` marks members a kept `{reader}` reads, so dropping it would refuse valid input"
)]
pub struct ShapeError {
    /// The keyword the shape would drop.
    pub keyword: &'static str,
    /// The kept keyword that reads what it marks.
    pub reader: &'static str,
}

/// The shape of a closed schema, the part of it that says which members and which JSON kinds a
/// message holds, which the receiving side checks before serde reads it; garde holds every other
/// rule, the Ajv `$data` ones among them. It keeps the structural keywords and the `const` and
/// `enum` that hold no `$data` reference, writes `oneOf` as `anyOf` and `if`/`then`/`else` as an
/// `anyOf`, and drops the rest, so it only ever accepts more than the schema. Fails where a
/// dropped keyword marks members a kept `unevaluatedProperties` or `unevaluatedItems` reads:
/// `$dynamicRef` anywhere, or `contains` within an `unevaluatedItems`' reach.
pub fn received_shape(schema: &Value) -> Result<Value, ShapeError> {
    refuse_dropped_markers(schema, schema, false, 0)?;
    Ok(shape(schema))
}

fn shape(schema: &Value) -> Value {
    let Some(object) = schema.as_object() else {
        return schema.clone();
    };
    let mut shaped = serde_json::Map::new();
    let mut alternatives = Vec::new();
    for (key, value) in object {
        match key.as_str() {
            "$schema" | "$ref" | "type" | "required" => {
                shaped.insert(key.clone(), value.clone());
            }
            "const" | "enum" if !holds_data_reference(value) => {
                shaped.insert(key.clone(), value.clone());
            }
            "$defs" | "properties" | "patternProperties" | "dependentSchemas" => {
                if let Value::Object(members) = value {
                    let members = members
                        .iter()
                        .map(|(name, member)| (name.clone(), shape(member)))
                        .collect();
                    shaped.insert(key.clone(), Value::Object(members));
                }
            }
            "additionalProperties" | "unevaluatedProperties" | "items" => {
                shaped.insert(key.clone(), shape(value));
            }
            "prefixItems" | "allOf" => {
                if let Value::Array(arms) = value {
                    shaped.insert(key.clone(), Value::Array(arms.iter().map(shape).collect()));
                }
            }
            "anyOf" | "oneOf" => {
                if let Value::Array(arms) = value {
                    alternatives.push(Value::Array(arms.iter().map(shape).collect()));
                }
            }
            "if" => {
                let taken = json!({ "allOf": [
                    shape(value),
                    object.get("then").map_or(Value::Bool(true), shape),
                ] });
                let otherwise = object.get("else").map_or(Value::Bool(true), shape);
                alternatives.push(json!([taken, otherwise]));
            }
            _ => {}
        }
    }
    // One `anyOf` stays in place; each further one is nested in `allOf`, since all must hold.
    let mut alternatives = alternatives.into_iter();
    if let Some(first) = alternatives.next() {
        shaped.insert("anyOf".into(), first);
    }
    for further in alternatives {
        let all_of = shaped
            .entry("allOf")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(arms) = all_of {
            arms.push(json!({ "anyOf": further }));
        }
    }
    Value::Object(shaped)
}

/// Whether `value` holds an Ajv `$data` reference (`{"$data": "1/count"}`) anywhere in it.
fn holds_data_reference(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            (object.len() == 1 && object.contains_key("$data"))
                || object.values().any(holds_data_reference)
        }
        Value::Array(items) => items.iter().any(holds_data_reference),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

/// The deepest `$ref` chain followed; a schema's references never nest deeper than its types do.
const REFERENCE_DEPTH_LIMIT: usize = 64;

/// Walks `schema` for [`received_shape`]'s refusals: `$dynamicRef` anywhere, and `contains` where
/// an enclosing `unevaluatedItems` reads it in place (`is_item_marked`), through `$ref`s into
/// `root`'s `$defs`.
fn refuse_dropped_markers(
    root: &Value,
    schema: &Value,
    is_item_marked: bool,
    depth: usize,
) -> Result<(), ShapeError> {
    let Some(object) = schema.as_object() else {
        return Ok(());
    };
    if object.contains_key("$dynamicRef") {
        return Err(ShapeError {
            keyword: "$dynamicRef",
            reader: "unevaluatedProperties",
        });
    }
    let is_item_marked = is_item_marked || object.contains_key("unevaluatedItems");
    if is_item_marked && object.contains_key("contains") {
        return Err(ShapeError {
            keyword: "contains",
            reader: "unevaluatedItems",
        });
    }
    // In-place applicators read the same value, so an enclosing `unevaluatedItems` reaches them.
    let in_place = ["allOf", "anyOf", "oneOf"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_array))
        .flatten()
        .chain(
            ["if", "then", "else", "not"]
                .iter()
                .filter_map(|key| object.get(*key)),
        )
        .chain(
            object
                .get("dependentSchemas")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(serde_json::Map::values),
        );
    for subschema in in_place {
        refuse_dropped_markers(root, subschema, is_item_marked, depth)?;
    }
    // `$defs` are walked once below; a reference is followed only to see what a reader reaches.
    if is_item_marked
        && let Some(target) = object
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|reference| reference.strip_prefix("#/$defs/"))
            .and_then(|name| root.get("$defs")?.get(name))
        && depth < REFERENCE_DEPTH_LIMIT
    {
        refuse_dropped_markers(root, target, is_item_marked, depth + 1)?;
    }
    // Every other subschema reads another value: an enclosing `unevaluatedItems` stops there.
    let other_values = ["properties", "patternProperties", "$defs"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_object))
        .flat_map(serde_json::Map::values)
        .chain(
            [
                "additionalProperties",
                "unevaluatedProperties",
                "items",
                "contains",
            ]
            .iter()
            .filter_map(|key| object.get(*key)),
        )
        .chain(
            object
                .get("prefixItems")
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        );
    for subschema in other_values {
        refuse_dropped_markers(root, subschema, false, depth)?;
    }
    Ok(())
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
