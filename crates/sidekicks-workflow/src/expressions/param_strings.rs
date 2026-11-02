//! The one walk over the strings a node's params hold, in arrays and objects too, each visited with
//! its place: the param's name and each member or entry below it.

use std::fmt;

use serde_json::Value;
use sidekicks_contracts::wire::record::JsonRecord;

/// One step in a param's value: a member of an object or an entry of an array.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ParamPathSegment {
    /// The member of this name.
    Key(String),
    /// The entry at this index.
    Index(usize),
}

/// Where a string sits in a node's params: the param, then each member or entry below it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParamPath {
    /// The param's name.
    pub(crate) param: String,
    /// Each member or entry below the param, outermost first.
    pub(crate) segments: Vec<ParamPathSegment>,
}

impl fmt::Display for ParamPath {
    /// Writes the path as `param.member[index]`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.param)?;
        for segment in &self.segments {
            match segment {
                ParamPathSegment::Key(key) => write!(formatter, ".{key}")?,
                ParamPathSegment::Index(index) => write!(formatter, "[{index}]")?,
            }
        }
        Ok(())
    }
}

/// Visits every string `params` hold, in arrays and objects too, with its path, params in name
/// order and each value depth first in its own order. Stops at, and fails with, the first failure
/// `visit` answers.
pub(crate) fn walk_param_strings<Failure>(
    params: &JsonRecord,
    mut visit: impl FnMut(&ParamPath, &str) -> Result<(), Failure>,
) -> Result<(), Failure> {
    for (param, value) in params.as_map() {
        let mut path = ParamPath {
            param: param.clone(),
            segments: Vec::new(),
        };
        walk_value(&value.0, &mut path, &mut visit)?;
    }
    Ok(())
}

/// Visits every string `value`, sitting at `path`, holds; `path` is as it came once this returns.
fn walk_value<Failure>(
    value: &Value,
    path: &mut ParamPath,
    visit: &mut impl FnMut(&ParamPath, &str) -> Result<(), Failure>,
) -> Result<(), Failure> {
    match value {
        Value::String(text) => visit(path, text)?,
        Value::Array(entries) => {
            for (index, entry) in entries.iter().enumerate() {
                path.segments.push(ParamPathSegment::Index(index));
                walk_value(entry, path, visit)?;
                path.segments.pop();
            }
        }
        Value::Object(members) => {
            for (key, entry) in members {
                path.segments.push(ParamPathSegment::Key(key.clone()));
                walk_value(entry, path, visit)?;
                path.segments.pop();
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}
