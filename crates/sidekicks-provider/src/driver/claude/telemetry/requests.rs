//! One Claude Code process's exported requests held until its own figure could have stated them:
//! a request with an `api_request` record is inside the figure of the `result` that follows it, so
//! it is let go; one with only its span is a helper request the figure leaves out, priced once
//! its turn's `result` and two export intervals after its arrival have passed. At the process's
//! end every request is decided at once: a record no `result` followed is priced, unless a
//! message its stream showed after the last `result` is its twin, and a lone span is priced.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use tokio::time::Instant;

use crate::driver::claude::telemetry::records::{
    ClaudeExportedRequest, ClaudeInteraction, ClaudeRequestSource,
};
use crate::pricing::export_status::INTERVALS_WAITED;
use crate::usage_delta_accountant::UsageAxisCounts;

/// How many requests one process holds undecided; past it the requests of the turns already
/// closed are decided at once, else the oldest is dropped unpriced.
pub(crate) const OPEN_REQUESTS_KEPT: usize = 10_000;

// How many messages the stream showed since the last `result` are kept as twins of records no
// `result` states; past it the oldest goes, and its record is priced at the process's end.
const STREAMED_KEPT: usize = 256;

// How many interactions' sequences are kept for the cross-check.
const INTERACTIONS_KEPT: usize = 64;

// A model id as a usage row carries it.
type ModelId = FreeFormText<EVENT_FIELD_MAX_LEN>;

/// A request decided for its price.
#[derive(Debug)]
pub(crate) struct ClaudeHelperRequest {
    /// What prices it: its record's facts where it has one, else its span's.
    pub(crate) request: ClaudeExportedRequest,
    /// When it began, its span's start where it has one, in Unix milliseconds.
    pub(crate) started_at_ms: u64,
    /// The region the process's last streamed message named, `None` for no region.
    pub(crate) region: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    /// The sequence its interaction's span named, where it arrived.
    pub(crate) sequence: Option<u64>,
    /// How many of the process's turns had ended when it began.
    pub(crate) turns_before: u64,
}

// One request undecided: its record and span as each arrived, and when the first arrived.
struct OpenRequest {
    order: u64,
    record: Option<ClaudeExportedRequest>,
    span: Option<ClaudeExportedRequest>,
    arrived_at: Instant,
}

impl OpenRequest {
    // When it ended, by the latest of its record and span.
    fn ended_at_ms(&self) -> u64 {
        self.record
            .iter()
            .chain(&self.span)
            .map(|request| request.ended_at_ms)
            .max()
            .unwrap_or(0)
    }
}

// One lead `result` the process wrote: when, by the wall clock and the runtime's, and how many
// came before it.
struct StatedResult {
    at_ms: u64,
    at: Instant,
    ordinal: u64,
}

/// One process's undecided requests, the `result`s that may state them, the messages its stream
/// showed since its last `result`, and the region its last message named.
pub(crate) struct ClaudeProcessRequests {
    export_interval: Duration,
    open: HashMap<String, OpenRequest>,
    next_order: u64,
    results: VecDeque<StatedResult>,
    results_stated: u64,
    streamed: VecDeque<(ModelId, [u64; 4])>,
    region: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    interactions: VecDeque<ClaudeInteraction>,
    made_request_since: Option<Instant>,
    is_overflow_logged: bool,
}

impl ClaudeProcessRequests {
    /// The requests of a process exporting every `export_interval`.
    pub(crate) fn new(export_interval: Duration) -> Self {
        Self {
            export_interval,
            open: HashMap::new(),
            next_order: 0,
            results: VecDeque::new(),
            results_stated: 0,
            streamed: VecDeque::new(),
            region: None,
            interactions: VecDeque::new(),
            made_request_since: None,
            is_overflow_logged: false,
        }
    }

    /// The process's stream showed a message on `model_id` with `counts` in `region` at `now`:
    /// kept as the twin of a record no `result` will state, and its region kept for the helper
    /// requests priced from here on.
    pub(crate) fn streamed(
        &mut self,
        model_id: Option<&ModelId>,
        counts: &UsageAxisCounts,
        region: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
        now: Instant,
    ) {
        self.region = region;
        if self.made_request_since.is_none() {
            self.made_request_since = Some(now);
        }
        if let Some(model_id) = model_id {
            if self.streamed.len() >= STREAMED_KEPT {
                self.streamed.pop_front();
            }
            self.streamed
                .push_back((model_id.clone(), twin_counts(counts)));
        }
    }

    /// The process wrote a lead `result` at `at_ms` by the wall clock and `at` by the runtime's,
    /// stating every request that ended before it; answers since when the turn it ends streamed a
    /// message with usage, `None` where it streamed none.
    pub(crate) fn result_stated(&mut self, at_ms: u64, at: Instant) -> Option<Instant> {
        self.results.push_back(StatedResult {
            at_ms,
            at,
            ordinal: self.results_stated,
        });
        self.results_stated += 1;
        self.streamed.clear();
        self.made_request_since.take()
    }

    /// Keeps the sequence of an interaction for the cross-check of the requests it held.
    pub(crate) fn interaction(&mut self, interaction: ClaudeInteraction) {
        if self.interactions.len() >= INTERACTIONS_KEPT {
            self.interactions.pop_front();
        }
        self.interactions.push_back(interaction);
    }

    /// Holds `request` beside its twin from the other signal, arrived at `now`; answers the
    /// requests a full hold decides at once.
    pub(crate) fn take(
        &mut self,
        request: ClaudeExportedRequest,
        now: Instant,
    ) -> Vec<ClaudeHelperRequest> {
        let decided = if self.open.contains_key(&request.request_id) {
            Vec::new()
        } else {
            self.make_room()
        };
        let order = self.next_order;
        let open = self
            .open
            .entry(request.request_id.clone())
            .or_insert_with(|| OpenRequest {
                order,
                record: None,
                span: None,
                arrived_at: now,
            });
        if open.order == order {
            self.next_order += 1;
        }
        match request.source {
            ClaudeRequestSource::Record => open.record = Some(request),
            ClaudeRequestSource::Span => open.span = Some(request),
        }
        decided
    }

    /// Decides every request whose turn's `result` and two export intervals after its own
    /// arrival have passed by `now`: one with a record is let go, and one with its span alone is
    /// answered for its price.
    pub(crate) fn take_due(&mut self, now: Instant) -> Vec<ClaudeHelperRequest> {
        let wait = self.export_interval * INTERVALS_WAITED;
        let results = &self.results;
        let due: Vec<String> = self
            .open
            .iter()
            .filter(|(_, open)| {
                stating_result(results, open.ended_at_ms())
                    .is_some_and(|result| now >= result.at.max(open.arrived_at) + wait)
            })
            .map(|(request_id, _)| request_id.clone())
            .collect();
        let decided = self.decide_stated(&due);
        self.forget_old_results();
        decided
    }

    /// Decides every request at the process's end: a record a `result` stated is let go, one no
    /// `result` stated is priced unless a message the stream showed since the last `result` is
    /// its twin, and a lone span is priced.
    pub(crate) fn take_all(&mut self) -> Vec<ClaudeHelperRequest> {
        let mut opens: Vec<OpenRequest> = self.open.drain().map(|(_, open)| open).collect();
        opens.sort_by_key(|open| open.order);
        let mut decided = Vec::new();
        for open in opens {
            let is_priced = match &open.record {
                None => true,
                Some(record) => {
                    stating_result(&self.results, open.ended_at_ms()).is_none()
                        && !self.claim_twin(&record.model_id, &record.counts)
                }
            };
            if is_priced {
                decided.push(self.helper(open));
            }
        }
        self.results.clear();
        decided
    }

    // Decides each of `request_ids`, each stated by a `result`: a record is let go, a lone span
    // answered for its price.
    fn decide_stated(&mut self, request_ids: &[String]) -> Vec<ClaudeHelperRequest> {
        let mut opens: Vec<OpenRequest> = request_ids
            .iter()
            .filter_map(|request_id| self.open.remove(request_id))
            .collect();
        opens.sort_by_key(|open| open.order);
        opens
            .into_iter()
            .filter(|open| open.record.is_none())
            .map(|open| self.helper(open))
            .collect()
    }

    // Makes room for one more request when the hold is full: the requests of the turns already
    // closed are decided at once, logged once per process; with none closed, the oldest is
    // dropped unpriced and logged with its request id.
    fn make_room(&mut self) -> Vec<ClaudeHelperRequest> {
        if self.open.len() < OPEN_REQUESTS_KEPT {
            return Vec::new();
        }
        let results = &self.results;
        let closed: Vec<String> = self
            .open
            .iter()
            .filter(|(_, open)| stating_result(results, open.ended_at_ms()).is_some())
            .map(|(request_id, _)| request_id.clone())
            .collect();
        if !closed.is_empty() {
            if !self.is_overflow_logged {
                self.is_overflow_logged = true;
                tracing::warn!(
                    held = self.open.len(),
                    "a claude code process holds its most exported requests; its closed turns' \
                     requests are decided at once"
                );
            }
            return self.decide_stated(&closed);
        }
        let oldest = self
            .open
            .iter()
            .min_by_key(|(_, open)| open.order)
            .map(|(request_id, _)| request_id.clone());
        if let Some(request_id) = oldest {
            self.open.remove(&request_id);
            tracing::warn!(
                request_id = request_id.as_str(),
                "a claude code process holds its most exported requests with no turn closed; \
                 its oldest is dropped unpriced"
            );
        }
        Vec::new()
    }

    // The decided request `open`, priced from its record where it has one, else its span, begun
    // at its span's start where it has one.
    fn helper(&self, open: OpenRequest) -> ClaudeHelperRequest {
        let OpenRequest { record, span, .. } = open;
        let started_at_ms = span
            .as_ref()
            .or(record.as_ref())
            .map_or(0, |request| request.started_at_ms);
        let trace_id = span.as_ref().map(|span| span.trace_id.clone());
        let request = record
            .or(span)
            .expect("an open request holds its record or its span");
        let sequence = trace_id.and_then(|trace_id| {
            self.interactions
                .iter()
                .rev()
                .find(|interaction| interaction.trace_id == trace_id)
                .map(|interaction| interaction.sequence)
        });
        // The `result`s before the oldest one kept all came before the request began.
        let turns_before = self
            .results
            .iter()
            .rev()
            .find(|result| result.at_ms <= started_at_ms)
            .map_or_else(
                || {
                    self.results
                        .front()
                        .map_or(self.results_stated, |result| result.ordinal)
                },
                |result| result.ordinal + 1,
            );
        ClaudeHelperRequest {
            request,
            started_at_ms,
            region: self.region.clone(),
            sequence,
            turns_before,
        }
    }

    // Takes the oldest message the stream showed on `model_id` with `counts`; answers whether one
    // was there.
    fn claim_twin(&mut self, model_id: &ModelId, counts: &UsageAxisCounts) -> bool {
        let counts = twin_counts(counts);
        let Some(index) = self.streamed.iter().position(|(streamed_model, streamed)| {
            streamed_model == model_id && *streamed == counts
        }) else {
            return false;
        };
        self.streamed.remove(index);
        true
    }

    // Forgets every `result` older than the one stating the oldest undecided request, and all of
    // them once none is undecided.
    fn forget_old_results(&mut self) {
        let Some(oldest_end) = self.open.values().map(OpenRequest::ended_at_ms).min() else {
            self.results.clear();
            return;
        };
        while self
            .results
            .front()
            .is_some_and(|result| result.at_ms < oldest_end)
        {
            self.results.pop_front();
        }
    }
}

// The first `result` written at or after `ended_at_ms`, the one stating a request that ended
// then.
fn stating_result(results: &VecDeque<StatedResult>, ended_at_ms: u64) -> Option<&StatedResult> {
    results.iter().find(|result| result.at_ms >= ended_at_ms)
}

// The four counts a message and its record share, an absent count reading as zero.
fn twin_counts(counts: &UsageAxisCounts) -> [u64; 4] {
    [
        counts.input,
        counts.cached_input,
        counts.cache_write_input,
        counts.output,
    ]
    .map(|count| count.unwrap_or(0))
}
