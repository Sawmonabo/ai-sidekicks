//! A node's reference parameters and its secret references, checked against the parameter list of
//! the node's kind. A reference names a record kept elsewhere, so a parameter never carries a
//! nested node or a tool's policy, and a `secret://` reference stands only in a parameter the kind
//! marks sensitive, never inside an expression. The check reads only its arguments: the builder
//! runs it through the WebAssembly export, and the daemon's save calls it once the save's kind
//! lookup gives each kind's parameter list.

use garde::Validate;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::definition::AgentDefinitionId;
use crate::project::ProjectId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::workflow::definition::document::WorkflowToolBinding;
use crate::workflow::definition::expression_template::{
    TemplateError, TemplatePart, TemplateText, read_template,
};
use crate::workflow::definition::refusals::WorkflowDefinitionRule;
use crate::workflow::kind::{
    WorkflowCollectionParamSpec, WorkflowLeafParamSpec, WorkflowParamSpec, WorkflowParamType,
};
use crate::workflow::secret::WorkflowSecretReference;

/// What every secret reference starts with.
const SECRET_SCHEME: &str = "secret://";

/// One parameter value the check refused. `path` is the value's dotted place, its parameter's id
/// first (`headers.0.token` inside a repeating collection), `message` names the fault, such as
/// a tool binding's `approvalMode`, and `rule` the finding the save raises for it, where one does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowParamIssue {
    /// The value's dotted place.
    pub path: String,
    /// The fault.
    pub message: String,
    /// The finding the save raises for the value: a secret outside a sensitive parameter or
    /// inside an expression; absent for a reference that does not read as one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(with = "WorkflowDefinitionRule")]
    pub rule: Option<WorkflowDefinitionRule>,
}

/// The parameter check's arguments as the builder sends them: one node's parameters and its
/// kind's parameter list.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeParamsCheckInput {
    /// The node's parameters by id.
    #[serde(deserialize_with = "crate::wire::record::prototype_free")]
    #[schemars(extend("propertyNames" = crate::wire::record::prototype_free_names()))]
    pub params: Map<String, Value>,
    /// The kind's parameter list.
    pub specs: Vec<WorkflowParamSpec>,
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
        // The reference check below refuses a malformed reference and any other expression, so
        // only the sensitive rule and an expression naming a secret are checked here.
        let text = value.as_str().unwrap_or_default();
        if text.starts_with('=') && text.contains(SECRET_SCHEME) {
            issues.push(in_expression_issue(place));
            return;
        }
        if text.starts_with(SECRET_SCHEME) && !is_sensitive {
            issues.push(outside_sensitive_issue(place));
        }
    } else {
        check_secret_text(value, is_sensitive, place, issues);
        // No expression resolves a secret, so only a secret parameter refuses a template; every
        // other reference type also takes one. Text whose part never closes is read as a reference.
        if value
            .as_str()
            .is_some_and(|text| matches!(read_template(text), Ok(TemplateText::Expression(_))))
        {
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
        rule: None,
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
                rule: None,
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
                rule: None,
            });
        }
    }
}

// Walks every string a leaf value holds. A `secret://` literal outside a sensitive parameter is
// refused; inside one it must be a whole reference. No `=` text may name one, a template in any
// part, the text after an `=` that opens no part, or a template whose part never closes.
fn check_secret_text(
    value: &Value,
    is_sensitive: bool,
    place: &str,
    issues: &mut Vec<WorkflowParamIssue>,
) {
    match value {
        Value::String(text) => {
            let names_secret = match read_template(text) {
                // An `=` that opens no part still marks an expression, which resolves no secret.
                Ok(TemplateText::Literal(literal)) if text.starts_with('=') => {
                    literal.contains(SECRET_SCHEME)
                }
                Ok(TemplateText::Literal(literal)) => {
                    check_secret_literal(literal, is_sensitive, place, issues);
                    false
                }
                Ok(TemplateText::Expression(template)) => {
                    template.parts().iter().any(|part| match part {
                        TemplatePart::Text(part_text) | TemplatePart::Expression(part_text) => {
                            part_text.contains(SECRET_SCHEME)
                        }
                    })
                }
                Err(TemplateError::Unclosed { .. }) => text.contains(SECRET_SCHEME),
            };
            if names_secret {
                issues.push(in_expression_issue(place));
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

// A literal is a reference only when it starts with `secret://`, and then stands only whole in a
// sensitive parameter.
fn check_secret_literal(
    literal: &str,
    is_sensitive: bool,
    place: &str,
    issues: &mut Vec<WorkflowParamIssue>,
) {
    if !literal.starts_with(SECRET_SCHEME) {
        return;
    }
    if !is_sensitive {
        issues.push(outside_sensitive_issue(place));
    } else if let Err(error) = literal.parse::<WorkflowSecretReference>() {
        issues.push(WorkflowParamIssue {
            path: place.to_owned(),
            message: error.to_string(),
            rule: None,
        });
    }
}

fn outside_sensitive_issue(place: &str) -> WorkflowParamIssue {
    WorkflowParamIssue {
        path: place.to_owned(),
        message: "A secret:// reference stands only in a parameter its kind marks sensitive."
            .to_owned(),
        rule: Some(WorkflowDefinitionRule::SecretOutsideSensitiveField),
    }
}

fn in_expression_issue(place: &str) -> WorkflowParamIssue {
    WorkflowParamIssue {
        path: place.to_owned(),
        message: "No expression resolves a secret.".to_owned(),
        rule: Some(WorkflowDefinitionRule::SecretInExpression),
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

/// The TypeScript module of the parameter check's arguments and the values it refuses.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/params",
    doc: "The parameter check's arguments and the values it refuses.",
    definitions: &[
        Definition::read::<WorkflowParamIssue>(),
        Definition::read::<WorkflowNodeParamsCheckInput>(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{WorkflowParamIssue, check_workflow_node_params};
    use crate::workflow::definition::refusals::WorkflowDefinitionRule;
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
                    { "id": "value", "label": "Value", "type": "string", "sensitive": true },
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
    // A part after literal text still makes the value a template.
    #[case::a_secret_in_a_part_after_text(
        json!({ "prompt": "=Bearer {{ \"secret://shared/mail\" }}" }),
        &[("prompt", "No expression resolves a secret.")],
    )]
    #[case::a_whole_reference_in_a_sensitive_param(
        json!({ "headers": [{ "value": "secret://shared/mail" }] }),
        &[],
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

    // An `=` text naming a secret is an expression, which resolves none, so even a sensitive
    // parameter refuses it, under the rule of its own; read as a literal it would pass whole and
    // reach the step as plain text. Mutation: the check reads an `=` that opens no part as a
    // literal.
    #[rstest]
    #[case::a_sensitive_text_param(
        json!({ "headers": [{ "value": "=secret://shared/x" }] }),
        "headers.0.value"
    )]
    #[case::a_secret_param(
        json!({ "headers": [{ "token": "=secret://shared/x" }] }),
        "headers.0.token"
    )]
    fn an_equals_form_naming_a_secret_is_refused_in_a_sensitive_param(
        #[case] params: Value,
        #[case] path: &str,
    ) {
        let params = params.as_object().expect("the params are an object");
        assert_eq!(
            check_workflow_node_params(params, &specs()),
            vec![WorkflowParamIssue {
                path: path.to_owned(),
                message: "No expression resolves a secret.".to_owned(),
                rule: Some(WorkflowDefinitionRule::SecretInExpression),
            }]
        );
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
