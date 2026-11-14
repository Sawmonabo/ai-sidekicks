//! Where an exported response on a thread no session streams belongs: the walk up its parents, a
//! bounded cache of what the walk or the join found, the threads whose walk failed lately, the
//! kept responses it could not place yet, and the join of a thread the listing lacks.

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
use crate::driver::codex::telemetry::copy_threads::CodexCopyThreads;
use crate::driver::codex::telemetry::drain::push_exported_response;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_INTERVAL;
use crate::driver::codex::thread::ancestry::{
    CodexThreadPlacement, CodexUnplacedThread, place_codex_thread,
};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::pricing::export_status::INTERVALS_WAITED;

pub(crate) mod join;

use join::CodexJoinTargets;

/// How many threads one launch remembers the placement of, and how many failed walks it marks;
/// past either the oldest is forgotten.
pub(crate) const PLACEMENTS_KEPT: usize = 64;

/// How many responses one launch keeps while their threads cannot be placed yet, about 200 B
/// each; past it the oldest is refused.
pub(crate) const KEPT_RESPONSES: usize = 1_000;

/// One launch's placement state: where its off-stream threads were found or joined, the threads
/// whose walk failed lately, the responses it keeps until the launch's next export retries them,
/// its sessions' review windows and turns, and its copies' threads. Its kept responses are
/// refused as it drops.
#[derive(Default)]
pub(crate) struct CodexLaunchPlacement {
    // Oldest first, as `kept` and `failed_walks` are, each thread once.
    placements: VecDeque<CodexPlacedThread>,
    // Each thread whose walk failed and when it may be walked again.
    failed_walks: VecDeque<(String, Instant)>,
    kept: VecDeque<CodexKeptResponse>,
    joins: CodexJoinTargets,
    copies: CodexCopyThreads,
}

// A thread placed off the stream and where: below a held thread, or joined to a session's turn.
struct CodexPlacedThread {
    thread_id: String,
    placed: CodexCachedPlacement,
}

// Where a placed thread's responses go.
#[derive(Clone)]
enum CodexCachedPlacement {
    // Below `session_thread`, a thread a session holds, through `child_thread`.
    Below {
        session_thread: String,
        child_thread: String,
    },
    // On `turn_id` of `session_id`, the turn the join found.
    Joined {
        session_id: SessionId,
        turn_id: String,
    },
}

// A response whose thread could not be placed yet: the export it came in, and whether a walk
// already found its thread not listed.
struct CodexKeptResponse {
    response: CodexCompletedResponse,
    export_number: u64,
    is_unlisted: bool,
}

impl CodexLaunchPlacement {
    // Where `thread_id` was placed.
    fn cached(&self, thread_id: &str) -> Option<CodexCachedPlacement> {
        self.placements
            .iter()
            .find(|placed| placed.thread_id == thread_id)
            .map(|placed| placed.placed.clone())
    }

    // Remembers where `thread_id` was placed, the oldest forgotten past the bound.
    fn cache(&mut self, thread_id: &str, placed: CodexCachedPlacement) {
        self.forget(thread_id);
        if self.placements.len() >= PLACEMENTS_KEPT {
            self.placements.pop_front();
        }
        self.placements.push_back(CodexPlacedThread {
            thread_id: thread_id.to_owned(),
            placed,
        });
    }

    // Forgets where `thread_id` was placed.
    fn forget(&mut self, thread_id: &str) {
        self.placements
            .retain(|placed| placed.thread_id != thread_id);
    }

    // Marks `thread_id`'s walk failed at `now`, so it is not walked again for two export
    // intervals; the oldest mark is forgotten past the bound.
    fn mark_failed_walk(&mut self, thread_id: &str, now: Instant) {
        self.failed_walks
            .retain(|(failed, _until)| failed != thread_id);
        if self.failed_walks.len() >= PLACEMENTS_KEPT {
            self.failed_walks.pop_front();
        }
        let until = now + CODEX_EXPORT_INTERVAL * INTERVALS_WAITED;
        self.failed_walks.push_back((thread_id.to_owned(), until));
    }

    // Whether `thread_id`'s walk failed less than two export intervals before `now`.
    fn is_walk_failing(&mut self, thread_id: &str, now: Instant) -> bool {
        self.failed_walks.retain(|(_failed, until)| *until > now);
        self.failed_walks
            .iter()
            .any(|(failed, _until)| failed == thread_id)
    }

    /// The launch's copies' threads, which the drain looks a response's thread up in first.
    pub(crate) fn copies(&mut self) -> &mut CodexCopyThreads {
        &mut self.copies
    }

    /// The launch's review windows and session turns, which an unlisted thread is joined to.
    pub(crate) fn joins(&mut self) -> &mut CodexJoinTargets {
        &mut self.joins
    }

    // Whether a response on `thread_id` is kept, so a new one waits for the retry beside it.
    fn is_kept(&self, thread_id: &str) -> bool {
        self.kept
            .iter()
            .any(|kept| kept.response.conversation_id == thread_id)
    }

    // Keeps each of `responses`, the oldest past the bound refused.
    fn keep(&mut self, responses: impl IntoIterator<Item = CodexKeptResponse>) {
        for kept in responses {
            if self.kept.len() >= KEPT_RESPONSES
                && let Some(dropped) = self.kept.pop_front()
            {
                refuse_response(
                    &dropped.response,
                    "its launch keeps too many responses it could not place yet",
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
    // A launch whose tag or service went takes its kept responses with it, each refused.
    fn drop(&mut self) {
        for kept in &self.kept {
            refuse_response(
                &kept.response,
                "its launch ended before its thread could be placed",
            );
        }
    }
}

/// The responses of one thread a launch places together, oldest first, never empty.
pub(crate) struct CodexKeptBucket(Vec<CodexKeptResponse>);

/// What refuses a bucket whose placement was abandoned: its thread and the account it ran on.
pub(crate) struct CodexBucketRefusal {
    thread_id: String,
    provider_account_id: Option<ProviderAccountId>,
}

impl CodexKeptBucket {
    /// What refuses the bucket once, should its placement be abandoned.
    pub(crate) fn refusal(&self) -> CodexBucketRefusal {
        let first = self.0.first().map(|kept| &kept.response);
        CodexBucketRefusal {
            thread_id: first
                .map(|response| response.conversation_id.clone())
                .unwrap_or_default(),
            provider_account_id: first.and_then(|response| response.provider_account_id.clone()),
        }
    }
}

impl CodexBucketRefusal {
    /// Refuses the bucket once, naming its thread and `reason`.
    pub(crate) fn refuse(self, reason: &str) {
        refuse_unplaced(&self.thread_id, self.provider_account_id, reason);
    }
}

/// The bucket of `response` of the export numbered `export_number`, on a thread no session
/// streams, to place now; `None` where its thread already has kept responses, beside which it is
/// kept on `launch` for its next export's retry.
pub(crate) fn bucket_off_stream(
    launch: &Mutex<CodexLaunchPlacement>,
    response: CodexCompletedResponse,
    export_number: u64,
) -> Option<CodexKeptBucket> {
    let kept = CodexKeptResponse {
        response,
        export_number,
        is_unlisted: false,
    };
    let mut placement = lock(launch);
    if placement.is_kept(&kept.response.conversation_id) {
        placement.keep([kept]);
        return None;
    }
    Some(CodexKeptBucket(vec![kept]))
}

/// Takes each thread's responses `launch` kept before the export numbered `export_number`, one
/// bucket per thread, for the retry to place.
pub(crate) fn take_kept_buckets(
    launch: &Mutex<CodexLaunchPlacement>,
    export_number: u64,
) -> Vec<CodexKeptBucket> {
    lock(launch)
        .take_kept_before(export_number)
        .into_iter()
        .map(CodexKeptBucket)
        .collect()
}

/// Places `bucket`, the responses of one thread, on the session holding the thread, from the
/// cache while what it names still holds, else by walking its parents once; a thread whose walk
/// failed in the last two export intervals is kept unwalked, a thread not listed after an
/// earlier walk found it so goes to the join, and one whose walk fails is kept again. A thread
/// with no held ancestor is refused once, naming its thread.
pub(crate) async fn place_bucket(
    service: &Arc<CodexService>,
    launch: &Mutex<CodexLaunchPlacement>,
    bucket: CodexKeptBucket,
) {
    let bucket = bucket.0;
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
    match cached {
        Some(CodexCachedPlacement::Below {
            session_thread,
            child_thread,
        }) => {
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
        Some(CodexCachedPlacement::Joined {
            session_id,
            turn_id,
        }) => {
            let placed = CodexOffStreamPlacement::OnTurn { turn_id };
            push_bucket(service, session_id, bucket, Some(&placed));
            return;
        }
        None => {}
    }
    if lock(launch).is_walk_failing(&thread_id, Instant::now()) {
        lock(launch).keep(bucket);
        return;
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
    let provider_account_id = bucket
        .first()
        .and_then(|kept| kept.response.provider_account_id.clone());
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
            lock(launch).cache(
                &thread_id,
                CodexCachedPlacement::Below {
                    session_thread: session_thread.clone(),
                    child_thread: child_thread.clone(),
                },
            );
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
            provider_account_id,
            "no thread a session holds is above its thread",
        ),
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed)) => {
            if bucket.iter().any(|kept| kept.is_unlisted) {
                join_unlisted(service, launch, &thread_id, bucket);
            } else {
                let unlisted = bucket.into_iter().map(|kept| CodexKeptResponse {
                    is_unlisted: true,
                    ..kept
                });
                lock(launch).keep(unlisted);
            }
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                conversation_id = thread_id.as_str(),
                "a codex completed response's thread could not be walked; it is kept"
            );
            let mut placement = lock(launch);
            placement.mark_failed_walk(&thread_id, Instant::now());
            placement.keep(bucket);
        }
    }
}

// Joins `bucket`, the responses of a thread the listing still lacks after a second walk, to the
// review window or turn live when its first record was observed, filed on that turn of its
// session, and remembers the join for the thread's later responses; a review runs only for a
// turn that asked an approval, so this keeps it on the account that ran it. A bucket nothing
// covers, and a record with no observed time, is refused.
fn join_unlisted(
    service: &CodexService,
    launch: &Mutex<CodexLaunchPlacement>,
    thread_id: &str,
    bucket: Vec<CodexKeptResponse>,
) {
    let (timed, untimed): (Vec<_>, Vec<_>) = bucket
        .into_iter()
        .partition(|kept| kept.response.observed_at_ms > 0);
    if let Some(untimed) = untimed.first() {
        refuse_response(
            &untimed.response,
            "its record carries no time it was observed",
        );
    }
    let Some(first) = timed.first() else {
        return;
    };
    let mut placement = lock(launch);
    let Some((session_id, turn_id)) = placement.joins().target(first.response.observed_at_ms)
    else {
        drop(placement);
        refuse_response(
            &first.response,
            "no review window or turn covers its thread",
        );
        return;
    };
    placement.cache(
        thread_id,
        CodexCachedPlacement::Joined {
            session_id,
            turn_id: turn_id.clone(),
        },
    );
    drop(placement);
    let placed = CodexOffStreamPlacement::OnTurn { turn_id };
    push_bucket(service, session_id, timed, Some(&placed));
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
            placed: placed.cloned(),
            rollout: None,
        };
        push_exported_response(service, session_id, exported);
    }
}

/// Reports `response` refused under the account it ran on, naming its thread and `reason`.
pub(crate) fn refuse_response(response: &CodexCompletedResponse, reason: &str) {
    refuse_unplaced(
        &response.conversation_id,
        response.provider_account_id.clone(),
        reason,
    );
}

/// Reports one refused response or bucket on `thread_id` under `provider_account_id`, naming the
/// thread and `reason`, which completes "because", never a value its records carry.
pub(crate) fn refuse_unplaced(
    thread_id: &str,
    provider_account_id: Option<ProviderAccountId>,
    reason: &str,
) {
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
