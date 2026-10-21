//! A node's reference parameters and its secret references, checked against the parameter list of
//! the node's kind. A reference names a record kept elsewhere, so a parameter never carries a
//! nested node or a tool's policy, and a `secret://` reference stands only in a parameter the kind
//! marks sensitive, never inside an expression. The check reads only its arguments: the builder
//! runs it through the WebAssembly export, and the daemon's save calls it once the save's kind
//! lookup gives each kind's parameter list.

use garde::Validate;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::agent::definition::AgentDefinitionId;
use crate::project::ProjectId;
use crate::session::id::SessionId;
use crate::workflow::definition::document::WorkflowToolBinding;
use crate::workflow::kind::{
    WorkflowCollectionParamSpec, WorkflowLeafParamSpec, WorkflowParamSpec, WorkflowParamType,
};
use crate::workflow::secret::WorkflowSecretReference;

/// What every secret reference starts with.
const SECRET_SCHEME: &str = "secret://";

/// One parameter value the check refused. `path` is the value's dotted place, its parameter's id
/// first (`headers.0.token` inside a repeating collection), and `message` names the fault, such as
/// a tool binding's `approvalMode`.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize))]
pub struct WorkflowParamIssue {
    /// The value's dotted place.
    pub path: String,
    /// The fault.
    pub message: String,
}

/// Checks one node's parameters against its kind's parameter list, walking into collections, and
/// returns every value refused: a reference that is not one (a secret outside the `secret://`
/// form, an id that is not one, a tool binding carrying a nested node or a policy), a `secret://`
/// value in a parameter the kind does not mark sensitive, and an expression naming `secret://`. A
/// parameter left out and an id the kind does not list are not checked here.
pub fn check_workflow_node_params(
    params: &Map<String, Value>,
    specs: &[WorkflowParamSpec],
) -> Vec<WorkflowParamIssue> {
    let mut issues = Vec::new();
    check_field_list(params, specs, "", &mut issues);
    issues
}

fn check_field_list(
    values: &Map<String, Value>,
    specs: &[WorkflowParamSpec],
    path_prefix: &str,
    issues: &mut Vec<WorkflowParamIssue>,
) {
    for spec in specs {
        match spec {
            WorkflowParamSpec::Leaf(leaf) => {
                if let Some(value) = values.get(leaf.id.0.as_str()) {
                    let place = format!("{path_prefix}{}", leaf.id.0.as_str());
                    check_leaf(leaf, value, &place, issues);
                }
            }
            WorkflowParamSpec::Collection(collection) => {
                if let Some(value) = values.get(collection.id.0.as_str()) {
                    let place = format!("{path_prefix}{}", collection.id.0.as_str());
                    check_collection(collection, value, &place, issues);
                }
            }
        }
    }
}

fn check_leaf(
    spec: &WorkflowLeafParamSpec,
    value: &Value,
    place: &str,
    issues: &mut Vec<WorkflowParamIssue>,
) {
    let is_sensitive = spec.sensitive == Some(true);
    if spec.param_type == WorkflowParamType::Secret {
        // The reference check below refuses a malformed reference and an expression, so only the
        // sensitive rule is checked for a secret parameter here.
        let is_reference = value
            .as_str()
            .is_some_and(|text| text.starts_with(SECRET_SCHEME));
        if is_reference && !is_sensitive {
            issues.push(outside_sensitive_issue(place));
        }
    } else {
        check_secret_text(value, is_sensitive, place, issues);
        // No expression resolves a secret, so only a secret parameter refuses one; every other
        // reference type also takes an expression.
        if value.as_str().is_some_and(is_expression) {
            return;
        }
    }
    match spec.param_type {
        WorkflowParamType::Secret => check_reference::<WorkflowSecretReference>(
            value,
            "expected a secret reference",
            place,
            issues,
        ),
        WorkflowParamType::Agent => {
            check_reference::<AgentDefinitionId>(
                value,
                "expected an agent definition id",
                place,
                issues,
            );
        }
        WorkflowParamType::Project => {
            check_reference::<ProjectId>(value, "expected a project id", place, issues);
        }
        WorkflowParamType::Session => {
            check_reference::<SessionId>(value, "expected a session id", place, issues);
        }
        WorkflowParamType::McpTool => check_tool_binding(value, place, issues),
        WorkflowParamType::String
        | WorkflowParamType::Text
        | WorkflowParamType::Number
        | WorkflowParamType::Boolean
        | WorkflowParamType::Select
        | WorkflowParamType::Multiselect
        | WorkflowParamType::Json
        | WorkflowParamType::Expression
        | WorkflowParamType::Path
        | WorkflowParamType::Glob
        | WorkflowParamType::Cron
        | WorkflowParamType::CallbackTool => {}
    }
}

// Refuses a value that does not read as the reference `Reference`. A non-string is reported with
// `not_text_message`, never by serde's message, which quotes the value and could leak a pasted
// secret; a string's refusal has a fixed message of its own.
fn check_reference<Reference: DeserializeOwned>(
    value: &Value,
    not_text_message: &str,
    place: &str,
    issues: &mut Vec<WorkflowParamIssue>,
) {
    let message = if value.is_string() {
        match Reference::deserialize(value) {
            Ok(_) => return,
            Err(error) => error.to_string(),
        }
    } else {
        not_text_message.to_owned()
    };
    issues.push(WorkflowParamIssue {
        path: place.to_owned(),
        message,
    });
}

// A tool binding reads as one only with no member past the server and the tool, so a nested node
// or a policy is refused by name, then its members are held to their rules.
fn check_tool_binding(value: &Value, place: &str, issues: &mut Vec<WorkflowParamIssue>) {
    let binding = match WorkflowToolBinding::deserialize(value) {
        Ok(binding) => binding,
        Err(error) => {
            issues.push(WorkflowParamIssue {
                path: place.to_owned(),
                message: error.to_string(),
            });
            return;
        }
    };
    if let Err(report) = binding.validate() {
        for (path, error) in report.iter() {
            let path = if path.is_empty() {
                place.to_owned()
            } else {
                format!("{place}.{path}")
            };
            issues.push(WorkflowParamIssue {
                path,
                message: error.message().to_owned(),
            });
        }
    }
}

// Walks every string a leaf value holds. A `secret://` value outside a sensitive parameter is
// refused; inside one it must be a whole reference, and no expression may name one.
fn check_secret_text(
    value: &Value,
    is_sensitive: bool,
    place: &str,
    issues: &mut Vec<WorkflowParamIssue>,
) {
    match value {
        Value::String(text) => {
            if is_expression(text) {
                if text.contains(SECRET_SCHEME) {
                    issues.push(WorkflowParamIssue {
                        path: place.to_owned(),
                        message: "No expression resolves a secret.".to_owned(),
                    });
                }
            } else if text.starts_with(SECRET_SCHEME) {
                if is_sensitive {
                    if let Err(error) = text.parse::<WorkflowSecretReference>() {
                        issues.push(WorkflowParamIssue {
                            path: place.to_owned(),
                            message: error.to_string(),
                        });
                    }
                } else {
                    issues.push(outside_sensitive_issue(place));
                }
            }
        }
        Value::Array(entries) => {
            for (index, entry) in entries.iter().enumerate() {
                check_secret_text(entry, is_sensitive, &format!("{place}.{index}"), issues);
            }
        }
        Value::Object(members) => {
            for (key, entry) in members {
                check_secret_text(entry, is_sensitive, &format!("{place}.{key}"), issues);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn outside_sensitive_issue(place: &str) -> WorkflowParamIssue {
    WorkflowParamIssue {
        path: place.to_owned(),
        message: "A secret:// reference stands only in a parameter its kind marks sensitive."
            .to_owned(),
    }
}

// A repeating collection holds a list of records and a single one a record; any other value holds
// no reference to check.
fn check_collection(
    spec: &WorkflowCollectionParamSpec,
    value: &Value,
    place: &str,
    issues: &mut Vec<WorkflowParamIssue>,
) {
    if spec.multiple == Some(true) {
        if let Value::Array(entries) = value {
            for (index, entry) in entries.iter().enumerate() {
                if let Value::Object(fields) = entry {
                    check_field_list(fields, &spec.fields, &format!("{place}.{index}."), issues);
                }
            }
        }
    } else if let Value::Object(fields) = value {
        check_field_list(fields, &spec.fields, &format!("{place}."), issues);
    }
}

// An expression is `={{ … }}`, anything between the braces; the opening and closing pairs cannot
// overlap, so `={{}}` is the shortest.
fn is_expression(text: &str) -> bool {
    text.starts_with("={{") && text.ends_with("}}")
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::check_workflow_node_params;
    use crate::workflow::kind::WorkflowParamSpec;

    fn specs() -> Vec<WorkflowParamSpec> {
        serde_json::from_value(json!([
            { "id": "definition", "label": "Agent", "type": "agent" },
            { "id": "prompt", "label": "Prompt", "type": "text" },
            {
                "id": "headers",
                "label": "Headers",
                "type": "collection",
                "multiple": true,
                "fields": [
                    { "id": "name", "label": "Name", "type": "string" },
                    { "id": "token", "label": "Token", "type": "secret", "sensitive": true },
                ],
            },
        ]))
        .expect("the specs read")
    }

    // Each case's issues as their paths and a part of each message.
    #[rstest]
    #[case::a_secret_outside_a_sensitive_param(
        json!({ "prompt": "secret://shared/mail" }),
        &[("prompt", "marks sensitive")],
    )]
    #[case::an_expression_naming_a_secret(
        json!({ "prompt": "={{ \"secret://shared/mail\" }}" }),
        &[("prompt", "No expression resolves a secret.")],
    )]
    #[case::a_plain_value_in_a_nested_collection_secret(
        json!({ "headers": [{ "name": "Authorization", "token": "ghp_inline-token-value" }] }),
        &[("headers.0.token", "secret://shared/<name>")],
    )]
    #[case::the_shortest_expression_skips_the_reference_read(
        json!({ "definition": "={{}}" }),
        &[],
    )]
    #[case::one_brace_short_is_read_as_a_reference(
        json!({ "definition": "={{}" }),
        &[("definition", "the id is not an RFC 9562 UUID text form")],
    )]
    fn the_params_check_refuses_what_could_leak_a_secret(
        #[case] params: Value,
        #[case] expected: &[(&str, &str)],
    ) {
        let params = params.as_object().expect("the params are an object");
        let issues = check_workflow_node_params(params, &specs());
        assert_eq!(issues.len(), expected.len(), "{issues:?}");
        for (issue, (path, message)) in issues.iter().zip(expected) {
            assert_eq!(issue.path, *path, "{issue:?}");
            assert!(issue.message.contains(message), "{issue:?}");
        }
    }

    // A number pasted into a secret parameter is refused without quoting it, so the value reaches
    // neither the reply nor a log.
    #[test]
    fn a_number_in_a_secret_param_is_refused_without_its_digits() {
        let params = json!({ "headers": [{ "token": 48_213_377 }] });
        let params = params.as_object().expect("the params are an object");
        let issues = check_workflow_node_params(params, &specs());
        assert_eq!(issues.len(), 1, "{issues:?}");
        let issue = &issues[0];
        assert_eq!(issue.path, "headers.0.token");
        assert!(
            !issue
                .message
                .contains(|character: char| "48213377".contains(character)),
            "{issue:?}"
        );
    }
}
