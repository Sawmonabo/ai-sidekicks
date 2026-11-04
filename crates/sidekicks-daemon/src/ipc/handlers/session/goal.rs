//! `session.goal.update` and `session.goal.clear`, which set or clear the goal of a session's
//! lead agent through its provider.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::goal::{
    SessionGoalClear, SessionGoalClearRequest, SessionGoalUpdate, SessionGoalUpdateRequest,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

use crate::orchestration::goal_service::SessionGoals;

/// Registers `session.goal.update` and `session.goal.clear` over `goals`, which refuses as its
/// doc names. Fails the start when a method is already registered.
pub(crate) fn register_session_goal_methods(
    registry: &mut MethodRegistryBuilder,
    goals: Arc<SessionGoals>,
) -> Result<(), RegistrationError> {
    let updating = Arc::clone(&goals);
    registry.register::<SessionGoalUpdate, _>(
        move |request: SessionGoalUpdateRequest, _context: HandlerContext| {
            let goals = Arc::clone(&updating);
            async move { Ok(goals.update(request).await?) }.boxed()
        },
    )?;
    registry.register::<SessionGoalClear, _>(
        move |request: SessionGoalClearRequest, _context: HandlerContext| {
            let goals = Arc::clone(&goals);
            async move { Ok(goals.clear(request).await?) }.boxed()
        },
    )
}
