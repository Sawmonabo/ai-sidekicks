//! What a refused message's check found: each issue's path from the message's root down to the
//! member, in the wire's names, its fixed message, and the finding a rule adds, never the value.
//! The readers here name a path from the schema check's faults and from serde's.

use jsonschema::ValidationError;
use jsonschema::error::ValidationErrorKind;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire;
use crate::wire::integer::SafeInt;
use crate::wire::record::JsonRecord;

ts_constants! {
    /// The most issues a `request.paramsInvalid` or `request.resultInvalid` refusal lists, the
    /// first in the check's order.
    pub const ISSUES_MAX: usize = 32;
    /// The most steps an issue's path holds; a deeper fault is named at its ancestor this deep.
    pub const ISSUE_PATH_SEGMENTS_MAX: usize = 32;
}

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

/// One fault a `request.paramsInvalid` or `request.resultInvalid` refusal names: where it sits,
/// what is wrong in fixed words, and, for a rule whose finding a client reads, that finding.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Issue {
    /// Where the fault sits, empty for the whole message.
    pub path: Vec<IssuePathSegment>,
    /// What is wrong, in words that never quote the value.
    pub message: String,
    /// The finding of a rule a client acts on (a repeated workflow node id's
    /// `nodeIdDuplicate`); absent for every other fault.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "JsonRecord")]
    pub params: Option<JsonRecord>,
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

/// The faults the schema check's one error names in `received`, the JSON it checked: its place and
/// keyword, and for members an object closed by `unevaluatedProperties` does not allow, each such
/// member by name, the first [`ISSUES_MAX`] of them. A tagged union's fault is named inside the arm
/// its tag selects; any other union's at the union, as an `anyOf` fault, the outermost untagged
/// union deciding. Never carries a value.
pub fn shape_faults(error: &ValidationError<'_>, received: &Value) -> Vec<ShapeFault> {
    let path = pointer_issue_path(error.instance_path().as_str(), received);
    let keyword = if matches!(error.kind(), ValidationErrorKind::FalseSchema)
        && is_union_refusal(error.schema_path().as_str())
    {
        "anyOf"
    } else {
        error.kind().keyword()
    };
    if let ValidationErrorKind::AdditionalProperties { unexpected }
    | ValidationErrorKind::UnevaluatedProperties { unexpected } = error.kind()
    {
        return unexpected
            .iter()
            .take(ISSUES_MAX)
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

/// Whether a schema path ends at the keyword `else`, where the received shape refuses a value no
/// arm of a union reads; a member named `else` is told apart by where it sits.
fn is_union_refusal(schema_path: &str) -> bool {
    // Each step is a keyword, a member or definition name, or an arm's index.
    #[derive(Clone, Copy, PartialEq)]
    enum Step {
        Keyword,
        Name,
        Index,
    }
    let mut next = Step::Keyword;
    let mut last = None;
    for segment in schema_path.split('/').skip(1) {
        let this = next;
        next = match (this, segment) {
            (Step::Keyword, "properties" | "patternProperties" | "$defs" | "dependentSchemas") => {
                Step::Name
            }
            (Step::Keyword, "allOf" | "anyOf" | "oneOf" | "prefixItems") => Step::Index,
            (Step::Keyword | Step::Name | Step::Index, _) => Step::Keyword,
        };
        last = Some((this, segment));
    }
    last == Some((Step::Keyword, "else"))
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
            if let Some(Value::Array(elements)) = at
                && let Ok(index) = step.parse::<usize>()
            {
                at = elements.get(index);
                IssuePathSegment::index(index)
            } else {
                at = at.and_then(|node| node.get(&step));
                IssuePathSegment::Member(step)
            }
        })
        .collect()
}

/// The message of an issue serde's reader of its type refuses; it never quotes the value.
pub const UNREADABLE_VALUE_ISSUE_MESSAGE: &str = "this value does not read as its type";

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
    constants: TS_CONSTANTS,
    method_tables: &[],
};
