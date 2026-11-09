//! `session_update`: renames, archives, pins, tags and links one session, several changes in one
//! call.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::tag::TagList;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{SessionReference, ToolDescription, require_one_of, text_field};

/// How `session_update` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_update`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_update",
    summary: "Rename, archive, unarchive, pin or unpin a session; add or remove tags; link it to \
              a related session.",
    body: "{\"session\": \"tax-fix\", \"archived\": true}\n{\"session\": \"this\", \"add_tags\": \
           [\"billing/stripe\"], \"link\": \"stripe-webhook\"}\n\n\"this\" means the session you \
           are in. Name at least one change.",
};

/// The members of which an update names at least one.
const CHANGES: &[&str] = &[
    "name",
    "archived",
    "pinned",
    "add_tags",
    "remove_tags",
    "link",
    "unlink",
];

/// The words a model reads about a list of tags.
fn tags_words() -> String {
    format!(
        "Tags, lowercase, no spaces; \"/\" nests them (\"billing/stripe\"). Each at most \
         {SESSION_NAME_MAX_LEN} characters."
    )
}

/// States in the schema that an update names at least one change.
fn require_a_change(schema: &mut schemars::Schema) {
    require_one_of(schema, CHANGES);
}

/// `session_update`'s arguments: the session and at least one change to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|arguments: &Self, (): &()| arguments.names_a_change()))]
#[schemars(transform = require_a_change)]
pub struct SessionUpdateArguments {
    /// The session to change.
    #[schemars(description = text_field(
        "A session name or id, or \"this\".",
        SESSION_NAME_MAX_LEN,
    ))]
    pub session: SessionReference,
    /// The session's new name.
    #[schemars(description = text_field("The new name.", SESSION_NAME_MAX_LEN))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Whether the session is archived.
    #[schemars(description = "true or false.")]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "bool")]
    pub archived: Option<bool>,
    /// Whether the session is pinned.
    #[schemars(description = "true or false.")]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "bool")]
    pub pinned: Option<bool>,
    /// Tags to add.
    #[schemars(description = tags_words())]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "TagList")]
    #[garde(dive)]
    pub add_tags: Option<TagList>,
    /// Tags to remove.
    #[schemars(description = tags_words())]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "TagList")]
    #[garde(dive)]
    pub remove_tags: Option<TagList>,
    /// A session to mark as related.
    #[schemars(description = text_field(
        "A session name or id to mark as related, or to unmark.",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "SessionReference")]
    pub link: Option<SessionReference>,
    /// A related session to unmark.
    #[schemars(description = text_field(
        "A session name or id to mark as related, or to unmark.",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "SessionReference")]
    pub unlink: Option<SessionReference>,
}

impl SessionUpdateArguments {
    /// Refuses an update that names no change.
    fn names_a_change(&self) -> garde::Result {
        let names_a_change = self.name.is_some()
            || self.archived.is_some()
            || self.pinned.is_some()
            || self.add_tags.is_some()
            || self.remove_tags.is_some()
            || self.link.is_some()
            || self.unlink.is_some();
        if names_a_change {
            Ok(())
        } else {
            Err(garde::Error::new("an update names at least one change"))
        }
    }
}

/// One change `session_update` made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionChange {
    /// Renamed.
    Renamed {
        /// The new name.
        to: String,
    },
    /// Archived.
    Archived,
    /// Taken out of the archive.
    Unarchived,
    /// Pinned.
    Pinned,
    /// Unpinned.
    Unpinned,
    /// Tags added.
    Tagged(Vec<String>),
    /// Tags removed.
    Untagged(Vec<String>),
    /// Marked as related to a session.
    Linked {
        /// The related session's name.
        session: String,
    },
    /// No longer marked as related to a session.
    Unlinked {
        /// The session's name.
        session: String,
    },
}

impl fmt::Display for SessionChange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Renamed { to } => write!(formatter, "renamed to {to}"),
            Self::Archived => formatter.write_str("archived"),
            Self::Unarchived => formatter.write_str("unarchived"),
            Self::Pinned => formatter.write_str("pinned"),
            Self::Unpinned => formatter.write_str("unpinned"),
            Self::Tagged(tags) => write!(formatter, "tagged {}", tags.join(", ")),
            Self::Untagged(tags) => write!(formatter, "untagged {}", tags.join(", ")),
            Self::Linked { session } => write!(formatter, "linked to {session}"),
            Self::Unlinked { session } => write!(formatter, "unlinked from {session}"),
        }
    }
}

/// What `session_update` did to one session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionUpdateResult {
    /// The session's name after the update.
    pub name: String,
    /// The session's id.
    pub id: String,
    /// The changes made, in the order made.
    pub changes: Vec<SessionChange>,
}

impl fmt::Display for SessionUpdateResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let changes: Vec<String> = self.changes.iter().map(ToString::to_string).collect();
        write!(
            formatter,
            "Updated {} · {}: {}.",
            self.name,
            self.id,
            changes.join(", ")
        )
    }
}
