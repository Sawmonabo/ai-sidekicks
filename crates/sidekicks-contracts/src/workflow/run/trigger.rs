//! How a workflow run was started and by whom: the run mode, the trigger node's kind, and the
//! person, device, message or parent run that started it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::agent::definition::AgentId;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::workflow::run::id::WorkflowRunId;

ts_constants! {
    /// Every way a run is started.
    WORKFLOW_RUN_MODES = WorkflowRunMode::VARIANTS;
    /// Every trigger kind a run can be started by, in the order the runs table's filter lists
    /// them.
    WORKFLOW_TRIGGER_KINDS = WorkflowTriggerKind::VARIANTS;
}

/// How a run was started, which is a different question from who started it.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum WorkflowRunMode {
    /// From Run now.
    Manual,
    /// By a trigger firing.
    Trigger,
    /// By a webhook call.
    Webhook,
    /// From a chat.
    Chat,
    /// By an agent.
    Agent,
    /// As a retry of another run.
    Retry,
    /// By another workflow's Execute workflow step.
    SubWorkflow,
}

/// The kind of trigger node that started a run, which the runs table's trigger column and filter
/// read. A retry keeps its source run's kind; a mode cannot carry this, because `trigger` covers a
/// schedule, a file event, a session event and another workflow failing alike.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
pub enum WorkflowTriggerKind {
    /// Run manually.
    #[serde(rename = "trigger.manual")]
    Manual,
    /// On a schedule.
    #[serde(rename = "trigger.schedule")]
    Schedule,
    /// On a file change.
    #[serde(rename = "trigger.file-watch")]
    FileWatch,
    /// On a webhook.
    #[serde(rename = "trigger.webhook")]
    Webhook,
    /// On a session event.
    #[serde(rename = "trigger.session-event")]
    SessionEvent,
    /// From chat.
    #[serde(rename = "trigger.chat")]
    Chat,
    /// Called by a workflow.
    #[serde(rename = "trigger.sub-workflow")]
    SubWorkflow,
    /// When a workflow fails.
    #[serde(rename = "trigger.error")]
    Error,
}

/// Who or what started a run, as its row and its header name it. A person's start records the
/// device of the connection that made it, never a person; a chat start carries the message it came
/// from, so the run links back to that message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowStartedBy {
    /// A person, by the device of the connection that started the run.
    User {
        /// The device.
        device_id: DeviceId,
    },
    /// A schedule.
    Schedule {},
    /// A chat message.
    Chat {
        /// The session the message is in.
        session_id: SessionId,
        /// The message's place in the session's log.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "EventCursor")]
        message_anchor_cursor: Option<EventCursor>,
    },
    /// An agent.
    Agent {
        /// The agent.
        agent_id: AgentId,
    },
    /// A webhook call.
    Webhook {},
    /// A file event.
    FileEvent {},
    /// Another workflow's run.
    ParentWorkflow {
        /// The parent run.
        parent_workflow_run_id: WorkflowRunId,
    },
}

/// The TypeScript module of a run's start.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/trigger",
    doc: "How a workflow run was started and by whom: the run mode, the trigger node's kind, and \
          the person, device, message or parent run that started it.",
    definitions: &[
        Definition::read::<WorkflowRunMode>().checked(),
        Definition::read::<WorkflowTriggerKind>().checked(),
        Definition::read::<WorkflowStartedBy>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
