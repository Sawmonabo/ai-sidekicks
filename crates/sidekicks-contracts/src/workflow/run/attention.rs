//! The runs-needing-you section: the runs waiting on a person and the runs a spent provider account
//! holds, in the order `Next waiting` walks them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::NonEmptyText;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::status::WorkflowWaitCause;
use crate::workflow::run::step::record::WorkflowSpentAccount;

/// What a run waiting on a person waits on: every wait cause but a spent provider account, which
/// nobody can answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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
    rename_all = "camelCase",
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

/// The `workflow.run.attention.list` result: every account line first, then the runs waiting on a
/// person, oldest first, the order `Next waiting` walks them in. `waitingOnPersonCount` counts
/// those runs; an account wait is never in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunAttentionListResponse {
    /// The lines.
    #[garde(dive, custom(|entries: &Vec<WorkflowRunAttentionEntry>, (): &()| {
        lists_accounts_then_oldest_runs(entries)
    }))]
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
fn lists_accounts_then_oldest_runs(entries: &[WorkflowRunAttentionEntry]) -> garde::Result {
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

/// The TypeScript module of the runs-needing-you section.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/attention",
    doc: "The runs-needing-you section: the runs waiting on a person and the runs a spent \
          provider account holds, in the order `Next waiting` walks them.",
    definitions: &[
        Definition::read::<WorkflowPersonWaitCause>(),
        Definition::read::<WorkflowRunAttentionEntry>(),
        Definition::read::<WorkflowRunAttentionListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
