//! What a tool call does as its start's row records it: the kind and the subject a driver reads
//! from its provider's own tool input, cut to the row's field, else the open kind over the tool's
//! own name.

use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::tool_call::{ToolCallAction, ToolCallActionKind};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::text_cut::cut_to_code_points;

use crate::port::permission_ask::ProviderAskAction;

/// `kind` over `subject`, cut to the row's field; `None` for a subject that is blank or holds NUL.
pub(crate) fn compose_tool_call_action(
    kind: ToolCallActionKind,
    subject: &str,
) -> Option<ToolCallAction> {
    FreeFormText::new(cut_to_code_points(subject, EVENT_FIELD_MAX_LEN).to_owned())
        .ok()
        .map(|subject| ToolCallAction { kind, subject })
}

/// The open kind over the tool's own name, for a call no other kind covers or whose subject no row
/// can hold.
pub(crate) fn compose_open_tool_call_action(
    tool_name: &FreeFormText<EVENT_FIELD_MAX_LEN>,
) -> ToolCallAction {
    ToolCallAction {
        kind: ToolCallActionKind::Tool,
        subject: tool_name.clone(),
    }
}

/// What a call whose ask would read as `action` does, a change's first file its subject, else the
/// open kind over `tool_name` where that subject is one no row can hold.
pub(crate) fn compose_ask_tool_call_action(
    action: &ProviderAskAction,
    tool_name: &FreeFormText<EVENT_FIELD_MAX_LEN>,
) -> ToolCallAction {
    let subject = match action {
        ProviderAskAction::Command { command } => Some(command.as_str()),
        ProviderAskAction::CommandInput { input } => Some(input.as_str()),
        ProviderAskAction::FileChange { paths } => paths.first().map(String::as_str),
        ProviderAskAction::FileRead { path } => Some(path.as_str()),
        ProviderAskAction::Network { host } => Some(host.as_str()),
        ProviderAskAction::Tool {
            tool_name: asked_tool,
        } => Some(asked_tool.as_str()),
    };
    subject
        .and_then(|subject| compose_tool_call_action(ToolCallActionKind::from(action), subject))
        .unwrap_or_else(|| compose_open_tool_call_action(tool_name))
}
