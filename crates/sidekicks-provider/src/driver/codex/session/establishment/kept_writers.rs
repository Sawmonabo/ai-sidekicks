//! A conversation the services a start drained may still write, let go there, so a resume Codex
//! refused while another service wrote it waits only on that conversation's own turn: each
//! running service the home's records keep beside the daemon's own is joined as the turns a
//! restart kept are, unsubscribed from the conversation, and its unload awaited as Codex reports
//! it, within the resume's bound.

use std::error::Error;
use std::sync::Arc;

use futures::future::join_all;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::driver::codex::lifecycle::kept_turns::join_kept_service;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::routing::{
    CODEX_THREAD_CLOSED_METHOD, read_codex_frame_threads,
};
use crate::driver::codex::service::supervisor::start::is_thread_unloaded;
use crate::driver::codex::session::detached_conversation::CodexDetachedFrame;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::slots::unsubscribe_codex_thread;
use crate::driver::codex::transport::connection::CodexAppServerConnection;

/// Lets go of `thread_id` on every running service `service`'s home keeps beside `service`, by
/// `deadline`, and answers the process ids of those that may still write it: the ones still
/// holding it loaded at the deadline, else every one joined. A join that fails is logged and
/// joins none.
pub(super) async fn let_go_on_kept_services(
    service: &CodexService,
    thread_id: &str,
    deadline: Instant,
) -> Vec<u32> {
    let joined = tokio::time::timeout_at(deadline, join_kept_service(service, deadline)).await;
    let joined = match joined {
        Ok(Ok(joined)) => joined,
        Ok(Err(error)) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                thread_id,
                "the codex services the start drained could not be joined to let go of a \
                 conversation they still write"
            );
            return Vec::new();
        }
        Err(elapsed) => {
            tracing::warn!(
                error = &elapsed as &(dyn Error + 'static),
                thread_id,
                "the codex services the start drained were not joined within the resume's bound \
                 to let go of a conversation they still write"
            );
            return Vec::new();
        }
    };
    // Only a service beside the daemon's own is joined on a connection of its own.
    let let_go = join_all(joined.into_iter().filter_map(|kept| {
        let frames = kept.frames?;
        Some(let_go_on_kept_service(
            kept.process_id,
            kept.connection,
            frames,
            thread_id,
            deadline,
        ))
    }))
    .await;
    let still_loaded: Vec<u32> = let_go
        .iter()
        .filter(|(_process_id, is_unloaded)| !is_unloaded)
        .map(|(process_id, _is_unloaded)| *process_id)
        .collect();
    if still_loaded.is_empty() {
        return let_go
            .into_iter()
            .map(|(process_id, _is_unloaded)| process_id)
            .collect();
    }
    still_loaded
}

/// Codex's refusal `refusal` of a resume tried again after `writers`, the services
/// [`let_go_on_kept_services`] named, let go of the conversation, failed naming them.
pub(super) fn still_written(refusal: CodexError, writers: &[u32]) -> CodexError {
    let detail = if writers.is_empty() {
        "Another Codex service still writes the conversation, so it was not resumed.".to_owned()
    } else {
        let process_ids: Vec<String> = writers.iter().map(u32::to_string).collect();
        format!(
            "The Codex service with process id {} still writes the conversation, so it was not \
             resumed.",
            process_ids.join(", ")
        )
    };
    CodexError::Transport {
        detail,
        cause: Some(Box::new(refusal)),
    }
}

// Unsubscribes the connection of its own on the service whose process is `process_id` from
// `thread_id` and awaits its unload there by `deadline`; answers `process_id` and whether the
// unload came.
async fn let_go_on_kept_service(
    process_id: u32,
    connection: Arc<CodexAppServerConnection>,
    mut frames: mpsc::UnboundedReceiver<CodexDetachedFrame>,
    thread_id: &str,
    deadline: Instant,
) -> (u32, bool) {
    unsubscribe_codex_thread(&connection, thread_id).await;
    let is_unloaded = await_unloaded_on(&connection, &mut frames, thread_id, deadline).await;
    (process_id, is_unloaded)
}

// Waits until the service on `connection` no longer holds `thread_id` loaded, each `thread/closed`
// among `frames` confirmed by reading the loaded conversations, since a close can be stale; a
// connection that dropped holds nothing. `false` once `deadline` passed.
async fn await_unloaded_on(
    connection: &CodexAppServerConnection,
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    thread_id: &str,
    deadline: Instant,
) -> bool {
    loop {
        // Frames queue from the dial on, so a close before the read is not missed.
        if is_thread_unloaded(connection, thread_id).await {
            return true;
        }
        let closed = async {
            while let Some((method, params)) = frames.recv().await {
                if method == CODEX_THREAD_CLOSED_METHOD
                    && read_codex_frame_threads(&method, &params)
                        .thread_id
                        .as_deref()
                        == Some(thread_id)
                {
                    return;
                }
            }
        };
        if tokio::time::timeout_at(deadline, closed).await.is_err() {
            return false;
        }
    }
}
