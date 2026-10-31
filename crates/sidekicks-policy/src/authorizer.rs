//! The built-in approval rules over the daemon's own tools, compiled in, parsed and checked against
//! their schema once, and every decision taken against them. Rules that do not parse, or do not
//! check against the schema, stop the start; a decision whose evaluation errors is a deny, never an
//! allow.

use std::fmt::Display;
use std::str::FromStr;
use std::sync::Arc;

use cedar_policy::{
    AuthorizationError, CedarSchemaError, Context, Decision, Entities, EntityId, EntityTypeName,
    EntityUid, ParseErrors, PolicySet, Request, Schema, SchemaWarning, ValidationError,
    ValidationMode, Validator,
};
use sidekicks_contracts::session::id::UserId;

/// The schema the built-in rules check against.
const BUILT_IN_SCHEMA: &str = include_str!("rules/schema.cedarschema");

/// The built-in rule files, each named as it sits in `policy/rules/`.
const BUILT_IN_RULE_FILES: &[RuleFile<'static>] = &[RuleFile {
    name: "workflow.cedar",
    text: include_str!("rules/workflow.cedar"),
}];

/// One file of rules: its name, which a load error names, and its text.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RuleFile<'a> {
    /// The file's name, as a load error names it.
    pub(crate) name: &'a str,
    /// The rules the file holds, in the rules engine's policy language.
    pub(crate) text: &'a str,
}

/// One check against the rules: the action as the schema names it, on a resource named by its
/// entity type and id, for one user, with a JSON context the action's schema types. A request the
/// schema does not admit is denied.
#[derive(Debug, Clone)]
pub struct PolicyRequest<'a> {
    /// The user the request acts for.
    pub principal: &'a UserId,
    /// The action's id as the schema declares it, such as `workflow::start`.
    pub action: &'a str,
    /// What the action acts on.
    pub resource: PolicyResource<'a>,
    /// The context the rules read, a JSON object the action's context type must admit.
    pub context: serde_json::Value,
}

/// The resource a request acts on: its entity type as the schema names it, and its id.
#[derive(Debug, Clone, Copy)]
pub struct PolicyResource<'a> {
    /// The entity type, such as `Workflow`.
    pub entity_type: &'a str,
    /// The entity's id.
    pub id: &'a str,
}

/// What the rules decide. A deny carries the evaluation's errors, empty when no rule permits the
/// request or one forbids it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    /// A rule permits the request, none forbids it and nothing errored.
    Allow,
    /// The request may not proceed.
    Deny {
        /// The errors that refused the request or its evaluation, empty for a plain deny.
        errors: Vec<String>,
    },
}

/// Why a set of rules did not load; each keeps the rules engine's own errors.
#[derive(Debug, thiserror::Error)]
pub enum RulesLoadError {
    /// The schema's text does not parse.
    #[error("approval rules: the schema does not parse")]
    SchemaDoesNotParse(#[source] Box<CedarSchemaError>),
    /// The schema parses with warnings; the rules are compiled in, so a warning is fixed before it
    /// ships.
    #[error("approval rules: the schema has warnings: {}", joined(.warnings))]
    SchemaHasWarnings {
        /// Every warning the schema gave.
        warnings: Vec<SchemaWarning>,
    },
    /// One rule file does not parse on its own.
    #[error("approval rules: {file_name} does not parse")]
    RuleFileDoesNotParse {
        /// The file's name.
        file_name: String,
        /// The parser's errors.
        #[source]
        error: Box<ParseErrors>,
    },
    /// The rule files, each parsing alone, do not parse joined.
    #[error("approval rules: the rule files do not parse together")]
    RulesDoNotParse(#[source] Box<ParseErrors>),
    /// A rule does not check against the schema.
    #[error("approval rules: the rules do not check against the schema: {}", joined(.errors))]
    RulesDoNotCheck {
        /// Every error the strict check found.
        errors: Vec<ValidationError>,
    },
}

/// A set of rules parsed and checked against its schema once, held for every decision. A clone
/// shares the one parsed set, and decisions may be taken on any thread; each evaluates afresh, with
/// nothing cached between them.
#[derive(Clone)]
pub struct Authorizer {
    rules: Arc<LoadedRules>,
}

struct LoadedRules {
    schema: Schema,
    policies: PolicySet,
    engine: cedar_policy::Authorizer,
}

const fn assert_send_sync<T: Send + Sync>() {}

// Every session's checks share one authorizer across threads.
const _: () = assert_send_sync::<Authorizer>();

impl Authorizer {
    /// Loads the rules the daemon ships. Fails with a [`RulesLoadError`] when they do not parse or
    /// do not check against their schema, which stops the start.
    pub fn load_built_in() -> Result<Self, RulesLoadError> {
        Self::load(BUILT_IN_SCHEMA, BUILT_IN_RULE_FILES)
    }

    /// Loads `rule_text` in place of the built-in rules, checked against the built-in schema, for
    /// a test that decides by rules the daemon does not ship. Fails as [`Self::load_built_in`]
    /// does.
    #[cfg(any(test, feature = "test-support"))]
    pub fn load_test_rules(rule_text: &str) -> Result<Self, RulesLoadError> {
        Self::load(
            BUILT_IN_SCHEMA,
            &[RuleFile {
                name: "test.cedar",
                text: rule_text,
            }],
        )
    }

    /// Parses `schema_text` and `rule_files`, each file alone so a failure names it, then checks
    /// the rules against the schema strictly. Fails with a [`RulesLoadError`] when the schema does
    /// not parse or warns, a file does not parse, or a rule does not check.
    pub(crate) fn load(
        schema_text: &str,
        rule_files: &[RuleFile<'_>],
    ) -> Result<Self, RulesLoadError> {
        let (schema, warnings) = Schema::from_cedarschema_str(schema_text)
            .map_err(|error| RulesLoadError::SchemaDoesNotParse(Box::new(error)))?;
        let warnings: Vec<SchemaWarning> = warnings.collect();
        if !warnings.is_empty() {
            return Err(RulesLoadError::SchemaHasWarnings { warnings });
        }
        for rule_file in rule_files {
            PolicySet::from_str(rule_file.text).map_err(|error| {
                RulesLoadError::RuleFileDoesNotParse {
                    file_name: rule_file.name.to_owned(),
                    error: Box::new(error),
                }
            })?;
        }
        // One parse of the joined text, so every rule takes its own id.
        let joined_text = rule_files
            .iter()
            .map(|rule_file| rule_file.text)
            .collect::<Vec<_>>()
            .join("\n");
        let policies = PolicySet::from_str(&joined_text)
            .map_err(|error| RulesLoadError::RulesDoNotParse(Box::new(error)))?;
        let validation = Validator::new(schema.clone()).validate(&policies, ValidationMode::Strict);
        let errors: Vec<ValidationError> = validation.validation_errors().cloned().collect();
        if !errors.is_empty() {
            return Err(RulesLoadError::RulesDoNotCheck { errors });
        }
        Ok(Self {
            rules: Arc::new(LoadedRules {
                schema,
                policies,
                engine: cedar_policy::Authorizer::new(),
            }),
        })
    }

    /// Decides `request` against the rules. A request or context the schema refuses is a deny
    /// carrying its error, and so is any rule whose evaluation errors, since the engine skips such
    /// a rule and could otherwise allow past a forbid that failed.
    pub fn decide(&self, request: PolicyRequest<'_>) -> PolicyDecision {
        let engine_request = match self.engine_request(request) {
            Ok(engine_request) => engine_request,
            Err(error) => {
                return PolicyDecision::Deny {
                    errors: vec![error],
                };
            }
        };
        let response = self.rules.engine.is_authorized(
            &engine_request,
            &self.rules.policies,
            &Entities::empty(),
        );
        let errors: Vec<String> = response
            .diagnostics()
            .errors()
            .map(|error| match error {
                AuthorizationError::PolicyEvaluationError(evaluation) => {
                    format!("{}: {}", evaluation.policy_id(), evaluation.inner())
                }
            })
            .collect();
        if !errors.is_empty() {
            return PolicyDecision::Deny { errors };
        }
        match response.decision() {
            Decision::Allow => PolicyDecision::Allow,
            Decision::Deny => PolicyDecision::Deny { errors: Vec::new() },
        }
    }

    // The engine's request, its context typed by the action's schema; an error is its text.
    fn engine_request(&self, request: PolicyRequest<'_>) -> Result<Request, String> {
        let schema = &self.rules.schema;
        let principal = entity("User", request.principal.text().as_str())?;
        let action = entity("Action", request.action)?;
        let resource = entity(request.resource.entity_type, request.resource.id)?;
        let context = Context::from_json_value(request.context, Some((schema, &action)))
            .map_err(|error| error.to_string())?;
        Request::new(principal, action, resource, context, Some(schema))
            .map_err(|error| error.to_string())
    }
}

fn entity(entity_type: &str, id: &str) -> Result<EntityUid, String> {
    let type_name = EntityTypeName::from_str(entity_type).map_err(|error| error.to_string())?;
    Ok(EntityUid::from_type_name_and_id(
        type_name,
        EntityId::new(id),
    ))
}

fn joined(errors: &[impl Display]) -> String {
    errors
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SCHEMA: &str = r#"
        entity User;
        entity Thing;
        action "use" appliesTo { principal: User, resource: Thing, context: { count: Long } };
    "#;

    const PERMIT_USE: RuleFile<'static> = RuleFile {
        name: "use.cedar",
        text: r#"permit (principal is User, action == Action::"use", resource);"#,
    };

    fn user() -> UserId {
        UserId::new("0190c8a0-0000-7000-8000-000000000001").expect("the text is a version 7 UUID")
    }

    #[test]
    fn built_in_rules_load_and_allow_a_start_without_a_posture() {
        let authorizer = Authorizer::load_built_in().expect("the built-in rules load");
        let principal = user();

        let decision = authorizer.decide(PolicyRequest {
            principal: &principal,
            action: "workflow::start",
            resource: PolicyResource {
                entity_type: "Workflow",
                id: "workflow-1",
            },
            context: json!({}),
        });

        assert_eq!(decision, PolicyDecision::Allow);
    }

    #[test]
    fn a_rule_whose_evaluation_errors_denies() {
        // The forbid overflows, and so errors, for any positive count; at -1 it does not apply.
        let forbid_on_overflow = RuleFile {
            name: "forbid.cedar",
            text: "forbid (principal, action, resource) \
                   when { context.count + 9223372036854775807 < 0 };",
        };
        let authorizer =
            Authorizer::load(SCHEMA, &[PERMIT_USE, forbid_on_overflow]).expect("the rules load");
        let principal = user();
        let request = |count: i64| PolicyRequest {
            principal: &principal,
            action: "use",
            resource: PolicyResource {
                entity_type: "Thing",
                id: "open",
            },
            context: json!({ "count": count }),
        };

        assert_eq!(authorizer.decide(request(-1)), PolicyDecision::Allow);
        let PolicyDecision::Deny { errors } = authorizer.decide(request(1)) else {
            unreachable!("an evaluation error is a deny");
        };
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with("policy1: "), "{errors:?}");
    }

    #[test]
    fn a_posture_the_schema_refuses_denies() {
        let authorizer = Authorizer::load_built_in().expect("the built-in rules load");
        let principal = user();

        let decision = authorizer.decide(PolicyRequest {
            principal: &principal,
            action: "workflow::start",
            resource: PolicyResource {
                entity_type: "Workflow",
                id: "workflow-1",
            },
            context: json!({ "posture": { "mode": "ask" } }),
        });

        let PolicyDecision::Deny { errors } = decision else {
            unreachable!("a refused context is a deny");
        };
        assert_ne!(errors, Vec::<String>::new());
    }

    #[test]
    fn a_rule_file_that_does_not_parse_is_named_in_the_load_error() {
        let broken = RuleFile {
            name: "broken.cedar",
            text: "permit (principal action, resource);",
        };

        let error = Authorizer::load(SCHEMA, &[PERMIT_USE, broken])
            .err()
            .expect("a rule file that does not parse fails the load");

        let RulesLoadError::RuleFileDoesNotParse { file_name, .. } = &error else {
            unreachable!("the load fails on the file, not {error:?}");
        };
        assert_eq!(file_name, "broken.cedar");
        assert!(error.to_string().contains("broken.cedar"));
    }
}
