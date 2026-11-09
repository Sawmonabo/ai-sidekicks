//! The contracts of the twelve session tools, through which a session reaches the person's other
//! sessions: the rules every session holds, the errors every tool shares, and each tool's
//! description, arguments and result, all twelve here, one file each.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};

use crate::tools::group::AgentTool;

pub mod ask;
pub mod errors;
pub mod group;
pub mod list;
pub mod options;
pub mod read;
pub mod remind;
pub mod rules;
pub mod search;
pub mod send;
pub mod start;
pub mod stop;
pub mod update;
pub mod wait;

#[cfg(test)]
mod tests;

/// The twelve session tools, each with the gate its module declares and its arguments' type; the
/// one list of them.
pub const TOOLS: [AgentTool; 12] = [
    AgentTool::of::<list::SessionListArguments>(list::DESCRIPTION, list::GATE),
    AgentTool::of::<search::SessionSearchArguments>(search::DESCRIPTION, search::GATE),
    AgentTool::of::<EmptyPayload>(options::DESCRIPTION, options::GATE),
    AgentTool::of::<read::SessionReadArguments>(read::DESCRIPTION, read::GATE),
    AgentTool::of::<update::SessionUpdateArguments>(update::DESCRIPTION, update::GATE),
    AgentTool::of::<group::SessionGroupArguments>(group::DESCRIPTION, group::GATE),
    AgentTool::of::<start::SessionStartArguments>(start::DESCRIPTION, start::GATE),
    AgentTool::of::<send::SessionSendArguments>(send::DESCRIPTION, send::GATE),
    AgentTool::of::<ask::SessionAskArguments>(ask::DESCRIPTION, ask::GATE),
    AgentTool::of::<wait::SessionWaitArguments>(wait::DESCRIPTION, wait::GATE),
    AgentTool::of::<stop::SessionStopArguments>(stop::DESCRIPTION, stop::GATE),
    AgentTool::of::<remind::SessionRemindArguments>(remind::DESCRIPTION, remind::GATE),
];

/// The longest page cursor a tool takes back, in code points.
pub const PAGE_CURSOR_MAX_LEN: usize = 512;

/// The longest id of one item inside a session that a tool takes back (a search hit, a tool
/// output), in code points.
pub const SESSION_ITEM_ID_MAX_LEN: usize = 256;

/// What a model reads about one tool: its name, the summary line a tool search matches, and the
/// body under it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolDescription {
    /// The tool's name, as the model calls it.
    pub name: &'static str,
    /// The description's first line.
    pub summary: &'static str,
    /// The rest of the description: its examples and when to use the tool.
    pub body: &'static str,
}

impl ToolDescription {
    /// The whole description, summary and body joined by one blank line, for a provider that shows
    /// one description.
    pub fn text(&self) -> String {
        format!("{}\n\n{}", self.summary, self.body)
    }
}

/// The words a field's description ends with for free-form text of at most `max` code points,
/// `usize::MAX` meaning no bound, since Codex shows the model no lengths or patterns.
pub(crate) fn text_limits(max: usize) -> String {
    if max == usize::MAX {
        return "At least one character that is not whitespace, with no NUL character.".to_owned();
    }
    format!("1 to {max} characters, not only whitespace, with no NUL character.")
}

/// The words a field's description ends with for a list of paths, since Codex shows the model no
/// lengths or patterns.
pub(crate) fn path_limits() -> String {
    format!("Each 1 to {FILE_PATH_MAX_LEN} characters, with no NUL character.")
}

/// A field's description: the tool's own words for it, then its limits as free-form text of at
/// most `max` code points.
pub(crate) fn text_field(words: &str, max: usize) -> String {
    format!("{words} {}", text_limits(max))
}

/// A permission level as the person reads it on screen.
pub(crate) fn permission_level_words(level: PermissionLevel) -> &'static str {
    match level {
        PermissionLevel::Readonly => "Read-only",
        PermissionLevel::Ask => "Ask",
        PermissionLevel::Reviewed => "Reviewed",
        PermissionLevel::Sandboxed => "Sandboxed",
        PermissionLevel::Yolo => "YOLO",
    }
}

/// States in `schema` that an object holds at least one of `members`, the schema's twin of a
/// garde rule asking for one of them.
pub(crate) fn require_one_of(schema: &mut Schema, members: &[&str]) {
    let arms: Vec<Value> = members
        .iter()
        .map(|member| json!({ "type": "object", "required": [member] }))
        .collect();
    schema.insert("anyOf".into(), Value::Array(arms));
}

/// Declares a newtype over [`FreeFormText`] of at most `MAX` code points whose schema is inline, so
/// a field's own description replaces the type's.
macro_rules! free_form_newtype {
    ($(#[doc = $doc:literal])+ pub struct $name:ident($max:expr), $words:literal;) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(FreeFormText<{ $max }>);

        impl $name {
            /// Checks `text`; refuses it with the first rule it breaks.
            pub fn new(text: String) -> Result<Self, TextError> {
                FreeFormText::new(text).map(Self)
            }

            /// The checked text.
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }

        impl JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(generator: &mut SchemaGenerator) -> Schema {
                let mut schema = FreeFormText::<{ $max }>::json_schema(generator);
                schema.insert("description".into(), text_field($words, $max).into());
                schema
            }
        }
    };
}

free_form_newtype! {
    /// A session as a model names it: its name or its id, never an address. `"this"` is a plain
    /// value here; the tools that take it as the calling session read it so.
    pub struct SessionReference(SESSION_NAME_MAX_LEN), "A session name or id from session_list.";
}

free_form_newtype! {
    /// The opaque `next_cursor` of a previous page, handed back to read the next one.
    pub struct PageCursor(PAGE_CURSOR_MAX_LEN), "The next_cursor from the previous page.";
}

/// The line a paged result ends with when there is more to read.
pub fn more_trailer(next_cursor: &str) -> String {
    format!("More: next_cursor \"{next_cursor}\"")
}
