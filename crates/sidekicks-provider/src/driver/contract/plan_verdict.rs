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
/// `Implement the plan.`. Fails as the mode's move fails while the process still reads up; a move
/// that failed because the process went down meanwhile needs nothing.
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
                    let moved = driver
                        .update_session_mode(UpdateSessionModeParams {
                            session_id: params.session_id,
                            mode: SessionMode::Build,
                            is_provider_reported: false,
                        })
                        .await;
                    // The state was read outside the driver's lock, so a process that went down
                    // since opens in the mode the daemon stores, as one down at the read does.
                    if let Err(error) = moved
                        && driver.session_process_state(&params.session_id)
                            != SessionProcessState::Down
                    {
                        return Err(error);
                    }
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::FutureExt as _;
    use rstest::rstest;
    use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

    use super::{
        AnswerPlanParams, IMPLEMENT_THE_PLAN, PlanVerdict, PlanVerdictAnswer,
        answer_plan_holding_no_request,
    };
    use crate::driver::contract::MockProviderDriver;
    use crate::driver::contract::error::DriverError;
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

    // A build whose move fails answers as a process down once the process reads down after the
    // failure, and fails while it still reads up. Killed by the state not read again after a
    // failed move (the first case fails) and by every failed move taken as down (the second case
    // answers).
    #[rstest]
    #[case::went_down(SessionProcessState::Down, true)]
    #[case::still_live(SessionProcessState::Live, false)]
    #[tokio::test]
    async fn a_build_whose_move_fails_answers_only_once_the_process_reads_down(
        #[case] state_after: SessionProcessState,
        #[case] is_answered: bool,
    ) {
        let session_id = new_session_id();
        let reads = AtomicUsize::new(0);
        let mut driver = MockProviderDriver::new();
        driver
            .expect_session_process_state()
            .times(2)
            .returning(move |_session_id| {
                if reads.fetch_add(1, Ordering::Relaxed) == 0 {
                    SessionProcessState::Live
                } else {
                    state_after
                }
            });
        driver
            .expect_update_session_mode()
            .times(1)
            .returning(|_params| {
                async { Err(DriverError::Internal("the process went away".into())) }.boxed()
            });

        let answer = answer_plan_holding_no_request(
            &driver,
            AnswerPlanParams {
                session_id,
                plan_id: mint_plan_id(),
                holds_request: false,
                verdict: PlanVerdict::Build {
                    level: PermissionLevel::Ask,
                },
            },
        )
        .await;

        assert_eq!(
            answer.ok(),
            is_answered.then(|| PlanVerdictAnswer::Answered {
                follow_up_message: Some(IMPLEMENT_THE_PLAN.to_owned()),
            })
        );
    }
}
