//! The two numbers that name one of a workflow run's snapshots: which execution of the run it
//! belongs to, and which of that execution's approval pauses took it. The execution is a
//! [`SafeInt<0>`](crate::wire::integer::SafeInt), counted from 0 and one more at each re-run.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::{MAX_SAFE_INTEGER, SafeInt};

/// Which approval pause of one execution took a snapshot, counted from 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkflowRunPauseNumber(SafeInt<1>);

impl WorkflowRunPauseNumber {
    /// The pause numbered `number`, or `None` for 0 or a number past the largest exact JavaScript
    /// integer.
    pub const fn new(number: u64) -> Option<Self> {
        match SafeInt::new(number) {
            Some(number) => Some(Self(number)),
            None => None,
        }
    }

    /// The pause's number.
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

impl JsonSchema for WorkflowRunPauseNumber {
    fn schema_name() -> Cow<'static, str> {
        "WorkflowRunPauseNumber".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "Which approval pause of one execution took a snapshot, counted from 1.",
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_SAFE_INTEGER,
        })
    }
}

/// The TypeScript module of the snapshot numbers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/snapshot",
    doc: "The two numbers that name one of a workflow run's snapshots: which execution of the run \
          it belongs to, and which of that execution's approval pauses took it.",
    definitions: &[Definition::read::<WorkflowRunPauseNumber>().checked()],
    constants: &[],
    method_tables: &[],
};
