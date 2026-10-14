//! Keeping the runs: deleting one run or the runs older than an instant, marking a run Keep, the
//! runs-needing-you section, the hold on starting new runs, and clearing the values runs keep for
//! later ones.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::True;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::NonEmptyText;
use crate::workflow::definition::document::WorkflowDefinitionId;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::status::WorkflowWaitCause;
use crate::workflow::run::step::record::WorkflowSpentAccount;

/// The `workflow.runDelete` input. Deleting a run removes its record, its steps and its recorded
/// snapshots, and cannot be undone; a run that has not ended is refused: cancel it first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunDeleteRequest {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
}

/// The `workflow.runDelete` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunDeleteResponse {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Always `true`.
    pub deleted: True,
}

/// The `workflow.runsDeletePreview` and `workflow.runsDelete` input: the runs that started before
/// this instant. A run marked Keep, one that has not ended, and a chain's first run while a later
/// run of its chain has not ended are never removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunsDeleteRequest {
    /// The instant.
    #[garde(dive)]
    pub older_than: WireInstant,
}

/// The `workflow.runsDeletePreview` result, read before the confirm: how many runs the delete would
/// remove, and how many older runs it would leave because they are kept or waiting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunsDeletePreviewResponse {
    /// The runs it would remove.
    pub delete_count: SafeInt<0>,
    /// The older runs it would leave because they are marked Keep.
    pub kept_count: SafeInt<0>,
    /// The older runs it would leave because they are waiting.
    pub waiting_count: SafeInt<0>,
}

/// The `workflow.runsDelete` result. Runs may start or end between the preview and the delete, so
/// this count, not the preview's, is what was removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunsDeleteResponse {
    /// The runs removed.
    pub deleted_count: SafeInt<0>,
}

/// The `workflow.runKeepSet` input and result alike: whether the run is marked Keep, which deleting
/// old runs leaves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunKeepSet {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Whether it is marked Keep.
    pub keep: bool,
}

/// What a run waiting on a person waits on: every wait cause but a spent provider account, which
/// nobody can answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPersonWaitCause {
    /// A person's approval.
    Approval,
    /// A person's form.
    Form,
    /// A person's chat reply.
    Reply,
    /// The chain's question.
    Chain,
}

impl From<WorkflowPersonWaitCause> for WorkflowWaitCause {
    fn from(cause: WorkflowPersonWaitCause) -> Self {
        match cause {
            WorkflowPersonWaitCause::Approval => Self::Approval,
            WorkflowPersonWaitCause::Form => Self::Form,
            WorkflowPersonWaitCause::Reply => Self::Reply,
            WorkflowPersonWaitCause::Chain => Self::Chain,
        }
    }
}

/// One line of the runs-needing-you section. A run waiting on a person is its own line; the runs
/// held by one spent provider account fold into one line keyed by that account, since nobody can
/// answer them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum WorkflowRunAttentionEntry {
    /// A run waiting on a person.
    Run {
        /// The run.
        workflow_run_id: WorkflowRunId,
        /// Its workflow's name.
        workflow_name: NonEmptyText,
        /// What it waits on.
        wait_cause: WorkflowPersonWaitCause,
        /// The name of the step that waits.
        waiting_step_name: NonEmptyText,
        /// Since when it waits.
        #[garde(dive)]
        waiting_since: WireInstant,
    },
    /// The runs one spent provider account holds.
    Account {
        /// The account, named as the steps waiting on it name it.
        account: WorkflowSpentAccount,
        /// How many runs it holds.
        affected_run_count: SafeInt<1>,
        /// Since when the oldest of them waits.
        #[garde(dive)]
        waiting_since: WireInstant,
        /// When the wait resumes itself, where one is armed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        resume_at: Option<WireInstant>,
    },
}

/// The `workflow.runAttentionList` result: every account line first, then the runs waiting on a
/// person, oldest first, the order `Next waiting` walks them in. `waitingOnPersonCount` counts
/// those runs; an account wait is never in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunAttentionListResponse {
    /// The lines.
    #[garde(dive, custom(lists_accounts_then_oldest_runs))]
    pub entries: Vec<WorkflowRunAttentionEntry>,
    /// How many runs wait on a person.
    #[garde(custom(|count: &SafeInt<0>, (): &()| {
        let run_lines = self.entries.iter().filter(|entry| {
            matches!(entry, WorkflowRunAttentionEntry::Run { .. })
        });
        if u64::try_from(run_lines.count()).is_ok_and(|lines| lines == count.get()) {
            Ok(())
        } else {
            Err(garde::Error::new("the count is of the runs waiting on a person"))
        }
    }))]
    pub waiting_on_person_count: SafeInt<0>,
}

/// Refuses an account line below a run line, and a run line that waits since before the one above
/// it.
fn lists_accounts_then_oldest_runs(
    entries: &[WorkflowRunAttentionEntry],
    (): &(),
) -> garde::Result {
    let mut last_run_waiting_since: Option<i64> = None;
    for entry in entries {
        match entry {
            WorkflowRunAttentionEntry::Account { .. } => {
                if last_run_waiting_since.is_some() {
                    return Err(garde::Error::new(
                        "the account lines stand above the runs waiting on a person",
                    ));
                }
            }
            WorkflowRunAttentionEntry::Run { waiting_since, .. } => {
                let Some(since) = waiting_since.unix_millisecond() else {
                    return Err(garde::Error::new(
                        "a run line's waiting-since is an instant",
                    ));
                };
                if last_run_waiting_since.is_some_and(|last| since < last) {
                    return Err(garde::Error::new(
                        "the runs waiting on a person stand oldest first",
                    ));
                }
                last_run_waiting_since = Some(since);
            }
        }
    }
    Ok(())
}

/// The `workflow.runsPauseSet` input: the hold on starting new runs, one per daemon over its whole
/// scheduler. A run already going finishes; every new start waits until the hold is off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunsPauseSetRequest {
    /// Whether the hold is on.
    pub paused: bool,
}

/// The hold and how many starts wait behind it, as the `workflow.runsPauseSet` reply and the
/// `workflow.subscribe` stream carry it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunsPauseState {
    /// Whether the hold is on.
    pub paused: bool,
    /// How many starts wait behind it.
    pub waiting_start_count: SafeInt<0>,
}

/// The `workflow.keptVarsClear` input: clear every value `Keep for later runs` kept for one
/// workflow. Kept values belong to the workflow, not to a version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowKeptVarsClearRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
}

/// The `workflow.keptVarsClear` result: how many kept values went.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowKeptVarsClearResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// How many kept values were cleared.
    pub cleared_count: SafeInt<0>,
}

/// The TypeScript module of keeping the runs.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/housekeeping",
    doc: "Keeping the runs: deleting one run or the runs older than an instant, marking a run \
          Keep, the runs-needing-you section, the hold on starting new runs, and clearing the \
          values runs keep for later ones.",
    definitions: &[
        Definition::read::<WorkflowRunDeleteRequest>().checked(),
        Definition::read::<WorkflowRunDeleteResponse>().checked(),
        Definition::read::<WorkflowRunsDeleteRequest>().checked(),
        Definition::read::<WorkflowRunsDeletePreviewResponse>().checked(),
        Definition::read::<WorkflowRunsDeleteResponse>().checked(),
        Definition::read::<WorkflowRunKeepSet>().checked(),
        Definition::read::<WorkflowPersonWaitCause>(),
        Definition::read::<WorkflowRunAttentionEntry>(),
        Definition::read::<WorkflowRunAttentionListResponse>().checked(),
        Definition::read::<WorkflowRunsPauseSetRequest>().checked(),
        Definition::read::<WorkflowRunsPauseState>().checked(),
        Definition::read::<WorkflowKeptVarsClearRequest>().checked(),
        Definition::read::<WorkflowKeptVarsClearResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
