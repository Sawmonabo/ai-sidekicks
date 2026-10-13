//! JSON Schemas of the contract types, closed so they refuse exactly the unknown members serde
//! refuses. The TypeScript checks and an agent tool's input schema both come from here.

use schemars::generate::SchemaSettings;
use schemars::{JsonSchema, SchemaGenerator};
use serde_json::Value;

use crate::typescript::SchemaContract;

/// A draft 2020-12 generator for the schemas `contract` describes.
pub fn generator(contract: SchemaContract) -> SchemaGenerator {
    let settings = SchemaSettings::draft2020_12();
    let settings = match contract {
        SchemaContract::Read => settings.for_deserialize(),
        SchemaContract::Sent => settings.for_serialize(),
    };
    settings.into_generator()
}

/// `T`'s schema as a reader accepts it, with its definitions, closed by
/// [`close_composite_objects`]. Fails only where `T`'s schema does not serialize.
pub fn closed_schema_for<T: JsonSchema>() -> serde_json::Result<Value> {
    let mut schema =
        serde_json::to_value(generator(SchemaContract::Read).into_root_schema_for::<T>())?;
    close_composite_objects(&mut schema);
    Ok(schema)
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
            arms.iter_mut().for_each(|arm| close(arm, is_carried));
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
        items.iter_mut().for_each(|item| close(item, false));
    }
}
