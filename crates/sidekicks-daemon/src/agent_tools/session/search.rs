//! `session_search`'s handler: the search index's hits for the words, the sessions related to a
//! named one, or the sessions of a group or tag, narrowed by group, tag and project and grouped by
//! project, then session group, then session, each placed by its best session.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rusqlite::params;
use sidekicks_agent::tools::session::search::{
    GroupHits, HitPreview, NO_MATCHES, NO_PROJECT, ProjectHitEntry, ProjectHits, SessionHit,
    SessionSearchArguments, SessionSearchResults, cursor_unknown, relation_words,
};
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionSearchCursor, SessionSearchRequest, SessionSearchResponse,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::related::ranking::SessionRelatedRanking;
use sidekicks_session::search::index::live::LiveIndex;
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::agent_tools::AgentToolError;
use crate::agent_tools::session::list::{
    ListedSession, ListedSessions, SessionLineReads, read_listed_sessions,
};
use crate::orchestration::session_directory::{
    CallerReference, SessionDirectory, resolve_session_reference,
};

/// What `session_search` reads beside the directory: the index and the related lists.
pub(crate) struct SessionSearchSources<'sources> {
    /// The session directory.
    pub(crate) directory: &'sources SessionDirectory,
    /// The read of each listed session's facts.
    pub(crate) line_reads: &'sources SessionLineReads,
    /// The drivers, which name each session's provider.
    pub(crate) providers: &'sources ProviderRegistry,
    /// The search index the person's own search box reads.
    pub(crate) index: &'sources LiveIndex,
    /// Each session's ranked related list.
    pub(crate) related: &'sources SessionRelatedRanking,
}

// One session found, before it is grouped: its id, its best hit and why it is related.
struct Found {
    session_id: String,
    hit: Option<HitPreview>,
    reason: Option<String>,
}

/// `session_search` for a call `caller` makes, as its contract prints it, or [`NO_MATCHES`].
/// Refuses a `related_to` the directory does not resolve and a cursor that continues no held
/// search, in the text the model reads; fails as a read fails.
pub(crate) async fn search_sessions(
    sources: &SessionSearchSources<'_>,
    caller: &SessionId,
    arguments: SessionSearchArguments,
) -> Result<String, AgentToolError> {
    let ListedSessions {
        sessions: listed,
        unread,
    } = read_listed_sessions(
        sources.directory,
        sources.line_reads,
        sources.providers,
        caller,
    )
    .await?;
    let related = match &arguments.related_to {
        None => None,
        Some(reference) => {
            let entries: Vec<_> = listed.iter().map(|session| session.entry.clone()).collect();
            let target = resolve_session_reference(
                &entries,
                &unread,
                caller,
                reference,
                CallerReference::AnySession,
            )
            .map_err(AgentToolError::Refused)?;
            let target = SessionId::new(&target.id).map_err(AgentToolError::failed)?;
            let relevance = arguments.relevance.unwrap_or_default();
            let list = sources
                .related
                .read(target)
                .await
                .map_err(AgentToolError::failed)?;
            Some(
                list.related
                    .into_iter()
                    .filter(|entry| relevance.admits(entry.kind))
                    .map(|entry| {
                        let reason = relation_words(
                            entry.kind,
                            entry.session_is_source,
                            entry.message_count.map(SafeInt::get),
                        );
                        (entry.session_id.to_string(), reason)
                    })
                    .collect::<Vec<_>>(),
            )
        }
    };
    let (found, next_cursor) = if let Some(query) = &arguments.query {
        let after_cursor = arguments
            .cursor
            .as_ref()
            .map(|cursor| {
                SessionSearchCursor::new(cursor.as_str().to_owned())
                    .ok_or_else(|| AgentToolError::Refused(cursor_unknown(cursor.as_str())))
            })
            .transpose()?;
        let request = SessionSearchRequest {
            query: query.clone(),
            after_cursor,
            limit: None,
        };
        let response = sources
            .index
            .search_sessions(
                request,
                Arc::clone(&sources.directory.read_damaged_from_sequence),
            )
            .await
            .map_err(|error| match HandlerError::from(error) {
                // The index refuses only a cursor that continues no search it holds.
                HandlerError::Refused(_) => {
                    let cursor = arguments
                        .cursor
                        .as_ref()
                        .map_or("", |cursor| cursor.as_str());
                    AgentToolError::Refused(cursor_unknown(cursor))
                }
                other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
                    AgentToolError::failed(other)
                }
            })?;
        let reasons: Option<HashMap<String, String>> =
            related.map(|related| related.into_iter().collect());
        let (groups, next_cursor) = match response {
            SessionSearchResponse::Continuing(page) => (
                page.groups.into_vec(),
                Some(page.next_cursor.as_str().to_owned()),
            ),
            SessionSearchResponse::Terminal(page) => (page.groups, None),
        };
        let found: Vec<Found> = groups
            .into_iter()
            .filter_map(|group| {
                let session_id = group.session_id.to_string();
                let reason = match &reasons {
                    None => None,
                    Some(reasons) => Some(reasons.get(&session_id)?.clone()),
                };
                let best = group.hits.as_slice().first().map(|hit| HitPreview {
                    id: hit.cursor.as_str().to_owned(),
                    preview: hit.line.as_str().to_owned(),
                });
                Some(Found {
                    session_id,
                    hit: best,
                    reason,
                })
            })
            .collect();
        (found, next_cursor)
    } else {
        let found = match related {
            Some(related) => related
                .into_iter()
                .map(|(session_id, reason)| Found {
                    session_id,
                    hit: None,
                    reason: Some(reason),
                })
                .collect(),
            None => listed
                .iter()
                .map(|session| Found {
                    session_id: session.entry.id.clone(),
                    hit: None,
                    reason: None,
                })
                .collect(),
        };
        (found, None)
    };
    let tagged = match &arguments.tag {
        None => None,
        Some(tag) => Some(read_tagged_sessions(sources.directory, &fold_name(tag.as_str())).await?),
    };
    let group = arguments.group.map(|group| fold_name(group.as_str()));
    let project = arguments.project.map(|project| fold_name(project.as_str()));
    let is_named = |name: Option<&str>, wanted: Option<&str>| {
        wanted.is_none_or(|wanted| name.is_some_and(|name| fold_name(name) == wanted))
    };
    let by_id: HashMap<&str, &ListedSession> = listed
        .iter()
        .map(|session| (session.entry.id.as_str(), session))
        .collect();
    let hits: Vec<(&ListedSession, SessionHit)> = found
        .into_iter()
        .filter_map(|found| {
            let session = *by_id.get(found.session_id.as_str())?;
            let is_kept = is_named(session.group.as_deref(), group.as_deref())
                && is_named(session.entry.project.as_deref(), project.as_deref())
                && tagged
                    .as_ref()
                    .is_none_or(|tagged| tagged.contains(&found.session_id));
            is_kept.then(|| {
                (
                    session,
                    SessionHit {
                        line: session.line.clone(),
                        hit: found.hit,
                        reason: found.reason,
                    },
                )
            })
        })
        .collect();
    if hits.is_empty() && next_cursor.is_none() {
        return Ok(NO_MATCHES.to_owned());
    }
    Ok(SessionSearchResults {
        projects: grouped(hits),
        next_cursor,
    }
    .to_string())
}

// The ids of the sessions holding the tag whose fold is `tag_folded`.
async fn read_tagged_sessions(
    directory: &SessionDirectory,
    tag_folded: &str,
) -> Result<HashSet<String>, AgentToolError> {
    let tag_folded = tag_folded.to_owned();
    directory
        .pool
        .read(ReadLength::Short, move |reader| {
            reader
                .prepare_cached("SELECT session_id FROM session_tags WHERE tag_folded = ?1")?
                .query_map(params![tag_folded], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<HashSet<_>>>()
                .map_err(AgentToolError::from)
        })
        .await
}

// The hits, best first, under their projects and session groups, each project and group placed
// where its best session is.
fn grouped(hits: Vec<(&ListedSession, SessionHit)>) -> Vec<ProjectHits> {
    let mut projects: Vec<ProjectHits> = Vec::new();
    for (session, hit) in hits {
        let project_name = session
            .entry
            .project
            .clone()
            .unwrap_or_else(|| NO_PROJECT.to_owned());
        let place = projects
            .iter()
            .position(|project| project.name == project_name)
            .unwrap_or_else(|| {
                projects.push(ProjectHits {
                    name: project_name,
                    entries: Vec::new(),
                });
                projects.len() - 1
            });
        let project = &mut projects[place];
        let Some(group_name) = &session.group else {
            project
                .entries
                .push(ProjectHitEntry::Session(Box::new(hit)));
            continue;
        };
        let group = project.entries.iter_mut().find_map(|entry| match entry {
            ProjectHitEntry::Group(group) if group.name == *group_name => Some(group),
            ProjectHitEntry::Group(_) | ProjectHitEntry::Session(_) => None,
        });
        match group {
            Some(group) => group.sessions.push(hit),
            None => project.entries.push(ProjectHitEntry::Group(GroupHits {
                name: group_name.clone(),
                sessions: vec![hit],
            })),
        }
    }
    projects
}
