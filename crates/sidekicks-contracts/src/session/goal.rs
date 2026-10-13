//! A goal inside a session: the condition one agent works toward until it is met, cleared or
//! stopped unmet, set with `session.goalUpdate` and removed with `session.goalClear`, and the two
//! events that record each change. A goal is a command used inside a session, never what the
//! session is. The transcript draws every goal row from the two events; there is no goal store.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::method::methods;
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::session::controls::methods::SessionAcknowledgement;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::FreeFormText;

/// A goal's condition, as the person wrote it. `text` has no length cap of the app's own; it is
/// not blank and free of NUL, checked as written and never trimmed. Clearing is its own operation,
/// so an update with empty text is refused rather than read as a clear.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGoal {
    /// The condition.
    pub text: FreeFormText<{ usize::MAX }>,
}

/// Where a goal stands. `complete` and `impossible` are final; a goal's last status is what its row
/// draws. Only Claude Code sends `impossible`, carrying the judge's reason. Clearing is the event
/// `session.goal_cleared`, never a status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SessionGoalStatus {
    /// The agent works toward it.
    Active,
    /// Work on it is paused.
    Paused,
    /// Work on it is blocked.
    Blocked,
    /// A usage limit stopped work on it.
    UsageLimited,
    /// A budget stopped work on it.
    BudgetLimited,
    /// It is met.
    Complete,
    /// The judge found it cannot be met.
    Impossible,
}

/// Sets or replaces the goal of one agent in the session. The last write wins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionGoalUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The agent.
    pub agent_id: AgentId,
    /// The goal.
    pub goal: SessionGoal,
}

/// The accepted goal, echoed exactly as the `session.goal_updated` event carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGoalUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// The goal.
    pub goal: SessionGoal,
}

/// Removes one agent's goal. With no goal set it succeeds, as Codex's own clear does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionGoalClearRequest {
    /// The session.
    pub session_id: SessionId,
    /// The agent.
    pub agent_id: AgentId,
}

/// The `session.goal_updated` payload: the goal and where it now stands. `reason` is the provider's
/// judge's reason, present exactly when the status is `impossible`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend(
    "if" = { "properties": { "status": { "const": "impossible" } }, "required": ["status"] },
    "then" = { "required": ["reason"] },
    "else" = { "not": { "required": ["reason"] } },
))]
pub struct SessionGoalUpdatedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The agent.
    pub agent_id: AgentId,
    /// The goal.
    pub goal: SessionGoal,
    /// Where it now stands.
    pub status: SessionGoalStatus,
    /// The judge's reason, present exactly when the status is `impossible`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
    #[garde(custom(|reason: &Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>, (): &()| {
        if reason.is_some() == (self.status == SessionGoalStatus::Impossible) {
            Ok(())
        } else {
            Err(garde::Error::new("a goal carries a reason exactly when its status is impossible"))
        }
    }))]
    pub reason: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
}

/// The `session.goal_cleared` payload: whose goal was removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGoalClearedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The agent.
    pub agent_id: AgentId,
}

methods! {
    /// The goal methods' wire contract: name, procedure type and types.
    pub const SESSION_GOAL_METHOD_DESCRIPTORS = [
        /// Sets or replaces one agent's goal.
        SessionGoalUpdate = mutation "session.goalUpdate" {
            mutating: true,
            params: SessionGoalUpdateRequest,
            result: SessionGoalUpdateResponse,
            refusals: [SessionNotFound, DriverCapabilityUnsupported],
        },
        /// Removes one agent's goal.
        SessionGoalClear = mutation "session.goalClear" {
            mutating: true,
            params: SessionGoalClearRequest,
            result: SessionAcknowledgement,
            refusals: [SessionNotFound, DriverCapabilityUnsupported],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/goal",
    doc: "A goal inside a session: the condition one agent works toward, the two methods that set \
          and clear it, and the two events that record each change.",
    definitions: &[
        Definition::read::<SessionGoal>().checked(),
        Definition::read::<SessionGoalStatus>().checked(),
        Definition::read::<SessionGoalUpdateRequest>().checked(),
        Definition::read::<SessionGoalUpdateResponse>().checked(),
        Definition::read::<SessionGoalClearRequest>().checked(),
        Definition::read::<SessionGoalUpdatedPayload>().checked(),
        Definition::read::<SessionGoalClearedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_GOAL_METHOD_DESCRIPTORS],
};
