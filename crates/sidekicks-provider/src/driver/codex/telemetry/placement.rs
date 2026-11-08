//! Where an exported response on a thread no session streams belongs: the walk up its parents and
//! a bounded cache of what it found.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{Map, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::completed_response::{CodexCompletedResponse, SSE_EVENT_NAME};
use crate::driver::codex::telemetry::exports::push_exported_response;
use crate::driver::codex::telemetry::held_responses::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::thread::ancestry::{
    CodexThreadPlacement, CodexUnplacedThread, place_codex_thread,
};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

/// How many threads one launch remembers the placement of; past it the oldest is forgotten.
const PLACEMENTS_KEPT: usize = 64;

/// One launch's placement state: where its off-stream threads were found.
#[derive(Default)]
pub(crate) struct CodexLaunchPlacement {
    // Oldest first, each thread once.
    placements: VecDeque<CodexPlacedThread>,
}

// A thread the walk found below a held thread.
struct CodexPlacedThread {
    thread_id: String,
    session_thread: String,
    child_thread: String,
}

impl CodexLaunchPlacement {
    // Where `thread_id` was found, as its held thread and the child it was found through.
    fn cached(&self, thread_id: &str) -> Option<(String, String)> {
        self.placements
            .iter()
            .find(|placed| placed.thread_id == thread_id)
            .map(|placed| (placed.session_thread.clone(), placed.child_thread.clone()))
    }

    // Remembers where `thread_id` was found, the oldest forgotten past the bound.
    fn cache(&mut self, thread_id: &str, session_thread: &str, child_thread: &str) {
        self.forget(thread_id);
        if self.placements.len() >= PLACEMENTS_KEPT {
            self.placements.pop_front();
        }
        self.placements.push_back(CodexPlacedThread {
            thread_id: thread_id.to_owned(),
            session_thread: session_thread.to_owned(),
            child_thread: child_thread.to_owned(),
        });
    }

    // Forgets where `thread_id` was found.
    fn forget(&mut self, thread_id: &str) {
        self.placements
            .retain(|placed| placed.thread_id != thread_id);
    }
}

/// Places `response`, on a thread no session of `service` streams, on the session its thread
/// runs below: from `launch`'s cache while its held thread is still held, else by walking its
/// parents. A thread with no held ancestor is refused, logged with its thread.
pub(crate) async fn place_off_stream(
    service: &Arc<CodexService>,
    launch: &Mutex<CodexLaunchPlacement>,
    response: CodexCompletedResponse,
    arrived_at: Instant,
) {
    let thread_id = response.conversation_id.clone();
    let cached = lock(launch).cached(&thread_id);
    if let Some((session_thread, child_thread)) = cached {
        if let Some(session_id) = service.session_of_thread(&session_thread) {
            let placed = CodexOffStreamPlacement::BelowThread {
                session_thread,
                child_thread,
            };
            push_exported_response(service, session_id, exported(response, arrived_at, placed));
            return;
        }
        lock(launch).forget(&thread_id);
    }
    let walked = match service.connection() {
        Ok(connection) => {
            place_codex_thread(&connection, &thread_id, |thread| {
                service.session_of_thread(thread)
            })
            .await
        }
        Err(error) => Err(error),
    };
    match walked {
        Ok(CodexThreadPlacement::Streamed) => {
            if let Some(session_id) = service.session_of_thread(&thread_id) {
                let exported = CodexExportedResponse {
                    response,
                    arrived_at,
                    placed: None,
                };
                push_exported_response(service, session_id, exported);
            } else {
                tracing::info!(
                    conversation_id = thread_id.as_str(),
                    "a codex completed response's thread left its session during its walk; it \
                     is dropped"
                );
            }
        }
        Ok(CodexThreadPlacement::BelowSession {
            session_id,
            session_thread,
            child_thread,
        }) => {
            lock(launch).cache(&thread_id, &session_thread, &child_thread);
            let placed = CodexOffStreamPlacement::BelowThread {
                session_thread,
                child_thread,
            };
            push_exported_response(service, session_id, exported(response, arrived_at, placed));
        }
        Ok(CodexThreadPlacement::Unplaced(
            CodexUnplacedThread::NoHeldAncestor | CodexUnplacedThread::Loop,
        )) => refuse_unplaced(
            &thread_id,
            service.provider_account_id(),
            "no thread a session holds is above its thread",
        ),
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed)) => tracing::info!(
            conversation_id = thread_id.as_str(),
            tokens = ?response.counts,
            "a codex completed response's thread is not listed yet; it is dropped"
        ),
        Err(error) => tracing::info!(
            error = &error as &(dyn std::error::Error + 'static),
            conversation_id = thread_id.as_str(),
            tokens = ?response.counts,
            "a codex completed response's thread could not be walked; it is dropped"
        ),
    }
}

// `response` as its session takes it, placed at `placed`.
fn exported(
    response: CodexCompletedResponse,
    arrived_at: Instant,
    placed: CodexOffStreamPlacement,
) -> CodexExportedResponse {
    CodexExportedResponse {
        response,
        arrived_at,
        placed: Some(placed),
    }
}

// Reports one refused completed response on `thread_id` under `provider_account_id`, naming the
// thread and `reason`, never a value its records carry.
fn refuse_unplaced(thread_id: &str, provider_account_id: Option<ProviderAccountId>, reason: &str) {
    let mut details = Map::new();
    details.insert("threadId".to_owned(), json!(thread_id));
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id,
        kind: DriverDiagnosticKind::TelemetryRecordRefused,
        raw_wire_type: Some(SSE_EVENT_NAME.to_owned()),
        disposition_reason: format!("A completed response could not be placed because {reason}."),
        details,
    });
}
