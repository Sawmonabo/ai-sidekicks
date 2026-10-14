//! What a refused message's check found: each issue's path from the message's root down to the
//! member, in the wire's names, its fixed message, and the finding a rule adds, never the value.
//! The readers here name a path from the schema check's faults and from serde's.

use jsonschema::ValidationError;
use jsonschema::error::ValidationErrorKind;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire;
use crate::wire::AnyValue;
use crate::wire::integer::SafeInt;

/// One step of an issue's path: a member's name as the message spells it, or an array's index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum IssuePathSegment {
    /// A member's name, as sent.
    Member(String),
    /// An array element's index.
    Index(SafeInt<0>),
}

impl IssuePathSegment {
    /// The step naming the element at `index` of a received array, which cannot pass 2^53 − 1.
    pub fn index(index: usize) -> Self {
        let index = u64::try_from(index).ok().and_then(SafeInt::new);
        Self::Index(index.expect("an index into a received array is a safe integer"))
    }
}

/// One fault an `invalid_params` or `invalid_result` refusal names: where it sits, what is wrong
/// in fixed words, and, for a rule whose finding a client reads, that finding.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Issue {
    /// Where the fault sits, empty for the whole message.
    pub path: Vec<IssuePathSegment>,
    /// What is wrong, in words that never quote the value.
    pub message: String,
    /// The finding of a rule a client acts on (a repeated workflow node id's
    /// `node_id_duplicate`); absent for every other fault.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "AnyValue")]
    pub params: Option<Value>,
}

/// One place a received message breaks its contract's schema: the path in the message's own
/// names, and the schema keyword it breaks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShapeFault {
    /// Where the fault sits, empty for the whole message; for a member the schema does not allow,
    /// that member.
    pub path: Vec<IssuePathSegment>,
    /// The schema keyword the value breaks (`type`, `required`, `additionalProperties`).
    pub keyword: String,
}

/// The faults one schema-check error names in `received`, the JSON it checked: its place and
/// keyword, and for members the schema does not allow, each such member by name. A fault inside a
/// union names the union, never an arm. Never carries a value.
pub fn shape_faults(error: &ValidationError<'_>, received: &Value) -> Vec<ShapeFault> {
    let path = pointer_issue_path(error.instance_path().as_str(), received);
    let keyword = error.kind().keyword();
    if let ValidationErrorKind::AdditionalProperties { unexpected }
    | ValidationErrorKind::UnevaluatedProperties { unexpected } = error.kind()
    {
        return unexpected
            .iter()
            .map(|name| ShapeFault {
                path: path
                    .iter()
                    .cloned()
                    .chain([IssuePathSegment::Member(name.clone())])
                    .collect(),
                keyword: keyword.to_owned(),
            })
            .collect();
    }
    vec![ShapeFault {
        path,
        keyword: keyword.to_owned(),
    }]
}

/// A JSON Pointer's steps into `received`: a step into an array is an index and a step into an
/// object a member, so a member named with digits, or named `""`, stays a member.
fn pointer_issue_path(pointer: &str, received: &Value) -> Vec<IssuePathSegment> {
    let mut at = Some(received);
    pointer
        .split('/')
        .skip(1)
        .map(|step| {
            let step = step.replace("~1", "/").replace("~0", "~");
            match at {
                Some(Value::Array(elements)) => match step.parse::<usize>() {
                    Ok(index) => {
                        at = elements.get(index);
                        IssuePathSegment::index(index)
                    }
                    Err(_not_an_index) => {
                        at = None;
                        IssuePathSegment::Member(step)
                    }
                },
                _ => {
                    at = at.and_then(|node| node.get(&step));
                    IssuePathSegment::Member(step)
                }
            }
        })
        .collect()
}

/// The path serde's reader names for its fault: a map's key or an externally tagged variant as a
/// member, a sequence's place as an index, stopping at the first step it could not name (inside an
/// internally tagged or untagged union, which serde reads from its own buffered copy).
pub fn reader_issue_path(path: &serde_path_to_error::Path) -> Vec<IssuePathSegment> {
    path.iter()
        .map_while(|step| match step {
            serde_path_to_error::Segment::Seq { index } => Some(IssuePathSegment::index(*index)),
            serde_path_to_error::Segment::Map { key } => {
                Some(IssuePathSegment::Member(key.clone()))
            }
            serde_path_to_error::Segment::Enum { variant } => {
                Some(IssuePathSegment::Member(variant.clone()))
            }
            serde_path_to_error::Segment::Unknown => None,
        })
        .collect()
}

/// The TypeScript module of the issue.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/issue",
    doc: "What a refused message's check found: each issue's path, a member's name or an array's \
          index at each step, its message, and the finding a rule adds.",
    definitions: &[
        Definition::read::<IssuePathSegment>(),
        Definition::read::<Issue>(),
    ],
    constants: &[],
    method_tables: &[],
};
