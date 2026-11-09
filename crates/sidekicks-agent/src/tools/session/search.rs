//! `session_search`: every session's messages, tool calls, titles, groups and tags, ranked and
//! grouped by project, then session group, then session.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::project::{PROJECT_NAME_MAX_LEN, ProjectName};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::session::search::SESSION_SEARCH_QUERY_MAX_LEN;
use sidekicks_contracts::tag::Tag;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::list::SessionListLine;
use crate::tools::session::{
    PAGE_CURSOR_MAX_LEN, PageCursor, SessionReference, ToolDescription, more_trailer,
    require_one_of, text_field,
};

/// How `session_search` is gated: it only reads what the calling session may already read.
pub const GATE: CallbackToolGate = CallbackToolGate::Read;

/// What a model reads about `session_search`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_search",
    summary: "Search every session's messages, tool calls, titles, groups and tags, the same \
              index as the person's own search box. Results are ranked and grouped by project, \
              then group.",
    body: "{\"query\": \"stripe webhook\"}\n{\"related_to\": \"builder\", \"relevance\": \
           \"high\"}\n\nUse it to find earlier work (\"the session that fixed the webhook last \
           week\"). Results are previews; read a session with session_read. Name at least one \
           of query, related_to, group or tag.",
};

/// The members of which a search names at least one.
const SEARCH_SUBJECTS: &[&str] = &["query", "related_to", "group", "tag"];

/// States in the schema that a search names at least one of its subjects.
fn require_a_subject(schema: &mut schemars::Schema) {
    require_one_of(schema, SEARCH_SUBJECTS);
}

/// `session_search`'s arguments. A search names words, a related session, a group or a tag.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|arguments: &Self, (): &()| arguments.names_a_subject()))]
#[schemars(transform = require_a_subject)]
pub struct SessionSearchArguments {
    /// Words to find.
    #[schemars(description = text_field(
        "Words to find. Omit to search by related_to, group or tag alone.",
        SESSION_SEARCH_QUERY_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_SEARCH_QUERY_MAX_LEN>")]
    pub query: Option<FreeFormText<SESSION_SEARCH_QUERY_MAX_LEN>>,
    /// A session whose related sessions to return.
    #[schemars(description = text_field(
        "A session name or id. Returns sessions related to it (started by it, copied from it, \
         messaged, asked, mentioned, or linked on purpose), each with its reason.",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "SessionReference")]
    pub related_to: Option<SessionReference>,
    /// How closely a related session must be related.
    #[schemars(
        description = "With related_to: \"high\", \"medium\" or \"any\". Default \
                              \"medium\"."
    )]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "Relevance")]
    pub relevance: Option<Relevance>,
    /// Only sessions in this group.
    #[schemars(description = text_field(
        "Narrow to this group, tag or project. The group's name:",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub group: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Only sessions with this tag.
    #[schemars(description = format!(
        "Narrow to this group, tag or project. The tag: lowercase, no spaces, \"/\" nests it \
         (\"billing/stripe\"), at most {SESSION_NAME_MAX_LEN} characters."
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "Tag")]
    pub tag: Option<Tag>,
    /// Only sessions in this project.
    #[schemars(description = text_field(
        "Narrow to this group, tag or project. The project's name:",
        PROJECT_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "ProjectName")]
    pub project: Option<ProjectName>,
    /// The next page of the same search.
    #[schemars(description = text_field(
        "The next_cursor from the previous page of the same search. Keep the other fields \
         unchanged.",
        PAGE_CURSOR_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "PageCursor")]
    pub cursor: Option<PageCursor>,
}

impl SessionSearchArguments {
    /// Refuses a search that names no words, related session, group or tag.
    fn names_a_subject(&self) -> garde::Result {
        let names_a_subject = self.query.is_some()
            || self.related_to.is_some()
            || self.group.is_some()
            || self.tag.is_some();
        if names_a_subject {
            Ok(())
        } else {
            Err(garde::Error::new(
                "a search names words (query), a related session (related_to), a group or a tag",
            ))
        }
    }
}

/// How closely a related session must be related to be returned.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Relevance {
    /// Only the closest relations.
    High,
    /// Close and middling relations.
    #[default]
    Medium,
    /// Every relation.
    Any,
}

/// One page of search results, grouped project, then session group, then session, each group and
/// project placed by its best session's score.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSearchResults {
    /// The projects with hits, best first.
    pub projects: Vec<ProjectHits>,
    /// The cursor of the next page, when there is one.
    pub next_cursor: Option<String>,
}

/// One project's hits, its session groups and its loose sessions in one ranked order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectHits {
    /// The project's name.
    pub name: String,
    /// Its groups and loose sessions, best first.
    pub entries: Vec<ProjectHitEntry>,
}

/// A project's entry in the results: a session group with hits, or a session in no group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectHitEntry {
    /// A session group and its sessions with hits.
    Group(GroupHits),
    /// A session in no group, boxed since a hit is far larger than a group's list.
    Session(Box<SessionHit>),
}

/// One session group's hits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupHits {
    /// The group's name.
    pub name: String,
    /// Its sessions with hits, best first.
    pub sessions: Vec<SessionHit>,
}

/// One session found, with its best hit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionHit {
    /// The session, as `session_list` prints it.
    pub line: SessionListLine,
    /// The hit's id, which `session_read`'s `around` takes.
    pub hit_id: String,
    /// The text around the match.
    pub preview: String,
    /// For a related result, why it is related, in words.
    pub reason: Option<String>,
}

impl SessionHit {
    /// Adds the hit's lines at `indent` spaces, its details two more in.
    fn push_lines(&self, lines: &mut Vec<String>, indent: usize) {
        let detail = indent + 2;
        lines.push(format!("{:indent$}{}", "", self.line));
        lines.push(format!(
            "{:detail$}hit {}: {}",
            "", self.hit_id, self.preview
        ));
        if let Some(reason) = &self.reason {
            lines.push(format!("{:detail$}related: {reason}", ""));
        }
    }
}

impl fmt::Display for SessionSearchResults {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut lines = Vec::new();
        for project in &self.projects {
            lines.push(project.name.clone());
            for entry in &project.entries {
                match entry {
                    ProjectHitEntry::Group(group) => {
                        lines.push(format!("  {}", group.name));
                        for session in &group.sessions {
                            session.push_lines(&mut lines, 4);
                        }
                    }
                    ProjectHitEntry::Session(session) => session.push_lines(&mut lines, 2),
                }
            }
        }
        if let Some(next_cursor) = &self.next_cursor {
            lines.push(more_trailer(next_cursor));
        }
        formatter.write_str(&lines.join("\n"))
    }
}
