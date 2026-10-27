//! Whether a workflow run that an agent or a trigger asks for may start. The person's own starts,
//! from any of their devices, pass no policy check and never come here.

use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_policy::authorizer::{Authorizer, PolicyDecision, PolicyRequest, PolicyResource};

/// One start to check: the machine's owning user as the daemon resolved it, the workflow, and the
/// asking run's posture, which a trigger's start has none of.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WorkflowStart<'a> {
    /// The machine's owning user; `None` when it did not resolve.
    pub(crate) owner: Option<&'a UserId>,
    /// The workflow the run starts.
    pub(crate) workflow_id: &'a WorkflowDefinitionId,
    /// The asking run's posture, which the rules read.
    pub(crate) posture: Option<&'a ExecutionPosture>,
}

/// Decides whether a start an agent made through its workflow tools, or a run a trigger fired, may
/// begin under the `workflow::start` rules. Each start is evaluated afresh, so a rule changed after
/// a trigger was armed still stops its next run; a start whose owner did not resolve is denied
/// without evaluation, and a posture that does not convert to the rules' context is a deny.
pub(crate) fn check_workflow_start(
    authorizer: &Authorizer,
    start: WorkflowStart<'_>,
) -> PolicyDecision {
    let Some(owner) = start.owner else {
        return PolicyDecision::Deny {
            errors: vec!["the machine's owning user did not resolve".to_owned()],
        };
    };
    // The posture's wire form is the rules' `Posture` type.
    let context = match start.posture.map(serde_json::to_value).transpose() {
        Ok(Some(posture)) => Value::Object(Map::from_iter([("posture".to_owned(), posture)])),
        Ok(None) => Value::Object(Map::new()),
        Err(error) => {
            return PolicyDecision::Deny {
                errors: vec![error.to_string()],
            };
        }
    };
    authorizer.decide(PolicyRequest {
        principal: owner,
        action: "workflow::start",
        resource: PolicyResource {
            entity_type: "Workflow",
            id: start.workflow_id.text().as_str(),
        },
        context,
    })
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::provider::driver::capabilities::CredentialPolicyRef;
    use sidekicks_provider::run::posture::CURATED_CREDENTIAL_POLICY_REF;

    use super::*;

    fn workflow_id() -> WorkflowDefinitionId {
        WorkflowDefinitionId::new("0190c8a0-0000-7000-8000-000000000002")
            .expect("the text is a version 7 UUID")
    }

    #[test]
    fn the_owner_may_start_with_or_without_a_posture() {
        let authorizer = Authorizer::load_built_in().expect("the built-in rules load");
        let owner = UserId::new("0190c8a0-0000-7000-8000-000000000001")
            .expect("the text is a version 7 UUID");
        let workflow_id = workflow_id();
        let ask = ExecutionPosture::Ask {
            credential_policy_ref: CredentialPolicyRef::new(
                CURATED_CREDENTIAL_POLICY_REF.to_owned(),
            )
            .expect("a short name is a valid reference"),
            writable_roots: Vec::new(),
        };

        for posture in [None, Some(&ask)] {
            let start = WorkflowStart {
                owner: Some(&owner),
                workflow_id: &workflow_id,
                posture,
            };
            assert_eq!(
                check_workflow_start(&authorizer, start),
                PolicyDecision::Allow
            );
        }
    }

    #[test]
    fn a_start_whose_owner_did_not_resolve_is_denied_unevaluated() {
        // The built-in rules allow every start, so the deny comes before them.
        let authorizer = Authorizer::load_built_in().expect("the built-in rules load");
        let workflow_id = workflow_id();

        let decision = check_workflow_start(
            &authorizer,
            WorkflowStart {
                owner: None,
                workflow_id: &workflow_id,
                posture: None,
            },
        );

        assert_eq!(
            decision,
            PolicyDecision::Deny {
                errors: vec!["the machine's owning user did not resolve".to_owned()],
            }
        );
    }
}
