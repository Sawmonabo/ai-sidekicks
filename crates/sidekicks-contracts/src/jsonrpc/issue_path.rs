//! Where a refused message's fault sits: the path of a refusal issue, from the message's root down
//! to the member, written in the wire's names.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;

/// One step of an issue's path: a member's name as the message spells it, or an array's index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum IssuePathSegment {
    /// A member's name, as sent.
    Member(String),
    /// An array element's index.
    Index(SafeInt<0>),
}

/// The TypeScript module of the issue path.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/issue-path",
    doc: "Where a refused message's fault sits: each step of an issue's path, a member's name or \
          an array's index.",
    definitions: &[Definition::read::<IssuePathSegment>()],
    constants: &[],
    method_tables: &[],
};
