//! JSON Schemas of the contract types, closed so they refuse exactly the unknown members serde
//! refuses. The TypeScript checks, an agent tool's input schema and the check a received message
//! passes before its contract reads it all come from here.

use std::any::TypeId;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use schemars::generate::SchemaSettings;
use schemars::transform::RecursiveTransform;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde_json::{Map, Value, json};

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

/// Names the tag of a tagged union written as `oneOf` as its `discriminator`, so Ajv picks the arm
/// by the tag. The generator sees no definitions, so a union whose arms are `$ref`s stays plain.
fn discriminate_tagged_arms(schema: &mut Schema) {
    let Some(Value::Array(arms)) = schema.get("oneOf") else {
        return;
    };
    if schema.get("discriminator").is_some() {
        return;
    }
    let Some(tag) = tagged_union(arms, |arm| arm).map(|union| union.tag) else {
        return;
    };
    let object = schema.ensure_object();
    object.insert("discriminator".into(), json!({ "propertyName": tag }));
    // Every arm is an object, and Ajv's strict mode states that beside the discriminator.
    object.insert("type".into(), "object".into());
}

/// A union whose arms an object's tag tells apart: the tag's name and each arm's word, in arm
/// order.
struct TaggedUnion<'schema> {
    tag: String,
    words: Vec<&'schema str>,
}

/// The tag of a union whose every arm, as `resolve` reads it, states `type: "object"`, requires
/// one shared member and fixes it to a string of its own; `None` for any other union. Ajv compiles
/// a discriminator only over such a tag, and the received shape checks only the arm it selects.
fn tagged_union<'schema>(
    arms: &'schema [Value],
    resolve: impl Fn(&'schema Value) -> &'schema Value,
) -> Option<TaggedUnion<'schema>> {
    let constant_members_of = |arm: &'schema Value| -> Option<Vec<&'schema str>> {
        if arm.get("type").and_then(Value::as_str) != Some("object") {
            return None;
        }
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
                .collect(),
        )
    };
    let mut shared = constant_members_of(resolve(arms.first()?))?;
    for arm in arms.iter().skip(1) {
        let members = constant_members_of(resolve(arm))?;
        shared.retain(|tag| members.contains(tag));
    }
    let [tag] = shared.as_slice() else {
        return None;
    };
    let words: Vec<&str> = arms
        .iter()
        .map(|arm| {
            resolve(arm)
                .get("properties")?
                .get(*tag)?
                .get("const")?
                .as_str()
        })
        .collect::<Option<_>>()?;
    let mut distinct = words.clone();
    distinct.sort_unstable();
    distinct.dedup();
    (distinct.len() == words.len()).then(|| TaggedUnion {
        tag: (*tag).to_owned(),
        words,
    })
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

/// Why a schema cannot be cut to its shape: it holds a `$dynamicRef`, which marks members a kept
/// `unevaluatedProperties` reads, so dropping it would refuse valid input.
#[derive(Debug, thiserror::Error)]
#[error("`$dynamicRef` marks members a kept `unevaluatedProperties` reads")]
pub struct ShapeError;

/// The shape of a closed schema, the part of it that says which members and which JSON kinds a
/// message holds, which the receiving side checks before serde reads it; garde holds every other
/// rule, the Ajv `$data` ones among them. It keeps the structural keywords and the `const` and
/// `enum` that hold no `$data` reference, drops the rest, and writes every union, and every
/// `if`/`then`/`else`, as an `allOf` rule the checker reports one fault of: a tagged union as one
/// `if`/`then` per arm keyed on its tag, a union of `null` and one arm as `if: null, else: arm`,
/// and any other as `if` its arms, `else: false`. So it only ever accepts more than the schema.
/// Fails where the schema holds a `$dynamicRef`, the one dropped keyword a kept
/// `unevaluatedProperties` reads.
pub fn received_shape(schema: &Value) -> Result<Value, ShapeError> {
    if holds_dynamic_reference(schema) {
        return Err(ShapeError);
    }
    let definitions = schema.get("$defs").and_then(Value::as_object);
    Ok(shape(schema, definitions))
}

fn shape(schema: &Value, definitions: Option<&Map<String, Value>>) -> Value {
    let Some(object) = schema.as_object() else {
        return schema.clone();
    };
    let shape_all =
        |arms: &[Value]| -> Vec<Value> { arms.iter().map(|arm| shape(arm, definitions)).collect() };
    let mut shaped = Map::new();
    let mut union_rules = Vec::new();
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
                        .map(|(name, member)| (name.clone(), shape(member, definitions)))
                        .collect();
                    shaped.insert(key.clone(), Value::Object(members));
                }
            }
            "additionalProperties" | "unevaluatedProperties" | "items" => {
                shaped.insert(key.clone(), shape(value, definitions));
            }
            "prefixItems" | "allOf" => {
                if let Value::Array(arms) = value {
                    shaped.insert(key.clone(), Value::Array(shape_all(arms)));
                }
            }
            "anyOf" | "oneOf" => {
                if let Value::Array(arms) = value {
                    union_rules.extend(union_rules_of(arms, definitions));
                }
            }
            "if" => {
                let taken = json!({ "allOf": [
                    shape(value, definitions),
                    object
                        .get("then")
                        .map_or(Value::Bool(true), |then| shape(then, definitions)),
                ] });
                let otherwise = object
                    .get("else")
                    .map_or(Value::Bool(true), |otherwise| shape(otherwise, definitions));
                union_rules.push(json!({ "if": { "anyOf": [taken, otherwise] }, "else": false }));
            }
            _ => {}
        }
    }
    if !union_rules.is_empty() {
        let all_of = shaped
            .entry("allOf")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(rules) = all_of {
            rules.extend(union_rules);
        }
    }
    Value::Object(shaped)
}

/// The `allOf` rules that hold one union's arms, each a form the checker reports one fault of: a
/// tagged union's tag, then one `if`/`then` per arm, so a fault is named inside the arm its tag
/// selects; a union of `null` and one arm as `if: null, else: arm`, so a fault is named inside the
/// arm; any other as `if` its arms, `else: false`, so a fault is named at the union.
fn union_rules_of<'schema>(
    arms: &'schema [Value],
    definitions: Option<&'schema Map<String, Value>>,
) -> Vec<Value> {
    if let Some(TaggedUnion { tag, words }) =
        tagged_union(arms, |arm| resolve_reference(arm, definitions))
    {
        let tag_rule = json!({ "required": [tag], "properties": { &tag: { "enum": words } } });
        return [tag_rule]
            .into_iter()
            .chain(arms.iter().zip(&words).map(|(arm, word)| {
                json!({
                    "if": { "required": [tag], "properties": { &tag: { "const": word } } },
                    "then": shape(arm, definitions),
                })
            }))
            .collect();
    }
    let is_null = |arm: &Value| {
        arm.as_object().is_some_and(|arm| arm.len() == 1)
            && arm.get("type").and_then(Value::as_str) == Some("null")
    };
    if let [first, second] = arms
        && let Some(other) = match (is_null(first), is_null(second)) {
            (true, false) => Some(second),
            (false, true) => Some(first),
            (true, true) | (false, false) => None,
        }
    {
        return vec![json!({ "if": { "type": "null" }, "else": shape(other, definitions) })];
    }
    let arms: Vec<Value> = arms.iter().map(|arm| shape(arm, definitions)).collect();
    vec![json!({ "if": { "anyOf": arms }, "else": false })]
}

/// The definition a bare `$ref` arm names in `definitions`, followed to one that is not a bare
/// `$ref`; any other arm, and a reference outside `definitions`, as it is.
fn resolve_reference<'schema>(
    mut arm: &'schema Value,
    definitions: Option<&'schema Map<String, Value>>,
) -> &'schema Value {
    // Bounded by the definitions, so a cycle of references ends.
    for _ in 0..=definitions.map_or(0, Map::len) {
        let referenced = arm
            .get("type")
            .is_none()
            .then(|| arm.get("$ref")?.as_str()?.strip_prefix("#/$defs/"))
            .flatten()
            .and_then(|name| definitions?.get(name));
        match referenced {
            Some(definition) => arm = definition,
            None => break,
        }
    }
    arm
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

/// Whether `schema` or any subschema in it holds a `$dynamicRef`.
fn holds_dynamic_reference(schema: &Value) -> bool {
    let Some(object) = schema.as_object() else {
        return false;
    };
    object.contains_key("$dynamicRef")
        || [
            "properties",
            "patternProperties",
            "$defs",
            "dependentSchemas",
        ]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_object))
        .flat_map(serde_json::Map::values)
        .chain(
            [
                "additionalProperties",
                "unevaluatedProperties",
                "items",
                "contains",
                "not",
                "if",
                "then",
                "else",
            ]
            .iter()
            .filter_map(|key| object.get(*key)),
        )
        .chain(
            ["allOf", "anyOf", "oneOf", "prefixItems"]
                .iter()
                .filter_map(|key| object.get(*key).and_then(Value::as_array))
                .flatten(),
        )
        .any(holds_dynamic_reference)
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
