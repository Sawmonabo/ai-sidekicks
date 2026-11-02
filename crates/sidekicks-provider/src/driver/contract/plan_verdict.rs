//! The person's verdict on a plan as the daemon hands it to the driver, the driver's answer, and
//! the answer every provider gives a plan that holds no request open.

use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;

use crate::driver::contract::ProviderDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::SessionProcessState;
use crate::driver::session_control::UpdateSessionModeParams;

// The message that starts the build of a plan that held no request open.
const IMPLEMENT_THE_PLAN: &str = "Implement the plan.";

/// The person's verdict on a plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanVerdict {
    /// Keep planning.
    Keep {},
    /// Build the plan in this session at `level`.
    Build {
        /// The level the session builds at.
        level: PermissionLevel,
    },
    /// Build the plan in a fresh session, which the daemon starts.
    HandOff {},
}

/// Params of `answer_plan`: the plan, whether its record says it holds a request open, and the
/// person's verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnswerPlanParams {
    /// The session the plan was proposed in.
    pub session_id: SessionId,
    /// The plan.
    pub plan_id: PlanId,
    /// Whether the plan's record says the provider holds a request open for its verdict.
    pub holds_request: bool,
    /// The person's verdict.
    pub verdict: PlanVerdict,
}

/// What answering a verdict did: the driver answered it, or the plan holds no request any more.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanVerdictAnswer {
    /// The driver answered the verdict; the daemon sends `follow_up_message` as the session's next
    /// message when there is one.
    Answered {
        /// The message that carries the verdict out, if the provider needs one.
        follow_up_message: Option<String>,
    },
    /// The request the plan held was already answered or withdrawn.
    NotHeld {},
}

/// Answers a verdict on a plan that holds no request open, on any provider: keep and hand-off
/// send nothing; build moves a live or restarting process to Build through the driver's own
/// `update_session_mode`, nothing for a process that is down, and answers the follow-up
/// `Implement the plan.`. Fails as the mode's move fails.
pub(crate) async fn answer_plan_holding_no_request<D: ProviderDriver + ?Sized>(
    driver: &D,
    params: AnswerPlanParams,
) -> Result<PlanVerdictAnswer, DriverError> {
    let follow_up_message = match params.verdict {
        PlanVerdict::Keep {} | PlanVerdict::HandOff {} => None,
        PlanVerdict::Build { .. } => {
            match driver.session_process_state(&params.session_id) {
                // A move while the process comes back reaches the process the driver brings back.
                SessionProcessState::Live | SessionProcessState::Restarting => {
                    driver
                        .update_session_mode(UpdateSessionModeParams {
                            session_id: params.session_id,
                            mode: SessionMode::Build,
                            is_provider_reported: false,
                        })
                        .await?;
                }
                // A process that is down opens in the mode the daemon stores.
                SessionProcessState::Down => {}
            }
            Some(IMPLEMENT_THE_PLAN.to_owned())
        }
    };
    Ok(PlanVerdictAnswer::Answered { follow_up_message })
}

#[cfg(test)]
mod tests {
    use futures::FutureExt as _;
    use rstest::rstest;
    use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

    use super::{
        AnswerPlanParams, IMPLEMENT_THE_PLAN, PlanVerdict, PlanVerdictAnswer,
        answer_plan_holding_no_request,
    };
    use crate::driver::contract::MockProviderDriver;
    use crate::driver::contract::params_and_results::SessionProcessState;
    use crate::driver::test_registry::new_session_id;
    use crate::port::plan::mint_plan_id;

    // A plan holding no request moves the session to Build only for a build on a process that
    // runs or comes back, as a move the daemon asked for, and answers the follow-up only for a
    // build. Killed by a move at Down, a move for keep or hand-off, the follow-up missing, and the
    // move marked as the provider's own.
    #[rstest]
    #[tokio::test]
    async fn a_plan_holding_no_request_moves_to_build_only_for_a_build_on_a_running_process(
        #[values(
            SessionProcessState::Live,
            SessionProcessState::Restarting,
            SessionProcessState::Down
        )]
        state: SessionProcessState,
        #[values(
            PlanVerdict::Keep {},
            PlanVerdict::Build { level: PermissionLevel::Ask },
            PlanVerdict::HandOff {}
        )]
        verdict: PlanVerdict,
    ) {
        let session_id = new_session_id();
        let is_build = matches!(verdict, PlanVerdict::Build { .. });
        let is_running = matches!(
            state,
            SessionProcessState::Live | SessionProcessState::Restarting
        );
        let mut driver = MockProviderDriver::new();
        driver.expect_session_process_state().return_const(state);
        driver
            .expect_update_session_mode()
            .withf(move |params| {
                params.session_id == session_id
                    && params.mode == SessionMode::Build
                    && !params.is_provider_reported
            })
            .times(usize::from(is_build && is_running))
            .returning(|_params| async { Ok(()) }.boxed());

        let answer = answer_plan_holding_no_request(
            &driver,
            AnswerPlanParams {
                session_id,
                plan_id: mint_plan_id(),
                holds_request: false,
                verdict,
            },
        )
        .await
        .expect("the verdict is answered");

        assert_eq!(
            answer,
            PlanVerdictAnswer::Answered {
                follow_up_message: is_build.then(|| IMPLEMENT_THE_PLAN.to_owned()),
            }
        );
    }
}
