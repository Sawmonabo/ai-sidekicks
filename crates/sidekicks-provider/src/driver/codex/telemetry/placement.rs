//! Where an exported response on a thread no session streams belongs: the walk up its parents, a
//! bounded cache of what the walk or the join found, the threads whose walk failed lately, the
//! kept responses it could not place yet, the join of a thread the listing lacks, and the charge
//! of a thread no session will ever hold as its account's spend outside any session.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{Map, json};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::pricing::{read_region_word, unknown_host_region};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::completed_response::{CodexCompletedResponse, SSE_EVENT_NAME};
use crate::driver::codex::telemetry::copy_threads::CodexCopyThreads;
use crate::driver::codex::telemetry::drain::push_exported_responses;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_INTERVAL;
use crate::driver::codex::thread::ancestry::{
    CodexThreadPlacement, CodexUnplacedThread, place_codex_thread,
};
use crate::driver::codex::thread::view::{CodexThreadFile, request_thread_file};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::ports::SessionlessRequest;
use crate::pricing::export_status::INTERVALS_WAITED;
use crate::usage_delta_accountant::compose_one_turn_spend;

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
/// its sessions' review windows and turns, its copies' threads, and the region its responses no
/// session owns are charged at. Its kept responses are refused as it drops.
#[derive(Default)]
pub(crate) struct CodexLaunchPlacement {
    // Oldest first, as `kept` and `failed_walks` are, each thread once.
    placements: VecDeque<CodexPlacedThread>,
    // Each thread whose walk failed and when it may be walked again.
    failed_walks: VecDeque<(String, Instant)>,
    kept: VecDeque<CodexKeptResponse>,
    joins: CodexJoinTargets,
    copies: CodexCopyThreads,
    sessionless_region: CodexSessionlessRegion,
}

// The region a launch's responses no session owns are charged at, read once, at the first charge.
#[derive(Clone, Default)]
enum CodexSessionlessRegion {
    #[default]
    Unread,
    Read(Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>),
}

// A thread placed off the stream and where: below a held thread, joined to a session's turn, or
// nowhere a session holds.
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
    // Nowhere, ever: Codex keeps no file for the thread and holds it neither loaded nor stored, so
    // its responses are its account's spend outside any session.
    Sessionless,
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

/// A thread no session streams that a bucket was placed on off the stream: the session it went
/// to, where, and when its newest response was observed, in Unix milliseconds, zero where none
/// carries a time.
pub(crate) struct CodexOffStreamThread {
    /// The session the bucket went to.
    pub(crate) session_id: SessionId,
    /// The thread's id.
    pub(crate) thread_id: String,
    /// Where it was placed.
    pub(crate) placed: CodexOffStreamPlacement,
    /// When its newest response was observed.
    pub(crate) observed_at_ms: u64,
}

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
/// with no held ancestor is refused once, naming its thread, and one the cache holds as no
/// session's is charged as its account's spend. Answers the thread where it was placed off the
/// stream.
pub(crate) async fn place_bucket(
    service: &Arc<CodexService>,
    launch: &Mutex<CodexLaunchPlacement>,
    bucket: CodexKeptBucket,
) -> Option<CodexOffStreamThread> {
    let bucket = bucket.0;
    let thread_id = bucket
        .first()
        .map(|kept| kept.response.conversation_id.clone())?;
    if let Some(session_id) = service.session_of_thread(&thread_id) {
        return push_bucket(service, session_id, bucket, None);
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
                return push_bucket(service, session_id, bucket, Some(&placed));
            }
            lock(launch).forget(&thread_id);
        }
        Some(CodexCachedPlacement::Joined {
            session_id,
            turn_id,
        }) => {
            let placed = CodexOffStreamPlacement::OnTurn { turn_id };
            return push_bucket(service, session_id, bucket, Some(&placed));
        }
        Some(CodexCachedPlacement::Sessionless) => {
            charge_sessionless(service, launch, bucket).await;
            return None;
        }
        None => {}
    }
    if lock(launch).is_walk_failing(&thread_id, Instant::now()) {
        lock(launch).keep(bucket);
        return None;
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
                return push_bucket(service, session_id, bucket, None);
            }
            // Left its session between the walk's look and this one: walked again later.
            lock(launch).keep(bucket);
            None
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
            push_bucket(service, session_id, bucket, Some(&placed))
        }
        Ok(CodexThreadPlacement::Unplaced(
            CodexUnplacedThread::NoHeldAncestor | CodexUnplacedThread::Loop,
        )) => {
            refuse_unplaced(
                &thread_id,
                provider_account_id,
                "no thread a session holds is above its thread",
            );
            None
        }
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed)) => {
            if bucket.iter().any(|kept| kept.is_unlisted) {
                return join_unlisted(service, launch, &thread_id, bucket).await;
            }
            let unlisted = bucket.into_iter().map(|kept| CodexKeptResponse {
                is_unlisted: true,
                ..kept
            });
            lock(launch).keep(unlisted);
            None
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
            None
        }
    }
}

// Joins `bucket`, the responses of a thread the listing still lacks after a second walk, to the
// review window or turn live when its first record carrying a time was observed, filed on that
// turn of its session, and remembers the join for the thread's later responses; a review runs
// only for a turn that asked an approval, so this keeps it on the account that ran it. A bucket
// nothing covers, or none of whose records carries a time, is settled by its thread's file.
// Answers the thread where it was joined.
async fn join_unlisted(
    service: &CodexService,
    launch: &Mutex<CodexLaunchPlacement>,
    thread_id: &str,
    bucket: Vec<CodexKeptResponse>,
) -> Option<CodexOffStreamThread> {
    let target = bucket
        .iter()
        .map(|kept| kept.response.observed_at_ms)
        .find(|observed_at_ms| *observed_at_ms > 0)
        .and_then(|observed_at_ms| lock(launch).joins().target(observed_at_ms));
    let Some((session_id, turn_id)) = target else {
        settle_unjoined(service, launch, thread_id, bucket).await;
        return None;
    };
    lock(launch).cache(
        thread_id,
        CodexCachedPlacement::Joined {
            session_id,
            turn_id: turn_id.clone(),
        },
    );
    let placed = CodexOffStreamPlacement::OnTurn { turn_id };
    push_bucket(service, session_id, bucket, Some(&placed))
}

// Settles `bucket`, the responses of a thread nothing joins, by where Codex keeps the thread's
// file. A thread it keeps none for and holds neither loaded nor stored, a memory consolidation
// worker's among them, no listing will ever place, so its responses, and its later ones, are its
// account's spend outside any session. A thread with a file may yet be listed under a session,
// whose read of that file from its launch's registration then counts them, so its bucket is
// refused once, as one whose lookup fails is.
async fn settle_unjoined(
    service: &CodexService,
    launch: &Mutex<CodexLaunchPlacement>,
    thread_id: &str,
    bucket: Vec<CodexKeptResponse>,
) {
    let looked_up = match service.connection() {
        Ok(connection) => request_thread_file(&connection, thread_id).await,
        Err(error) => Err(error),
    };
    let reason = match looked_up {
        Ok(CodexThreadFile::Never) => {
            lock(launch).cache(thread_id, CodexCachedPlacement::Sessionless);
            charge_sessionless(service, launch, bucket).await;
            return;
        }
        Ok(CodexThreadFile::At(_path)) => "no review window or turn covers its thread",
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                conversation_id = thread_id,
                "a codex thread nothing joins could not be looked up"
            );
            "its thread could not be looked up"
        }
    };
    let provider_account_id = bucket
        .first()
        .and_then(|kept| kept.response.provider_account_id.clone());
    refuse_unplaced(thread_id, provider_account_id, reason);
}

// Hands `bucket`'s responses to the repricing as their accounts' spend outside any session, one
// held row each in one write, at the region of the service's settings for no folder, since no
// response names the session whose settings ran it, read once per launch; a read that fails holds
// the bucket at the unknown host's region and is tried again at the next charge. A response
// naming no account, or a count past the wire's range, is refused, and so is each one where no
// repricing is registered or the write fails.
async fn charge_sessionless(
    service: &CodexService,
    launch: &Mutex<CodexLaunchPlacement>,
    bucket: Vec<CodexKeptResponse>,
) {
    let Some(repricing) = service.dependencies().request_held.port() else {
        for kept in &bucket {
            refuse_response(&kept.response, "no repricing takes an account's spend yet");
        }
        return;
    };
    let read = lock(launch).sessionless_region.clone();
    let processing_region = match read {
        CodexSessionlessRegion::Read(region) => region,
        CodexSessionlessRegion::Unread => match read_region_word(service, None).await {
            Ok(region) => {
                lock(launch).sessionless_region = CodexSessionlessRegion::Read(region.clone());
                region
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a codex service's region could not be read; its spend outside any session \
                     is held"
                );
                unknown_host_region()
            }
        },
    };
    let mut charged = Vec::with_capacity(bucket.len());
    let mut requests = Vec::with_capacity(bucket.len());
    for CodexKeptResponse { response, .. } in bucket {
        let Some(provider_account_id) = response.provider_account_id.clone() else {
            refuse_response(&response, "its launch names no account it ran on");
            continue;
        };
        let spend = compose_one_turn_spend(
            DESCRIPTOR.provider_id(),
            Some(response.model_id.clone()),
            response.service_tier.clone(),
            response.counts,
        );
        let Some(spend) = spend else {
            refuse_response(&response, "a count is past the wire's range");
            continue;
        };
        requests.push(SessionlessRequest {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id,
            occurred_at: observed_instant(response.observed_at_ms),
            processing_region: processing_region.clone(),
            spend,
        });
        charged.push(response);
    }
    if requests.is_empty() {
        return;
    }
    match repricing.sessionless_requests_held(requests).await {
        Ok(()) => {
            for response in &charged {
                response.log_read_for_price();
            }
        }
        Err(error) => {
            tracing::warn!(
                error = &*error as &(dyn std::error::Error + 'static),
                "an account's spend outside any session could not be written"
            );
            for response in &charged {
                refuse_response(response, "its account's spend could not be written");
            }
        }
    }
}

// The instant `observed_at_ms`, in Unix milliseconds, names; now where it is zero, a record that
// carries no time.
fn observed_instant(observed_at_ms: u64) -> WireInstant {
    i64::try_from(observed_at_ms)
        .ok()
        .filter(|observed_at_ms| *observed_at_ms > 0)
        .and_then(|observed_at_ms| jiff::Timestamp::from_millisecond(observed_at_ms).ok())
        .and_then(WireInstant::from_timestamp)
        .unwrap_or_else(WireInstant::now)
}

// Pushes `bucket` onto `session_id`'s queue as one hand-over, each placed at `placed`; answers
// its thread where it was placed off the stream.
fn push_bucket(
    service: &CodexService,
    session_id: SessionId,
    bucket: Vec<CodexKeptResponse>,
    placed: Option<&CodexOffStreamPlacement>,
) -> Option<CodexOffStreamThread> {
    let off_stream = placed.and_then(|placed| {
        let first = bucket.first()?;
        Some(CodexOffStreamThread {
            session_id,
            thread_id: first.response.conversation_id.clone(),
            placed: placed.clone(),
            observed_at_ms: bucket
                .iter()
                .map(|kept| kept.response.observed_at_ms)
                .max()
                .unwrap_or_default(),
        })
    });
    let exported = bucket
        .into_iter()
        .map(|kept| CodexExportedResponse {
            response: kept.response,
            placed: placed.cloned(),
            rollout: None,
        })
        .collect();
    push_exported_responses(service, session_id, exported);
    off_stream
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
