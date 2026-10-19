//! Routes a normalized intervention onto Codex's native operation: a steer, the delivery of a
//! message the run queue held, onto `turn/steer` with its picked skills and staged files, and an
//! interrupt onto `turn/interrupt`.
//!
//! The steer's idempotency key rides the wire unchanged as `clientUserMessageId`; `turn/interrupt`
//! has no such field, and a minted key would defeat the queue's dedupe on retry. `turn/steer`
//! answers `{ turnId }`, so `applied` needs the targeted turn back; `turn/interrupt` answers an
//! empty object, so the absence of an error is its only evidence. No shape check is made: the
//! wire is additive, and a new member must not degrade every interrupt.

use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};

use crate::provider::driver::contract::DriverError;
use crate::provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterruptRunRequest,
    InterventionResultStatus, PickedSkill,
};

/// One steer, as handed to the runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexSteerRunRequest {
    /// The run the message goes to.
    pub(crate) run_id: RunId,
    /// The message's words.
    pub(crate) content: MessageContent,
    /// The skills picked for the message, in the order picked.
    pub(crate) skills: Vec<PickedSkill>,
    /// The message's staged files, in staging order.
    pub(crate) attachments: Vec<ArtifactId>,
    /// Pins the steer to a turn; `None` means the live turn, reported back as `targeted_turn_id`.
    pub(crate) expected_turn_id: Option<String>,
    /// The message's own id, placed on the wire unchanged.
    pub(crate) client_idempotency_key: QueueItemId,
}

/// What `turn/steer` acknowledged; both turn ids travel so a different turn can be told apart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexSteerAcknowledgment {
    /// The turn the runtime put on the wire as `expectedTurnId`.
    pub(crate) targeted_turn_id: String,
    /// The turn the provider's answer named, or `None` when it named none.
    pub(crate) acknowledged_turn_id: Option<String>,
}

/// The provider operations the dispatcher routes onto. Each fails with the driver's error on a
/// transport, run-state or file-binding failure.
pub(crate) trait CodexInterventionRuntime: Send + Sync {
    /// Sends one steer into the running turn and answers what Codex acknowledged.
    fn steer_run(
        &self,
        request: CodexSteerRunRequest,
    ) -> BoxFuture<'_, Result<CodexSteerAcknowledgment, DriverError>>;

    /// Interrupts one run's turn.
    fn interrupt_run(&self, params: InterruptRunRequest) -> BoxFuture<'_, Result<(), DriverError>>;
}

/// Routes normalized interventions onto Codex's native operations.
pub(crate) struct CodexInterventionDispatcher {
    runtime: Arc<dyn CodexInterventionRuntime>,
}

impl CodexInterventionDispatcher {
    /// A dispatcher over `runtime`.
    pub(crate) fn new(runtime: Arc<dyn CodexInterventionRuntime>) -> Self {
        Self { runtime }
    }

    /// Routes one intervention onto its native operation and answers `applied`, or `degraded` for
    /// a steer Codex acknowledged on another turn or none. A transport, run-state or file-binding
    /// failure returns the runtime's error.
    pub(crate) async fn apply_intervention(
        &self,
        params: ApplyInterventionParams,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        let status = match params {
            ApplyInterventionParams::Steer {
                target_run_id,
                client_idempotency_key,
                payload,
                expected_run_version: _,
            } => {
                let acknowledgment = self
                    .runtime
                    .steer_run(CodexSteerRunRequest {
                        run_id: target_run_id,
                        content: payload.content,
                        skills: payload.skills,
                        attachments: payload.attachments,
                        expected_turn_id: payload.expected_turn_id,
                        client_idempotency_key,
                    })
                    .await?;
                // Another turn or none degrades: neither shows the targeted turn was steered.
                if acknowledgment.acknowledged_turn_id.as_ref()
                    == Some(&acknowledgment.targeted_turn_id)
                {
                    InterventionResultStatus::Applied
                } else {
                    InterventionResultStatus::Degraded
                }
            }
            ApplyInterventionParams::Interrupt {
                target_run_id,
                payload,
                expected_run_version: _,
                client_idempotency_key: _,
            } => {
                self.runtime
                    .interrupt_run(InterruptRunRequest {
                        run_id: target_run_id,
                        reason: payload.reason,
                    })
                    .await?;
                InterventionResultStatus::Applied
            }
        };
        Ok(ApplyInterventionResponse {
            status,
            fallback_action: None,
            delivered_run_id: None,
            cancelled: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::future::BoxFuture;
    use rstest::rstest;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::{
        CodexInterventionDispatcher, CodexInterventionRuntime, CodexSteerAcknowledgment,
        CodexSteerRunRequest,
    };
    use crate::provider::driver::contract::DriverError;
    use crate::provider::driver::run_control::{
        ApplyInterventionParams, InterruptRunRequest, InterventionResultStatus, SteerPayload,
    };

    /// A runtime whose steer is acknowledged on `acknowledged_turn_id` after targeting `turn-1`.
    struct AcknowledgingRuntime {
        acknowledged_turn_id: Option<&'static str>,
    }

    impl CodexInterventionRuntime for AcknowledgingRuntime {
        fn steer_run(
            &self,
            _request: CodexSteerRunRequest,
        ) -> BoxFuture<'_, Result<CodexSteerAcknowledgment, DriverError>> {
            let acknowledged_turn_id = self.acknowledged_turn_id.map(str::to_owned);
            Box::pin(async move {
                Ok(CodexSteerAcknowledgment {
                    targeted_turn_id: "turn-1".to_owned(),
                    acknowledged_turn_id,
                })
            })
        }

        fn interrupt_run(
            &self,
            _params: InterruptRunRequest,
        ) -> BoxFuture<'_, Result<(), DriverError>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[rstest]
    #[case::the_targeted_turn(Some("turn-1"), InterventionResultStatus::Applied)]
    #[case::another_turn(Some("turn-2"), InterventionResultStatus::Degraded)]
    #[case::no_turn(None, InterventionResultStatus::Degraded)]
    #[tokio::test]
    async fn a_steer_applies_only_when_codex_acknowledges_the_targeted_turn(
        #[case] acknowledged_turn_id: Option<&'static str>,
        #[case] expected: InterventionResultStatus,
    ) {
        let dispatcher = CodexInterventionDispatcher::new(Arc::new(AcknowledgingRuntime {
            acknowledged_turn_id,
        }));
        let params = ApplyInterventionParams::Steer {
            target_run_id: RunId::new("0192f0c8-7a3e-7b4c-9d2e-3f4a5b6c7d8e").unwrap(),
            expected_run_version: SafeInt::new(0).unwrap(),
            client_idempotency_key: QueueItemId::new("0192f0c8-7a3e-7b4c-9d2e-3f4a5b6c7d8f")
                .unwrap(),
            payload: SteerPayload {
                content: MessageContent::new("also check the tests".to_owned()).unwrap(),
                attachments: Vec::new(),
                skills: Vec::new(),
                expected_turn_id: None,
            },
        };

        let result = dispatcher.apply_intervention(params).await.unwrap();

        assert_eq!(result.status, expected);
    }
}
