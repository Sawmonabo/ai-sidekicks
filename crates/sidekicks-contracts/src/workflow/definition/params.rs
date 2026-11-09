//! A node's parameters checked against the parameter list of the node's kind: a required parameter
//! left empty, a member the kind does not list, a reference, tool binding or collection that does
//! not read as one, and a secret reference out of place. A reference names a record kept
//! elsewhere, so a parameter never carries a nested node or a tool's policy, and a `secret://`
//! reference stands only in a parameter the kind marks sensitive, never inside an expression. The
//! check reads only its arguments: the builder runs it through the WebAssembly export, and the
//! daemon's save calls it for each node with its kind's parameter list.

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::definition::AgentDefinitionId;
use crate::jsonrpc::issue::{IssuePathSegment, reader_issue_path};
use crate::project::ProjectId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::AnyValue;
use crate::wire::record::Record;
use crate::wire::text::is_ecmascript_whitespace;
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

/// One parameter value the check refused. `path` is the value's place, its parameter's id first
/// (`["headers", 0, "token"]` inside a repeating collection, `["tool", "approvalMode"]` for a
/// member a tool binding does not take), `message` names the fault and never quotes the value, and
/// `rule` the finding the save raises for it, where one does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowParamIssue {
    /// The value's place, one step per member or index, so an id holding a dot stays one step.
    pub path: Vec<IssuePathSegment>,
    /// The fault.
    pub message: String,
    /// The finding the save raises for the value: `paramMissing`, `unknownKey`,
    /// `secretOutsideSensitiveField` or `secretInExpression`; absent for a reference, a tool
    /// binding or a collection that does not read as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

/// The condition check's arguments as the builder sends them: a condition read as a param's
/// `showWhen` and a kind's sandbox are, the values it is read against, and the parameter list
/// whose defaults stand in for a value left out.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowConditionCheckInput {
    /// Each named param's listed values.
    pub condition: Record<String, Vec<AnyValue>>,
    /// The values by param id.
    #[serde(deserialize_with = "crate::wire::record::prototype_free")]
    #[schemars(extend("propertyNames" = crate::wire::record::prototype_free_names()))]
    pub params: Map<String, Value>,
    /// The parameter list the named params belong to.
    pub specs: Vec<WorkflowParamSpec>,
}

/// Checks one node's parameters against its kind's parameter list, walking into collections, and
/// returns every value refused: a reference that is not one (a secret outside the `secret://`
/// form, an id that is not one, a tool binding carrying a nested node or a policy), a collection
/// of the wrong shape, a `secret://` value in a parameter the kind does not mark sensitive, an
/// expression naming `secret://`, a required parameter left empty while it is drawn, and a member
/// the kind does not list.
pub fn check_workflow_node_params(
    params: &Map<String, Value>,
    specs: &[WorkflowParamSpec],
) -> Vec<WorkflowParamIssue> {
    let mut issues = Vec::new();
    check_field_list(params, specs, &[], &mut issues);
    issues
}

// `place` with `step` added at its end.
fn step_into(place: &[IssuePathSegment], step: IssuePathSegment) -> Vec<IssuePathSegment> {
    place.iter().cloned().chain([step]).collect()
}

fn member(name: &str) -> IssuePathSegment {
    IssuePathSegment::Member(name.to_owned())
}

fn check_field_list(
    values: &Map<String, Value>,
    specs: &[WorkflowParamSpec],
    path_prefix: &[IssuePathSegment],
    issues: &mut Vec<WorkflowParamIssue>,
) {
    for spec in specs {
        match spec {
            WorkflowParamSpec::Leaf(leaf) => {
                let place = step_into(path_prefix, member(leaf.id.0.as_str()));
                let value = values.get(leaf.id.0.as_str());
                if leaf.required == Some(true)
                    && is_drawn(leaf, values, specs)
                    && is_left_empty(value.or(leaf.default.as_ref().map(|default| &default.0)))
                {
                    issues.push(WorkflowParamIssue {
                        path: place.clone(),
                        message: "A required parameter is left empty.".to_owned(),
                        rule: Some(WorkflowDefinitionRule::ParamMissing),
                    });
                }
                if let Some(value) = value {
                    check_leaf(leaf, value, &place, issues);
                }
            }
            WorkflowParamSpec::Collection(collection) => {
                let place = step_into(path_prefix, member(collection.id.0.as_str()));
                check_collection(
                    collection,
                    values.get(collection.id.0.as_str()),
                    &place,
                    issues,
                );
            }
        }
    }
    for key in values.keys() {
        if !specs.iter().any(|spec| param_id(spec) == key) {
            issues.push(WorkflowParamIssue {
                path: step_into(path_prefix, member(key)),
                message: "The node's kind lists no such parameter.".to_owned(),
                rule: Some(WorkflowDefinitionRule::UnknownKey),
            });
        }
    }
}

fn param_id(spec: &WorkflowParamSpec) -> &str {
    match spec {
        WorkflowParamSpec::Leaf(leaf) => leaf.id.0.as_str(),
        WorkflowParamSpec::Collection(collection) => collection.id.0.as_str(),
    }
}

// A parameter is drawn unless its `showWhen` names a sibling whose value, or its default where the
// node holds none, is none of the values listed for it.
fn is_drawn(
    leaf: &WorkflowLeafParamSpec,
    values: &Map<String, Value>,
    siblings: &[WorkflowParamSpec],
) -> bool {
    leaf.show_when
        .as_ref()
        .is_none_or(|show_when| is_condition_met(show_when, |id| values.get(id), siblings))
}

/// Whether each param `condition` names holds one of its listed values, `value_of` giving the
/// node's value by param id and the param's default in `params` standing in where it gives none.
pub(crate) fn is_condition_met<'a>(
    condition: &Record<String, Vec<AnyValue>>,
    value_of: impl Fn(&str) -> Option<&'a Value>,
    params: &'a [WorkflowParamSpec],
) -> bool {
    condition.as_map().iter().all(|(param_id, listed)| {
        let value = value_of(param_id).or_else(|| {
            params.iter().find_map(|param| match param {
                WorkflowParamSpec::Leaf(param) if param.id.0.as_str() == param_id => {
                    param.default.as_ref().map(|default| &default.0)
                }
                WorkflowParamSpec::Leaf(_) | WorkflowParamSpec::Collection(_) => None,
            })
        });
        value.is_some_and(|value| listed.iter().any(|listed| listed.0 == *value))
    })
}

// Empty as a form reads it: absent, `null`, blank text or an empty list; `false` is an answer.
fn is_left_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.chars().all(is_ecmascript_whitespace),
        Some(Value::Array(entries)) => entries.is_empty(),
        Some(Value::Bool(_) | Value::Number(_) | Value::Object(_)) => false,
    }
}

fn check_leaf(
    spec: &WorkflowLeafParamSpec,
    value: &Value,
    place: &[IssuePathSegment],
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
    place: &[IssuePathSegment],
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
        path: place.to_vec(),
        message,
        rule: None,
    });
}

// A tool binding reads as one only with no member past the server and the tool, so a nested node
// or a policy is refused at its key. A refused read is named by its place alone, never by serde's
// message, which quotes the value and could leak a pasted secret; a member left out is named at
// the binding's place.
fn check_tool_binding(
    value: &Value,
    place: &[IssuePathSegment],
    issues: &mut Vec<WorkflowParamIssue>,
) {
    if let Err(error) = serde_path_to_error::deserialize::<_, WorkflowToolBinding>(value) {
        issues.push(WorkflowParamIssue {
            path: place
                .iter()
                .cloned()
                .chain(reader_issue_path(error.path()))
                .collect(),
            message: "expected a tool binding: its server binding and its tool name, and no \
                      other member"
                .to_owned(),
            rule: None,
        });
    }
}

// Walks every string a leaf value holds. A `secret://` literal outside a sensitive parameter is
// refused; inside one it must be a whole reference. No `=` text may name one, a template in any
// part, the text after an `=` that opens no part, or a template whose part never closes.
fn check_secret_text(
    value: &Value,
    is_sensitive: bool,
    place: &[IssuePathSegment],
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
                let entry_place = step_into(place, IssuePathSegment::index(index));
                check_secret_text(entry, is_sensitive, &entry_place, issues);
            }
        }
        Value::Object(members) => {
            for (key, entry) in members {
                check_secret_text(entry, is_sensitive, &step_into(place, member(key)), issues);
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
    place: &[IssuePathSegment],
    issues: &mut Vec<WorkflowParamIssue>,
) {
    if !literal.starts_with(SECRET_SCHEME) {
        return;
    }
    if !is_sensitive {
        issues.push(outside_sensitive_issue(place));
    } else if let Err(error) = literal.parse::<WorkflowSecretReference>() {
        issues.push(WorkflowParamIssue {
            path: place.to_vec(),
            message: error.to_string(),
            rule: None,
        });
    }
}

fn outside_sensitive_issue(place: &[IssuePathSegment]) -> WorkflowParamIssue {
    WorkflowParamIssue {
        path: place.to_vec(),
        message: "A secret:// reference stands only in a parameter its kind marks sensitive."
            .to_owned(),
        rule: Some(WorkflowDefinitionRule::SecretOutsideSensitiveField),
    }
}

fn in_expression_issue(place: &[IssuePathSegment]) -> WorkflowParamIssue {
    WorkflowParamIssue {
        path: place.to_vec(),
        message: "No expression resolves a secret.".to_owned(),
        rule: Some(WorkflowDefinitionRule::SecretInExpression),
    }
}

// A repeating collection holds a list of records and a single one a record, which an absent or
// `null` value holds empty so its required fields are still found; a value of any other shape is
// refused at its place.
fn check_collection(
    spec: &WorkflowCollectionParamSpec,
    value: Option<&Value>,
    place: &[IssuePathSegment],
    issues: &mut Vec<WorkflowParamIssue>,
) {
    if spec.multiple == Some(true) {
        match value {
            Some(Value::Array(entries)) => {
                for (index, entry) in entries.iter().enumerate() {
                    let entry_place = step_into(place, IssuePathSegment::index(index));
                    if let Value::Object(fields) = entry {
                        check_field_list(fields, &spec.fields, &entry_place, issues);
                    } else {
                        issues.push(not_a_record_issue(entry_place));
                    }
                }
            }
            None | Some(Value::Null) => {}
            Some(_) => issues.push(WorkflowParamIssue {
                path: place.to_vec(),
                message: "expected a list of the collection's entries".to_owned(),
                rule: None,
            }),
        }
    } else {
        match value {
            Some(Value::Object(fields)) => {
                check_field_list(fields, &spec.fields, place, issues);
            }
            None | Some(Value::Null) => {
                check_field_list(&Map::new(), &spec.fields, place, issues);
            }
            Some(_) => issues.push(not_a_record_issue(place.to_vec())),
        }
    }
}

fn not_a_record_issue(path: Vec<IssuePathSegment>) -> WorkflowParamIssue {
    WorkflowParamIssue {
        path,
        message: "expected a record of the collection's fields".to_owned(),
        rule: None,
    }
}

/// The TypeScript module of the parameter check's arguments and the values it refuses.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/params",
    doc: "The parameter check's arguments and the values it refuses, and the condition check's \
          arguments.",
    definitions: &[
        Definition::read::<WorkflowParamIssue>(),
        Definition::read::<WorkflowNodeParamsCheckInput>(),
        Definition::read::<WorkflowConditionCheckInput>(),
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
        &[(json!(["prompt"]), "marks sensitive")],
    )]
    #[case::an_expression_naming_a_secret(
        json!({ "prompt": "={{ \"secret://shared/mail\" }}" }),
        &[(json!(["prompt"]), "No expression resolves a secret.")],
    )]
    // A part after literal text still makes the value a template.
    #[case::a_secret_in_a_part_after_text(
        json!({ "prompt": "=Bearer {{ \"secret://shared/mail\" }}" }),
        &[(json!(["prompt"]), "No expression resolves a secret.")],
    )]
    #[case::a_whole_reference_in_a_sensitive_param(
        json!({ "headers": [{ "value": "secret://shared/mail" }] }),
        &[],
    )]
    #[case::a_plain_value_in_a_nested_collection_secret(
        json!({ "headers": [{ "name": "Authorization", "token": "ghp_inline-token-value" }] }),
        &[(json!(["headers", 0, "token"]), "secret://shared/<name>")],
    )]
    #[case::the_shortest_expression_skips_the_reference_read(
        json!({ "definition": "={{}}" }),
        &[],
    )]
    #[case::one_brace_short_is_read_as_a_reference(
        json!({ "definition": "={{}" }),
        &[(json!(["definition"]), "the id is not an RFC 9562 UUID text form")],
    )]
    fn the_params_check_refuses_what_could_leak_a_secret(
        #[case] params: Value,
        #[case] expected: &[(Value, &str)],
    ) {
        let params = params.as_object().expect("the params are an object");
        let issues = check_workflow_node_params(params, &specs());
        assert_eq!(issues.len(), expected.len(), "{issues:?}");
        for (issue, (path, message)) in issues.iter().zip(expected) {
            assert_eq!(path_of(issue), *path, "{issue:?}");
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
        json!(["headers", 0, "value"])
    )]
    #[case::a_secret_param(
        json!({ "headers": [{ "token": "=secret://shared/x" }] }),
        json!(["headers", 0, "token"])
    )]
    fn an_equals_form_naming_a_secret_is_refused_in_a_sensitive_param(
        #[case] params: Value,
        #[case] path: Value,
    ) {
        let params = params.as_object().expect("the params are an object");
        assert_eq!(
            check_workflow_node_params(params, &specs()),
            vec![WorkflowParamIssue {
                path: serde_json::from_value(path).expect("the path reads"),
                message: "No expression resolves a secret.".to_owned(),
                rule: Some(WorkflowDefinitionRule::SecretInExpression),
            }]
        );
    }

    // An issue's path as JSON, one item per step.
    fn path_of(issue: &WorkflowParamIssue) -> Value {
        serde_json::to_value(&issue.path).expect("a path writes as JSON")
    }

    fn rule_issues(
        params: &Value,
        specs: &[WorkflowParamSpec],
    ) -> Vec<(Value, WorkflowDefinitionRule)> {
        let params = params.as_object().expect("the params are an object");
        check_workflow_node_params(params, specs)
            .iter()
            .filter_map(|issue| issue.rule.map(|rule| (path_of(issue), rule)))
            .collect()
    }

    // A required parameter is refused when it is drawn and left empty, its default filling one the
    // node leaves out, a field a `showWhen` hides passing, and a single collection's required field
    // found even when the node leaves the collection out or sets it to `null`. Mutations: drop the
    // required check; skip the `showWhen` read; read the default as no value; read blank text as
    // filled; skip an absent collection; read `null` as a collection of the wrong shape.
    #[rstest]
    #[case::left_out(json!({ "mode": "plain", "auth": { "user": "a" } }), json!([["target"]]))]
    #[case::blank(
        json!({ "mode": "plain", "target": " \t", "auth": { "user": "a" } }),
        json!([["target"]])
    )]
    #[case::an_empty_list(
        json!({ "mode": "plain", "target": [], "auth": { "user": "a" } }),
        json!([["target"]])
    )]
    #[case::filled(
        json!({ "mode": "plain", "target": "=$json.path", "auth": { "user": "a" } }),
        json!([])
    )]
    #[case::hidden(json!({ "mode": "advanced", "auth": { "user": "a" } }), json!([]))]
    #[case::shown_by_its_siblings_default(
        json!({ "auth": { "user": "a" } }),
        json!([["target"]])
    )]
    #[case::a_collection_left_out(
        json!({ "mode": "plain", "target": "a" }),
        json!([["auth", "user"]])
    )]
    #[case::a_collection_set_to_null(
        json!({ "mode": "plain", "target": "a", "auth": null }),
        json!([["auth", "user"]])
    )]
    fn a_required_param_left_empty_is_refused(#[case] params: Value, #[case] missing: Value) {
        let specs: Vec<WorkflowParamSpec> = serde_json::from_value(json!([
            {
                "id": "mode", "label": "Mode", "type": "select", "default": "plain",
                "options": [
                    { "value": "plain", "label": "Plain" },
                    { "value": "advanced", "label": "Advanced" },
                ],
            },
            {
                "id": "target", "label": "Target", "type": "string", "required": true,
                "showWhen": { "mode": ["plain"] },
            },
            {
                "id": "retries", "label": "Retries", "type": "number", "required": true,
                "default": 3,
            },
            {
                "id": "auth", "label": "Auth", "type": "collection",
                "fields": [{ "id": "user", "label": "User", "type": "string", "required": true }],
            },
        ]))
        .expect("the specs read");
        let expected: Vec<_> = missing
            .as_array()
            .expect("the missing paths are a list")
            .iter()
            .map(|path| (path.clone(), WorkflowDefinitionRule::ParamMissing))
            .collect();
        assert_eq!(rule_issues(&params, &specs), expected);
    }

    // A member the kind does not list is refused at its place, at the top and inside a
    // collection's entry, while every listed one passes. Mutations: drop the unknown-key walk;
    // walk only the top.
    #[test]
    fn a_member_the_kind_does_not_list_is_refused() {
        let params = json!({
            "prompt": "a",
            "approvalMode": "never",
            "headers": [{ "name": "a" }, { "name": "b", "policy": "allow" }],
        });
        assert_eq!(
            rule_issues(&params, &specs()),
            vec![
                (
                    json!(["headers", 1, "policy"]),
                    WorkflowDefinitionRule::UnknownKey
                ),
                (json!(["approvalMode"]), WorkflowDefinitionRule::UnknownKey),
            ]
        );
    }

    // A collection's value of the wrong shape is refused at its place with no finding: a single
    // collection given text, a repeating one given a record, and an entry that is no record.
    // Mutations: let each shape pass.
    #[rstest]
    #[case::a_single_collection_given_text(json!({ "auth": "a" }), json!(["auth"]))]
    #[case::a_repeating_collection_given_a_record(
        json!({ "headers": { "name": "a" } }),
        json!(["headers"])
    )]
    #[case::an_entry_that_is_no_record(
        json!({ "headers": [{ "name": "a" }, "b"] }),
        json!(["headers", 1])
    )]
    fn a_collection_of_the_wrong_shape_is_refused(#[case] params: Value, #[case] path: Value) {
        let specs: Vec<WorkflowParamSpec> = serde_json::from_value(json!([
            {
                "id": "auth", "label": "Auth", "type": "collection",
                "fields": [{ "id": "user", "label": "User", "type": "string" }],
            },
            {
                "id": "headers", "label": "Headers", "type": "collection", "multiple": true,
                "fields": [{ "id": "name", "label": "Name", "type": "string" }],
            },
        ]))
        .expect("the specs read");
        let params = params.as_object().expect("the params are an object");
        let issues = check_workflow_node_params(params, &specs);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(path_of(&issues[0]), path, "{issues:?}");
        assert_eq!(issues[0].rule, None, "{issues:?}");
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
        assert_eq!(path_of(issue), json!(["headers", 0, "token"]));
        assert!(
            !issue
                .message
                .contains(|character: char| "48213377".contains(character)),
            "{issue:?}"
        );
    }

    // A tool binding that does not read is refused at the key that broke the read, and its issue
    // quotes nothing of the value, a pasted token or the digits of a number. Mutation: pass serde's
    // message through, which quotes both.
    #[rstest]
    #[case::text_where_the_binding_belongs(
        json!({ "tool": "ghp_inline-token-value" }),
        json!(["tool"]),
        "ghp_inline-token-value"
    )]
    #[case::a_number_as_the_tool_name(
        json!({
            "tool": {
                "binding": { "scope": "user", "provider": "codex", "serverName": "github" },
                "toolName": 48_213_377,
            },
        }),
        json!(["tool", "toolName"]),
        "48213377"
    )]
    fn a_tool_binding_that_does_not_read_is_refused_without_its_value(
        #[case] params: Value,
        #[case] path: Value,
        #[case] value_text: &str,
    ) {
        let specs: Vec<WorkflowParamSpec> = serde_json::from_value(json!([
            { "id": "tool", "label": "Tool", "type": "mcpTool" },
        ]))
        .expect("the specs read");
        let params = params.as_object().expect("the params are an object");
        let issues = check_workflow_node_params(params, &specs);
        assert_eq!(issues.len(), 1, "{issues:?}");
        let issue = &issues[0];
        assert_eq!(path_of(issue), path, "{issue:?}");
        assert_eq!(issue.rule, None, "{issue:?}");
        assert!(!issue.message.contains(value_text), "{issue:?}");
    }
}
