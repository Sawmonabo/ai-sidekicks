//! What a refused message's check found: each issue's path from the message's root down to the
//! member, in the wire's names, its fixed message, and the finding a rule adds, never the value.
//! The readers here name a path from the schema check's faults, from serde's and from garde's, and
//! turn a received message's refusal into the issues a `request.paramsInvalid` lists.

use jsonschema::ValidationError;
use jsonschema::error::ValidationErrorKind;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::ReceivedCheckError;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire;
use crate::wire::AnyValue;
use crate::wire::attachment::ReceivedError;
use crate::wire::integer::SafeInt;
use crate::wire::record::{JsonRecord, Record};
use crate::workflow::definition::document::{NODE_ID_DUPLICATE_MESSAGE, WorkflowNodeId};
use crate::workflow::definition::refusals::WorkflowDefinitionFinding;

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

/// The message of an issue for a value serde's reader cannot read as its type, or a field it
/// misses; it never quotes the value.
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

/// The issues a refused received message names, in the check's order and at most [`ISSUES_MAX`]:
/// each schema fault at its place with its keyword, serde's fault where its reader stopped, an
/// attachment no placeholder names, and each broken garde rule through [`rule_issues`]. None quotes
/// a value, and a message that is no JSON names none. Fails where the contract's check could not be
/// built, which is no fault of the message.
pub fn received_issues(refused: ReceivedError) -> Result<Vec<Issue>, ReceivedCheckError> {
    let issue = |path: Vec<IssuePathSegment>, message: String| Issue {
        path,
        message,
        params: None,
    };
    Ok(match refused {
        ReceivedError::Check(error) => return Err(error),
        ReceivedError::Json(_) => Vec::new(),
        ReceivedError::Shape { faults } => faults
            .into_iter()
            .take(ISSUES_MAX)
            .map(|fault| {
                let message = format!("breaks the schema's \"{}\" rule", fault.keyword);
                issue(fault.path, message)
            })
            .collect(),
        ReceivedError::Read { path, .. } => {
            vec![issue(path, UNREADABLE_VALUE_ISSUE_MESSAGE.to_owned())]
        }
        ReceivedError::Unreferenced { index } => vec![issue(
            Vec::new(),
            format!("attachment {index} is named by no placeholder"),
        )],
        ReceivedError::Rule { report, received } => rule_issues(&report, &received),
    })
}

/// The first [`ISSUES_MAX`] broken rules of `report`, each at its path resolved against `checked`,
/// the JSON the value was read from or written as, with garde's message; no path past them is
/// resolved. A repeated workflow node id also carries its `nodeIdDuplicate` finding over the id
/// at that path.
pub fn rule_issues(report: &garde::Report, checked: &Value) -> Vec<Issue> {
    report
        .iter()
        .take(ISSUES_MAX)
        .map(|(check_path, rule_error)| {
            let path = resolve_issue_path(check_path, checked);
            let params = (rule_error.message() == NODE_ID_DUPLICATE_MESSAGE)
                .then(|| node_id_duplicate_finding(&path, checked))
                .flatten();
            Issue {
                path,
                message: rule_error.message().to_owned(),
                params,
            }
        })
        .collect()
}

/// The `nodeIdDuplicate` finding over the node id `checked` holds at `path`; `None` where the
/// path stops short of the id.
fn node_id_duplicate_finding(path: &[IssuePathSegment], checked: &Value) -> Option<JsonRecord> {
    let node_id = path
        .iter()
        .try_fold(checked, |at, segment| match segment {
            IssuePathSegment::Member(name) => at.get(name),
            IssuePathSegment::Index(index) => at.get(usize::try_from(index.get()).ok()?),
        })
        .and_then(Value::as_str)
        .and_then(|text| WorkflowNodeId::new(text.to_owned()))?;
    let finding = WorkflowDefinitionFinding::NodeIdDuplicate {
        node_ids: vec![node_id],
    };
    let members: serde_json::Map<String, Value> = serde_json::to_value(finding)
        .and_then(serde_json::from_value)
        .expect("a finding writes an object");
    let members = members
        .into_iter()
        .map(|(name, value)| (name, AnyValue(value)))
        .collect();
    Some(Record::new(members).expect("a finding has no member __proto__"))
}

/// What one step of garde's path is, as garde's `serde` form names it.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum CheckPathStepKind {
    /// A wrapper's one inner value, which adds no step.
    None,
    /// A field's Rust name or a map's key.
    Key,
    /// An index into a list or a tuple.
    Index,
}

/// The wire path of a garde fault at `check_path` in the value read from `received`. A member step
/// keeps the name `received` holds verbatim (a map key, a field serde names alike), else serde's
/// camelCase of the field where `received` holds that; a step neither resolves (a member serde
/// renamed) ends the path at its parent. An index into a tuple serde writes as its one field (a
/// newtype) adds no step.
pub fn resolve_issue_path(check_path: &garde::Path, received: &Value) -> Vec<IssuePathSegment> {
    let steps: Vec<(CheckPathStepKind, String)> = serde_json::to_value(check_path)
        .and_then(serde_json::from_value)
        .expect("garde writes a path as a list of kind and component pairs");
    let mut at = received;
    let mut segments = Vec::with_capacity(steps.len());
    for (kind, component) in steps {
        match kind {
            CheckPathStepKind::None => {}
            CheckPathStepKind::Key => {
                let Some((name, member)) = member_of(at, component) else {
                    break;
                };
                segments.push(IssuePathSegment::Member(name));
                at = member;
            }
            CheckPathStepKind::Index => {
                let Value::Array(elements) = at else {
                    continue;
                };
                let index: usize = component.parse().expect("garde writes an index as digits");
                let Some(element) = elements.get(index) else {
                    break;
                };
                segments.push(IssuePathSegment::index(index));
                at = element;
            }
        }
    }
    segments
}

// The member `received` holds for garde's key: the key as written, else its serde camelCase.
fn member_of(received: &Value, key: String) -> Option<(String, &Value)> {
    let Value::Object(members) = received else {
        return None;
    };
    if let Some(member) = members.get(&key) {
        return Some((key, member));
    }
    let camel_case = serde_camel_case(&key);
    let member = members.get(&camel_case)?;
    Some((camel_case, member))
}

// serde's `rename_all = "camelCase"` of a snake_case field: each `_` dropped and the letter after
// it raised, the first letter lowered.
fn serde_camel_case(field: &str) -> String {
    let mut pascal_case = String::with_capacity(field.len());
    let mut is_word_start = true;
    for character in field.chars() {
        if character == '_' {
            is_word_start = true;
        } else if is_word_start {
            pascal_case.push(character.to_ascii_uppercase());
            is_word_start = false;
        } else {
            pascal_case.push(character);
        }
    }
    let mut characters = pascal_case.chars();
    characters.next().map_or_else(String::new, |first| {
        first.to_ascii_lowercase().to_string() + characters.as_str()
    })
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Deserialize;
    use serde_json::json;

    use super::{IssuePathSegment, resolve_issue_path};
    use crate::wire::integer::SafeInt;

    #[derive(Deserialize, garde::Validate)]
    #[serde(rename_all = "camelCase")]
    struct Registry {
        #[garde(dive)]
        servers: BTreeMap<String, Server>,
    }

    #[derive(Deserialize, garde::Validate)]
    #[serde(rename_all = "camelCase")]
    struct Server {
        #[serde(rename = "type")]
        #[garde(length(min = 1))]
        transport: String,
        #[garde(dive)]
        remote_hosts: Vec<RemoteHost>,
    }

    #[derive(Deserialize, garde::Validate)]
    #[serde(rename_all = "camelCase")]
    struct RemoteHost {
        #[garde(length(max = 4))]
        host_name: String,
    }

    #[test]
    fn names_a_fault_in_wire_names_and_stops_at_a_renamed_member() {
        let received = json!({
            "servers": {
                "ssh_key": { "type": "", "remoteHosts": [{ "hostName": "a-long-host" }] },
            },
        });
        let registry: Registry = serde_json::from_value(received.clone()).expect("the shape reads");
        let report = garde::Validate::validate(&registry).expect_err("both checks fail");
        let mut paths: Vec<Vec<IssuePathSegment>> = report
            .iter()
            .map(|(check_path, _)| resolve_issue_path(check_path, &received))
            .collect();
        paths.sort_by_key(Vec::len);
        let member = |name: &str| IssuePathSegment::Member(name.to_owned());
        assert_eq!(
            paths,
            [
                // `transport` is sent as `type`, so the path ends at the server, its key as sent.
                vec![member("servers"), member("ssh_key")],
                vec![
                    member("servers"),
                    member("ssh_key"),
                    member("remoteHosts"),
                    IssuePathSegment::Index(SafeInt::ZERO),
                    member("hostName"),
                ],
            ],
        );
    }
}
