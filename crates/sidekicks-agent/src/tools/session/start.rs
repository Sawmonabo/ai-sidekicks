//! `session_start`: a new session with a first message, at the caller's own permission level or,
//! as a copy, at the stricter of the two sessions' levels. With `wait: true` the call answers
//! with what `session_wait` answers.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::project::{PROJECT_NAME_MAX_LEN, ProjectName};
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_TOKEN_MAX_LEN;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::trust_statement::MACHINE_OR_DEVICE_NAME_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{
    SessionReference, ToolDescription, path_limits, permission_level_words, text_field,
};

/// How `session_start` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_start`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_start",
    summary: "Start a new session with a first message. It runs on its own, in the list beside \
              the person's other sessions, and the person can open it.",
    body: "{\"name\": \"tax-fix\", \"message\": \"Fix the rounding bug in tax.ts and run the tax \
           tests.\", \"branch\": \"new\"}\n{\"from_session\": \"builder\", \"message\": \"Try \
           the same fix with Decimal instead.\"}\n\nOnly when the person, a workflow step or \
           your saved instructions ask for a new session. It starts at your own permission \
           level, never a looser one. By default it uses your project, provider, model and \
           effort; set them only when asked. Pass wait: true to wait for its first answer in the \
           same call.",
};

/// The words every setting a new session takes from the caller's own begins with.
const OWN_SETTING_WORDS: &str = "Omit to use this session's own. Names come from session_options.";

/// A setting's description: the shared words, what the setting names, then its limits.
fn own_setting_words(what: &str, max: usize) -> String {
    text_field(&format!("{OWN_SETTING_WORDS} {what}"), max)
}

/// `session_start`'s arguments. Each setting left out is the calling session's own; each name is
/// read against what `session_options` lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionStartArguments {
    /// The first message.
    #[schemars(description = text_field(
        "The first message: concrete, self-contained, and saying what to send back.",
        usize::MAX,
    ))]
    pub message: FreeFormText<{ usize::MAX }>,
    /// The new session's name in the list.
    #[schemars(description = text_field(
        "A short name for the list. Omit to let the session name itself.",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// The project to work in.
    #[schemars(description = own_setting_words("The project's name:", PROJECT_NAME_MAX_LEN))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "ProjectName")]
    pub project: Option<ProjectName>,
    /// The branch to work on, or `new` for a new one.
    #[schemars(description = own_setting_words(
        "\"new\" starts a new branch. The branch's name:",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub branch: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// The worktree to work in.
    #[schemars(description = own_setting_words("The worktree's name:", SESSION_NAME_MAX_LEN))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub worktree: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// The provider to run on, by the name the person reads.
    #[schemars(description = own_setting_words("The provider's name:", SESSION_NAME_MAX_LEN))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub provider: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// The model to run.
    #[schemars(description = own_setting_words("The model's name:", PROVIDER_WIRE_TOKEN_MAX_LEN))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>")]
    pub model: Option<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>,
    /// The model's effort level.
    #[schemars(description = own_setting_words(
        "The effort level's name:",
        PROVIDER_WIRE_TOKEN_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>")]
    pub effort: Option<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>,
    /// The person's computer to run on.
    #[schemars(description = own_setting_words(
        "The computer's name:",
        MACHINE_OR_DEVICE_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<MACHINE_OR_DEVICE_NAME_MAX_LEN>")]
    pub computer: Option<FreeFormText<MACHINE_OR_DEVICE_NAME_MAX_LEN>>,
    /// The session to start as a copy of, with its conversation.
    #[schemars(description = text_field(
        "Start as a copy of this session, with its conversation. The copy takes the stricter of \
         the two sessions' permission levels. A session name or id:",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "SessionReference")]
    pub from_session: Option<SessionReference>,
    /// The project's group to file the new session in.
    #[schemars(description = text_field(
        "File it in this group of the project; the group is created if it does not exist. The \
         group's name:",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub group: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Files to attach to the first message.
    #[schemars(description = format!(
        "Paths you can read, attached to the first message. {}",
        path_limits()
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "Vec<FilesystemPath>")]
    pub files: Option<Vec<FilesystemPath>>,
    /// Whether to wait for the first answer in the same call.
    #[schemars(
        description = "true waits until the new session finishes its first turn or needs the \
                       person, and returns its answer. Default false."
    )]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "bool")]
    pub wait: Option<bool>,
}

/// Whose permission level a new session took.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LevelOrigin {
    /// The calling session's own.
    Yours,
    /// The stricter level of the session it was copied from.
    CopiedSession {
        /// That session's name.
        name: String,
    },
}

/// The session `session_start` started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionStartResult {
    /// The new session's name.
    pub name: String,
    /// The new session's id.
    pub id: String,
    /// The provider's name as the person reads it.
    pub provider: String,
    /// The model's name as the person reads it.
    pub model: String,
    /// The project it works in.
    pub project: String,
    /// The branch it works on, where it works on one.
    pub branch: Option<String>,
    /// Its permission level.
    pub level: PermissionLevel,
    /// Whose level that is.
    pub level_origin: LevelOrigin,
}

impl fmt::Display for SessionStartResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            name,
            id,
            provider,
            model,
            project,
            branch,
            level,
            level_origin,
        } = self;
        write!(
            formatter,
            "Started {name} · {id} · {provider} {model} · {project}"
        )?;
        if let Some(branch) = branch {
            write!(formatter, " · branch {branch}")?;
        }
        let level = permission_level_words(*level);
        match level_origin {
            LevelOrigin::Yours => write!(formatter, " · {level} (your level)."),
            LevelOrigin::CopiedSession { name } => {
                write!(formatter, " · {level} ({name}'s level).")
            }
        }
    }
}
