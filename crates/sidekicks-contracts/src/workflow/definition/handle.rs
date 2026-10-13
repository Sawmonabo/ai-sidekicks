//! The handle grammar: an edge names each end by one string, `<mode>/<type>/<index>`, such as
//! `outputs/main/1` or `inputs/tool/0`, so the side, the connection type and the branch index are
//! recoverable from a stored edge alone. The read is tolerant so a document always opens; whether
//! the string named a declared type is kept, so the daemon's check at save can refuse it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;

/// The side of a node a handle stands on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowHandleMode {
    /// Where edges come in.
    Inputs,
    /// Where edges go out.
    Outputs,
}

/// What a handle carries: items on `main`, a capability an agent can call on `tool`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowHandleType {
    /// Items.
    Main,
    /// A capability an agent can call.
    Tool,
}

/// A handle id as read. `isTypeKnown` is false when the stored string named a type other than
/// `main` or `tool`, read as `main`, or could not be read at all, read as `outputs/main/0`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowHandle {
    /// The side.
    pub mode: WorkflowHandleMode,
    /// The connection type.
    #[serde(rename = "type")]
    pub handle_type: WorkflowHandleType,
    /// The branch index.
    pub index: SafeInt<0>,
    /// Whether the stored string named a declared type.
    pub is_type_known: bool,
}

/// What a string that is not a handle id reads as: the first `main` output, its type unknown.
const FALLBACK_HANDLE: WorkflowHandle = WorkflowHandle {
    mode: WorkflowHandleMode::Outputs,
    handle_type: WorkflowHandleType::Main,
    index: SafeInt::<0>::new(0).expect("0 is a whole number"),
    is_type_known: false,
};

/// Reads a handle id and never fails. A well-formed id (`inputs` or `outputs`, a non-empty type
/// with no `/`, and a whole number from 0 to 2^53 − 1 with no leading zero) whose type is neither
/// `main` nor `tool` reads as `main` on its own mode and index; anything else reads as the first
/// `main` output.
pub fn parse_workflow_handle(id: &str) -> WorkflowHandle {
    let Some((mode, rest)) = id
        .strip_prefix("inputs/")
        .map(|rest| (WorkflowHandleMode::Inputs, rest))
        .or_else(|| {
            id.strip_prefix("outputs/")
                .map(|rest| (WorkflowHandleMode::Outputs, rest))
        })
    else {
        return FALLBACK_HANDLE;
    };
    let Some((type_text, index_text)) = rest.split_once('/') else {
        return FALLBACK_HANDLE;
    };
    let Some(index) = canonical_index_of(index_text) else {
        return FALLBACK_HANDLE;
    };
    if type_text.is_empty() {
        return FALLBACK_HANDLE;
    }
    let (handle_type, is_type_known) = match type_text {
        "main" => (WorkflowHandleType::Main, true),
        "tool" => (WorkflowHandleType::Tool, true),
        _ => (WorkflowHandleType::Main, false),
    };
    WorkflowHandle {
        mode,
        handle_type,
        index,
        is_type_known,
    }
}

/// The index `text` writes when it is `0` or ASCII digits with no leading zero, up to 2^53 − 1.
fn canonical_index_of(text: &str) -> Option<SafeInt<0>> {
    let is_canonical = text == "0"
        || (text.starts_with(|first: char| ('1'..='9').contains(&first))
            && text.bytes().all(|digit| digit.is_ascii_digit()));
    if !is_canonical {
        return None;
    }
    text.parse::<u64>().ok().and_then(SafeInt::new)
}

/// The TypeScript module of the handle grammar.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/handle",
    doc: "The handle grammar: an edge names each end by one string, `<mode>/<type>/<index>`, so \
          the side, the connection type and the branch index are recoverable from a stored edge \
          alone.",
    definitions: &[
        Definition::read::<WorkflowHandleMode>(),
        Definition::read::<WorkflowHandleType>(),
        Definition::read::<WorkflowHandle>(),
    ],
    constants: &[],
    method_tables: &[],
};
