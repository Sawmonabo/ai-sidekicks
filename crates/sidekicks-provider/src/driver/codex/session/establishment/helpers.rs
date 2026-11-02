//! A Codex helper reopened on the daemon's connection: Codex attaches a loaded helper only to the
//! connections that were open when the helper started, so the daemon's connection receives its
//! frames only after a `thread/resume` of it, which Codex accepts only once its parent is loaded.
//! A helper reopened after the adoption is registered as the session's first; one held on the
//! person keeps the mark its adoption gave its newest turn, so that turn's end is the daemon's.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use super::adoption::request_bare_thread_resume;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::history::{CodexListedTurn, read_codex_resumed_newest_turn};
use crate::driver::codex::transport::connection::CodexAppServerConnection;

/// Reopens the helper `thread_id` on `connection` as it stands, with no setting, and answers its
/// newest turn, `None` where it holds none. Fails as the resume does, a parent not loaded among
/// Codex's refusals.
pub(crate) async fn reopen_codex_helper(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Option<CodexListedTurn>, CodexError> {
    let reply = request_bare_thread_resume(connection, thread_id).await?;
    Ok(read_codex_resumed_newest_turn(&reply))
}

/// Reopens the helper `thread_id` as [`reopen_codex_helper`] does, registered on `service` as
/// session `session_id`'s first, since Codex sends a reopened helper's waiting asks right after
/// its reply and the service refuses one no session names. A refused reopen lets go of the
/// registration it made; one already there stays.
pub(crate) async fn reopen_registered_codex_helper(
    service: &CodexService,
    connection: &CodexAppServerConnection,
    session_id: SessionId,
    thread_id: &str,
) -> Result<Option<CodexListedTurn>, CodexError> {
    let was_registered = service
        .threads_of(&session_id)
        .iter()
        .any(|registered| registered == thread_id);
    service.register_thread(thread_id.to_owned(), session_id);
    let reopened = reopen_codex_helper(connection, thread_id).await;
    if reopened.is_err() && !was_registered {
        service.release_thread(thread_id);
    }
    reopened
}

/// Orders `helpers` so each comes after the listed helper whose run is its parent run, otherwise
/// keeping their order. Each pass moves every helper whose parent run is no longer waiting, so it
/// takes at most as many passes as helpers; a cycle keeps the rest in their order.
pub(crate) fn order_parents_first<T>(
    helpers: Vec<T>,
    run_id: impl Fn(&T) -> RunId,
    parent_run_id: impl Fn(&T) -> Option<RunId>,
) -> Vec<T> {
    let mut ordered = Vec::with_capacity(helpers.len());
    let mut waiting = helpers;
    while !waiting.is_empty() {
        let waiting_run_ids: Vec<RunId> = waiting.iter().map(&run_id).collect();
        let (ready, held): (Vec<T>, Vec<T>) = waiting.into_iter().partition(|helper| {
            parent_run_id(helper).is_none_or(|parent| !waiting_run_ids.contains(&parent))
        });
        if ready.is_empty() {
            ordered.extend(held);
            break;
        }
        ordered.extend(ready);
        waiting = held;
    }
    ordered
}
