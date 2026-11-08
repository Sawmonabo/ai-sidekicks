//! Where an exported response on a thread no session streams belongs: the walk up its parents, a
//! bounded cache of what it found, and the kept responses it could not place yet.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{Map, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
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

/// How many responses one launch keeps while their threads cannot be placed yet, about 200 B
/// each; past it the oldest is logged and dropped.
const KEPT_RESPONSES: usize = 1_000;

/// One launch's placement state: where its off-stream threads were found and the responses it
/// keeps until the launch's next export retries them. Its kept responses are logged as it drops.
#[derive(Default)]
pub(crate) struct CodexLaunchPlacement {
    // Oldest first, each thread once.
    placements: VecDeque<CodexPlacedThread>,
    // Oldest first.
    kept: VecDeque<CodexKeptResponse>,
}

// A thread the walk found below a held thread.
struct CodexPlacedThread {
    thread_id: String,
    session_thread: String,
    child_thread: String,
}

// A response whose thread could not be placed yet: the export it came in, and whether a walk
// already found its thread not listed.
struct CodexKeptResponse {
    response: CodexCompletedResponse,
    arrived_at: Instant,
    export_number: u64,
    is_unlisted: bool,
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

    // Whether a response on `thread_id` is kept, so a new one waits for the retry beside it.
    fn is_kept(&self, thread_id: &str) -> bool {
        self.kept
            .iter()
            .any(|kept| kept.response.conversation_id == thread_id)
    }

    // Keeps each of `responses`, the oldest past the bound logged and dropped.
    fn keep(&mut self, responses: impl IntoIterator<Item = CodexKeptResponse>) {
        for kept in responses {
            if self.kept.len() >= KEPT_RESPONSES
                && let Some(dropped) = self.kept.pop_front()
            {
                tracing::warn!(
                    conversation_id = dropped.response.conversation_id.as_str(),
                    tokens = ?dropped.response.counts,
                    "a codex launch keeps too many unplaced responses; the oldest is dropped"
                );
            }
            self.kept.push_back(kept);
        }
    }

    // Takes every kept response that came before the export numbered `export_number`, by thread,
    // each thread's responses oldest first.
    fn take_kept_before(&mut self, export_number: u64) -> Vec<Vec<CodexKeptResponse>> {
        let (before, after): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut self.kept)
            .into_iter()
            .partition(|kept| kept.export_number < export_number);
        self.kept = after;
        let mut buckets: Vec<Vec<CodexKeptResponse>> = Vec::new();
        for kept in before {
            match buckets.iter_mut().find(|bucket| {
                bucket.first().map(|first| &first.response.conversation_id)
                    == Some(&kept.response.conversation_id)
            }) {
                Some(bucket) => bucket.push(kept),
                None => buckets.push(vec![kept]),
            }
        }
        buckets
    }
}

impl Drop for CodexLaunchPlacement {
    // A launch replaced or whose service went takes its kept responses with it, each logged.
    fn drop(&mut self) {
        for kept in &self.kept {
            tracing::info!(
                conversation_id = kept.response.conversation_id.as_str(),
                tokens = ?kept.response.counts,
                "a codex launch that kept an unplaced response is gone; it is dropped"
            );
        }
    }
}

/// Places `response` of the export numbered `export_number`, on a thread no session of `service`
/// streams, on the session its thread runs below; one whose thread already has kept responses, is
/// not listed yet or could not be walked is kept on `launch` for its next export's retry.
pub(crate) async fn place_off_stream(
    service: &Arc<CodexService>,
    launch: &Mutex<CodexLaunchPlacement>,
    response: CodexCompletedResponse,
    arrived_at: Instant,
    export_number: u64,
) {
    let kept = CodexKeptResponse {
        response,
        arrived_at,
        export_number,
        is_unlisted: false,
    };
    let kept = {
        let mut placement = lock(launch);
        if placement.is_kept(&kept.response.conversation_id) {
            placement.keep([kept]);
            return;
        }
        kept
    };
    place_bucket(service, launch, vec![kept]).await;
}

/// Places each thread's responses `launch` kept before the export numbered `export_number`,
/// walking each thread once: a thread still not listed after an earlier walk found it so goes to
/// the join, and one whose walk failed is kept again.
pub(crate) async fn retry_kept(
    service: &Arc<CodexService>,
    launch: &Mutex<CodexLaunchPlacement>,
    export_number: u64,
) {
    let buckets = lock(launch).take_kept_before(export_number);
    for bucket in buckets {
        place_bucket(service, launch, bucket).await;
    }
}

// Places `bucket`, the responses of one thread, on the session holding the thread or the one its
// thread runs below, from the cache while its held thread is still held, else by walking its
// parents once. A thread with no held ancestor is refused once, logged with its thread.
async fn place_bucket(
    service: &Arc<CodexService>,
    launch: &Mutex<CodexLaunchPlacement>,
    bucket: Vec<CodexKeptResponse>,
) {
    let Some(thread_id) = bucket
        .first()
        .map(|kept| kept.response.conversation_id.clone())
    else {
        return;
    };
    if let Some(session_id) = service.session_of_thread(&thread_id) {
        push_bucket(service, session_id, bucket, None);
        return;
    }
    let cached = lock(launch).cached(&thread_id);
    if let Some((session_thread, child_thread)) = cached {
        if let Some(session_id) = service.session_of_thread(&session_thread) {
            let placed = CodexOffStreamPlacement::BelowThread {
                session_thread,
                child_thread,
            };
            push_bucket(service, session_id, bucket, Some(&placed));
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
                push_bucket(service, session_id, bucket, None);
            } else {
                // Left its session between the walk's look and this one: walked again later.
                lock(launch).keep(bucket);
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
            push_bucket(service, session_id, bucket, Some(&placed));
        }
        Ok(CodexThreadPlacement::Unplaced(
            CodexUnplacedThread::NoHeldAncestor | CodexUnplacedThread::Loop,
        )) => refuse_unplaced(
            &thread_id,
            service.provider_account_id(),
            "no thread a session holds is above its thread",
        ),
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed)) => {
            if bucket.iter().any(|kept| kept.is_unlisted) {
                join_unlisted(service, &thread_id);
            } else {
                let unlisted = bucket.into_iter().map(|kept| CodexKeptResponse {
                    is_unlisted: true,
                    ..kept
                });
                lock(launch).keep(unlisted);
            }
        }
        Err(error) => {
            tracing::info!(
                error = &error as &(dyn std::error::Error + 'static),
                conversation_id = thread_id.as_str(),
                "a codex completed response's thread could not be walked; it is kept"
            );
            lock(launch).keep(bucket);
        }
    }
}

// The responses of a thread the listing still lacks after a second walk.
fn join_unlisted(service: &CodexService, thread_id: &str) {
    refuse_unplaced(
        thread_id,
        service.provider_account_id(),
        "its thread is not listed",
    );
}

// Pushes each of `bucket` onto `session_id`'s queue, placed at `placed`.
fn push_bucket(
    service: &CodexService,
    session_id: SessionId,
    bucket: Vec<CodexKeptResponse>,
    placed: Option<&CodexOffStreamPlacement>,
) {
    for kept in bucket {
        let exported = CodexExportedResponse {
            response: kept.response,
            arrived_at: kept.arrived_at,
            placed: placed.cloned(),
        };
        push_exported_response(service, session_id, exported);
    }
}

// Reports one refused bucket on `thread_id` under `provider_account_id`, naming the thread and
// `reason`, never a value its records carry.
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
