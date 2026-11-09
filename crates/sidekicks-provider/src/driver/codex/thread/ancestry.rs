//! Where a Codex thread no session streams sits under the threads sessions hold: the automatic
//! reviewer, a `/review` helper or any other sub-agent, found by walking its `parentThreadId` up
//! through Codex's listing of sub-agent threads.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::app_server_protocol::{
    ThreadListParams, ThreadSortKey, ThreadSourceKind,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
const THREAD_LIST_METHOD: &str = "thread/list";

/// The threads one `thread/list` page asks for.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
const THREAD_LIST_PAGE_LIMIT: u32 = 100;

/// The most `thread/list` pages one walk reads before it gives the thread up as not listed.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
const THREAD_LIST_MAX_PAGES: usize = 5;

/// Every sub-agent source; Codex lists only interactive threads when the listing names none.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
const SUB_AGENT_SOURCE_KINDS: [ThreadSourceKind; 5] = [
    ThreadSourceKind::SubAgent,
    ThreadSourceKind::SubAgentReview,
    ThreadSourceKind::SubAgentCompact,
    ThreadSourceKind::SubAgentThreadSpawn,
    ThreadSourceKind::SubAgentOther,
];

/// Where a Codex thread sits relative to the threads sessions hold.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
#[derive(Debug)]
pub(crate) enum CodexThreadPlacement {
    /// A session holds the thread itself, so its stream prices it.
    Streamed,
    /// The thread runs below a thread a session holds.
    BelowSession {
        /// The session holding the ancestor.
        session_id: SessionId,
        /// The held ancestor, the first held thread on the way up.
        session_thread: String,
        /// The thread one hop below the held ancestor on the way up, the thread itself when its
        /// own parent is held.
        child_thread: String,
    },
    /// No held thread was found above the thread.
    Unplaced(CodexUnplacedThread),
}

/// Why a walk found no held thread above a Codex thread.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
#[derive(Debug)]
pub(crate) enum CodexUnplacedThread {
    /// A thread on the way up was not in the listing before it ended or the page bound was
    /// reached.
    NotListed,
    /// The way up reached a thread with no parent, which no session holds.
    NoHeldAncestor,
    /// The way up came back to a thread it had already passed.
    Loop,
}

// The members of a `thread/list` page the walk reads; an absent or empty `nextCursor` ends the
// listing.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListPage {
    data: Vec<Box<RawValue>>,
    next_cursor: Option<String>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedThread {
    id: Option<String>,
    parent_thread_id: Option<String>,
}

/// Where `thread_id` sits under the threads `session_of` says a session holds on `connection`'s
/// service, read from `thread/list` only when no session holds the thread itself. `session_of` is
/// called between the walk's requests, never across one. Fails as a request fails, and with
/// `CodexError::Transport` for a reply that is not a page.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
pub(crate) async fn place_codex_thread(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    session_of: impl Fn(&str) -> Option<SessionId>,
) -> Result<CodexThreadPlacement, CodexError> {
    if session_of(thread_id).is_some() {
        return Ok(CodexThreadPlacement::Streamed);
    }
    let mut parent_by_thread: HashMap<String, Option<String>> = HashMap::new();
    let mut cursor = None;
    let mut pages_read = 0;
    let mut is_listing_ended = false;
    let mut visited = HashSet::from([thread_id.to_owned()]);
    let mut current = thread_id.to_owned();
    loop {
        let parent = loop {
            if let Some(parent) = parent_by_thread.get(&current) {
                break parent.clone();
            }
            if is_listing_ended || pages_read == THREAD_LIST_MAX_PAGES {
                return Ok(CodexThreadPlacement::Unplaced(
                    CodexUnplacedThread::NotListed,
                ));
            }
            let page = read_thread_list_page(connection, cursor.take()).await?;
            pages_read += 1;
            let mut unread_threads = 0_usize;
            for entry in page.data {
                let Some(ListedThread {
                    id: Some(id),
                    parent_thread_id,
                }) = read_codex_object::<ListedThread>(entry.get())
                else {
                    unread_threads += 1;
                    continue;
                };
                parent_by_thread.insert(id, parent_thread_id.filter(|parent| !parent.is_empty()));
            }
            // A thread on the way up may be among them, so the walk may end not listed.
            if unread_threads > 0 {
                tracing::warn!(
                    unread_threads,
                    page = pages_read,
                    "a Codex thread listing page held threads that did not read"
                );
            }
            cursor = page.next_cursor.filter(|next| !next.is_empty());
            is_listing_ended = cursor.is_none();
        };
        let Some(parent) = parent else {
            return Ok(CodexThreadPlacement::Unplaced(
                CodexUnplacedThread::NoHeldAncestor,
            ));
        };
        if let Some(session_id) = session_of(parent.as_str()) {
            return Ok(CodexThreadPlacement::BelowSession {
                session_id,
                session_thread: parent,
                child_thread: current,
            });
        }
        if !visited.insert(parent.clone()) {
            return Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::Loop));
        }
        current = parent;
    }
}

// One page of every sub-agent thread on the service, the most recently updated first, from
// `cursor`, read from Codex's state database alone: the walk reads only ids and parents, which the
// database holds, and the rollout scan it skips costs most of a page's time.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader places each request it prices through it"
    )
)]
async fn read_thread_list_page(
    connection: &CodexAppServerConnection,
    cursor: Option<String>,
) -> Result<ThreadListPage, CodexError> {
    let params = ThreadListParams {
        ancestor_thread_id: None,
        archived: None,
        attached_to_thread_id: None,
        cursor,
        cwd: None,
        excluded_thread_ids: None,
        limit: Some(THREAD_LIST_PAGE_LIMIT),
        model_providers: None,
        originators: None,
        parent_thread_id: None,
        project_id: None,
        search_term: None,
        section_id: None,
        sort_direction: None,
        sort_key: Some(ThreadSortKey::UpdatedAt),
        source_kinds: Some(SUB_AGENT_SOURCE_KINDS.to_vec()),
        use_state_db_only: Some(true),
    };
    let reply = connection.request(THREAD_LIST_METHOD, &params).await?;
    read_codex_object::<ThreadListPage>(reply.get()).ok_or_else(|| CodexError::Transport {
        detail: format!("The Codex app-server \"{THREAD_LIST_METHOD}\" reply carried no page."),
        cause: None,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::session::id::SessionId;

    use super::{CodexThreadPlacement, CodexUnplacedThread, place_codex_thread};
    use crate::driver::codex::transport::connection::scripted_service::scripted_connection;
    use crate::driver::test_registry::new_session_id;

    /// The thread the walk places.
    const THREAD: &str = "T";

    /// The walk's answer as one line, every member it carries read.
    fn describe(placement: &CodexThreadPlacement, held: &HashMap<&str, SessionId>) -> String {
        match placement {
            CodexThreadPlacement::Streamed => "streamed".to_owned(),
            CodexThreadPlacement::BelowSession {
                session_id,
                session_thread,
                child_thread,
            } => {
                assert_eq!(held.get(session_thread.as_str()), Some(session_id));
                format!("below {session_thread} through {child_thread}")
            }
            CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed) => {
                "not listed".to_owned()
            }
            CodexThreadPlacement::Unplaced(CodexUnplacedThread::NoHeldAncestor) => {
                "no held ancestor".to_owned()
            }
            CodexThreadPlacement::Unplaced(CodexUnplacedThread::Loop) => "loop".to_owned(),
        }
    }

    // A thread a session holds is streamed and nothing is asked; otherwise the walk pages
    // `thread/list` over the sub-agent sources from the state database alone, most recently updated
    // first, with each page's cursor, until the way up meets a held thread (whose child is the
    // thread one hop below it, not the thread placed), a thread with no parent, a thread it passed
    // or the end of its bound. Killed by dropping the state-database flag, reading the first page
    // only, answering the placed thread as the child, no visited set (the loop never answers),
    // unbounded paging and a listing that names no sub-agent source, which Codex answers with
    // interactive threads only.
    #[rstest]
    #[case::streamed(&[THREAD], vec![], "streamed")]
    #[case::below(
        &["S"],
        vec![
            json!({
                "data": [
                    { "id": "X", "parentThreadId": null },
                    { "id": THREAD, "parentThreadId": "P" }
                ],
                "nextCursor": "c"
            }),
            json!({ "data": [{ "id": "P", "parentThreadId": "S" }], "nextCursor": null }),
        ],
        "below S through P"
    )]
    #[case::cycle(
        &[],
        vec![json!({
            "data": [
                { "id": THREAD, "parentThreadId": "P" },
                { "id": "P", "parentThreadId": THREAD }
            ]
        })],
        "loop"
    )]
    #[case::no_ancestor(&[], vec![json!({ "data": [{ "id": THREAD }] })], "no held ancestor")]
    #[case::bound(
        &[],
        (1..=5)
            .map(|page| json!({
                "data": [{ "id": format!("X{page}") }],
                "nextCursor": format!("c{page}")
            }))
            .collect(),
        "not listed"
    )]
    #[tokio::test]
    async fn places_a_thread_under_the_thread_a_session_holds(
        #[case] held_threads: &[&str],
        #[case] pages: Vec<Value>,
        #[case] answer: &str,
    ) {
        let held: HashMap<&str, SessionId> = held_threads
            .iter()
            .map(|thread| (*thread, new_session_id()))
            .collect();
        let (connection, mut script, _frames) = scripted_connection();

        let (placement, ()) = tokio::join!(
            place_codex_thread(&connection, THREAD, |thread| held.get(thread).copied()),
            async {
                let mut cursor = Value::Null;
                for page in pages {
                    let list = script.next_sent().await;
                    assert_eq!(list["method"], "thread/list");
                    assert_eq!(
                        list["params"]["sourceKinds"],
                        json!([
                            "subAgent",
                            "subAgentReview",
                            "subAgentCompact",
                            "subAgentThreadSpawn",
                            "subAgentOther"
                        ])
                    );
                    assert_eq!(list["params"]["sortKey"], "updated_at");
                    assert_eq!(list["params"]["useStateDbOnly"], true);
                    assert_eq!(list["params"]["limit"], 100);
                    assert_eq!(list["params"]["cursor"], cursor);
                    script.answer(&list, &page);
                    cursor = page["nextCursor"].clone();
                }
            }
        );

        let placement = placement.expect("the walk's requests are answered");
        assert_eq!(describe(&placement, &held), answer);
        assert!(
            script.sent.try_recv().is_err(),
            "nothing else is sent to the service"
        );
    }
}
