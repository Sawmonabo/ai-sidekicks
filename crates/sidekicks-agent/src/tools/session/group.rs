//! `session_group`: puts sessions in a named group of their project, takes them out, renames a
//! group or ungroups it.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{
    SessionReference, ToolDescription, require_one_of, text_field, text_limits,
};

/// How `session_group` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_group`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_group",
    summary: "Put sessions in a named group of their project, take them out, rename a group or \
              ungroup it. A session sits in one group at a time; the group is created when you \
              first add to it.",
    body: "{\"group\": \"auth work\", \"add\": [\"login refactor\", \"token rotation\", \
           \"this\"]}\n{\"group\": \"auth work\", \"rename_to\": \"auth\"}\n\nUngrouping \
           archives nothing; its sessions go back loose. Name at least one of add, remove, \
           rename_to or delete.",
};

/// The members of which a call names at least one, besides `delete`.
const ACTIONS: &[&str] = &["add", "remove", "rename_to"];

/// The words a model reads about a list of sessions.
fn sessions_words() -> String {
    format!(
        "Session names or ids; \"this\" means the session you are in. Each {}",
        text_limits(SESSION_NAME_MAX_LEN)
    )
}

/// States in the schema that a call names an action, and that `delete: true` comes alone.
fn require_one_action(schema: &mut schemars::Schema) {
    require_one_of(schema, ACTIONS);
    let deletes = json!({
        "type": "object",
        "required": ["delete"],
        "properties": { "delete": { "const": true } },
    });
    if let Some(serde_json::Value::Array(arms)) = schema.get_mut("anyOf") {
        arms.push(deletes.clone());
    }
    let others: Vec<serde_json::Value> = ACTIONS
        .iter()
        .map(|action| json!({ "type": "object", "required": [action] }))
        .collect();
    schema.insert("if".into(), deletes);
    schema.insert("then".into(), json!({ "not": { "anyOf": others } }));
}

/// `session_group`'s arguments: a group and one thing to do to it. `delete: true` ungroups the
/// group, so it comes with nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|arguments: &Self, (): &()| arguments.names_one_action()))]
#[schemars(transform = require_one_action)]
pub struct SessionGroupArguments {
    /// The group.
    #[schemars(description = text_field("The group's name in the project.", SESSION_NAME_MAX_LEN))]
    pub group: FreeFormText<SESSION_NAME_MAX_LEN>,
    /// Sessions to put in the group.
    #[schemars(description = sessions_words())]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "Vec<SessionReference>")]
    pub add: Option<Vec<SessionReference>>,
    /// Sessions to take out of the group.
    #[schemars(description = sessions_words())]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "Vec<SessionReference>")]
    pub remove: Option<Vec<SessionReference>>,
    /// The group's new name.
    #[schemars(description = text_field("The new name.", SESSION_NAME_MAX_LEN))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub rename_to: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Whether to ungroup every session in the group.
    #[schemars(description = "true ungroups every session in it, and comes with nothing else.")]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "bool")]
    pub delete: Option<bool>,
}

impl SessionGroupArguments {
    /// Refuses a call that names no action, and `delete: true` beside another.
    fn names_one_action(&self) -> garde::Result {
        let names_another = self.add.is_some() || self.remove.is_some() || self.rename_to.is_some();
        let deletes = self.delete == Some(true);
        match (deletes, names_another) {
            (true, true) => Err(garde::Error::new("delete: true comes with nothing else")),
            (false, false) => Err(garde::Error::new(
                "name add, remove, rename_to or delete: true",
            )),
            (true, false) | (false, true) => Ok(()),
        }
    }
}

/// What `session_group` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionGroupResult {
    /// Sessions put in the group.
    Added {
        /// The group's name.
        group: String,
        /// How many sessions moved in.
        count: usize,
    },
    /// Sessions taken out of the group.
    Removed {
        /// The group's name.
        group: String,
        /// How many sessions came out.
        count: usize,
    },
    /// The group renamed.
    Renamed {
        /// Its old name.
        from: String,
        /// Its new name.
        to: String,
    },
    /// The group ungrouped, its sessions back loose.
    Ungrouped {
        /// The group's name.
        group: String,
        /// How many sessions went back loose.
        count: usize,
    },
}

/// `count` sessions, in words.
fn sessions(count: usize) -> String {
    if count == 1 {
        "1 session".to_owned()
    } else {
        format!("{count} sessions")
    }
}

impl fmt::Display for SessionGroupResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Added { group, count } => {
                write!(formatter, "{group} · {} added.", sessions(*count))
            }
            Self::Removed { group, count } => {
                write!(formatter, "{group} · {} removed.", sessions(*count))
            }
            Self::Renamed { from, to } => write!(formatter, "{from} · renamed to {to}."),
            Self::Ungrouped { group, count } => {
                write!(formatter, "{group} · {} ungrouped.", sessions(*count))
            }
        }
    }
}
