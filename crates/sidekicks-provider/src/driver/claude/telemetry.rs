//! Claude Code's telemetry export read for price: the register of each session process's export,
//! its export status, the reader the receiver hands each export, and the filing of the requests
//! Claude Code's own figure leaves out on the run that held the session's turn when each began.
//!
//! Every request with an `api_request` record is inside the `costUSD` of the `result` after it,
//! which the stream prices, so the export prices only a request with its span alone (the
//! client-side auto-mode check) and a record no `result` states (a call after the process's last
//! `result`). A record or span naming another session than its process's is refused and counted,
//! and an export of a process no session holds is passed over, since its own `result` prices it.

mod records;
mod requests;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, ready};
use serde_json::Map;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::unix_time::read_unix_time_ms;
use tokio::time::Instant;
use tokio_util::task::TaskTracker;

use self::records::{
    CLAUDE_EXPORT, ClaudeExportedRequest, read_claude_record_requests, read_claude_span_requests,
};
use self::requests::{ClaudeHelperRequest, ClaudeProcessRequests, OPEN_REQUESTS_KEPT};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::pricing::{ClaudeResultPricing, price_claude_rows, record_for_price};
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};
use crate::pricing::export_status::ExportStatusTracker;
use crate::pricing::live::LivePricing;
use crate::pricing::receiver::bearers::TelemetryHolderId;
use crate::pricing::receiver::records::RecordRefusal;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader};
use crate::usage_delta_accountant::{MeteredUsageDelta, UsageRequestFacts, meter_from_zero};

/// Claude Code's log and trace batch interval, which every process's settings document sets.
pub(crate) const CLAUDE_EXPORT_INTERVAL: Duration = Duration::from_secs(1);

/// The driver's register of its session processes' exports, by the holder each process's token
/// was minted for, and what files the requests it decides.
pub(crate) struct ClaudeExports {
    scheduler: Arc<Scheduler>,
    usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    pricing: Arc<LivePricing>,
    // Held only to look up, add or take out a process, never across an await.
    processes: Mutex<HashMap<TelemetryHolderId, Arc<ClaudeProcessExport>>>,
    // Each filing run off a read export or a reaped process, waited out at the daemon's stop.
    filings: TaskTracker,
    // Whether the daemon stops, held while a filing is spawned so none starts past the stop's wait.
    is_stopping: Mutex<bool>,
}

/// One session process's export: the session it runs, the routes its turns are held on, the
/// account it runs on, its export status and its undecided requests.
pub(crate) struct ClaudeProcessExport {
    session_id: SessionId,
    provider_session_id: String,
    routes: Arc<ClaudeRunRoutes>,
    account: ClaudeProcessAccount,
    tracker: ExportStatusTracker,
    // Held only to read or change the requests, never across an await.
    requests: Mutex<ClaudeProcessRequests>,
}

/// A session process's place in the register while it lives; its drop decides what a process
/// its session's task never ended still holds.
pub(crate) struct ClaudeExportRegistration {
    exports: Weak<ClaudeExports>,
    holder: TelemetryHolderId,
}

impl Drop for ClaudeExportRegistration {
    fn drop(&mut self) {
        if let Some(exports) = self.exports.upgrade() {
            exports.reap(self.holder);
        }
    }
}

impl ClaudeExports {
    /// A register whose processes' export checks run on `scheduler`, filing through `usage` and
    /// pricing through `pricing`.
    pub(crate) fn new(
        scheduler: Arc<Scheduler>,
        usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
        pricing: Arc<LivePricing>,
    ) -> Self {
        Self {
            scheduler,
            usage,
            pricing,
            processes: Mutex::default(),
            filings: TaskTracker::new(),
            is_stopping: Mutex::new(false),
        }
    }

    /// The live pricing every Claude request is priced through.
    pub(crate) fn pricing(&self) -> &Arc<LivePricing> {
        &self.pricing
    }

    /// Registers `holder`, the process running `provider_session_id` for `session_id` on
    /// `account` with its turns held on `routes`, with a fresh export status, until the
    /// registration answered drops.
    pub(crate) fn register(
        self: &Arc<Self>,
        holder: TelemetryHolderId,
        session_id: SessionId,
        provider_session_id: String,
        routes: Arc<ClaudeRunRoutes>,
        account: ClaudeProcessAccount,
    ) -> ClaudeExportRegistration {
        let process = Arc::new(ClaudeProcessExport {
            session_id,
            provider_session_id,
            routes,
            account,
            tracker: ExportStatusTracker::new(Arc::clone(&self.scheduler), CLAUDE_EXPORT_INTERVAL),
            requests: Mutex::new(ClaudeProcessRequests::new(
                CLAUDE_EXPORT_INTERVAL,
                OPEN_REQUESTS_KEPT,
            )),
        });
        lock(&self.processes).insert(holder, process);
        ClaudeExportRegistration {
            exports: Arc::downgrade(self),
            holder,
        }
    }

    /// Stops filing as the daemon stops, since its stream prices nothing from then on either, and
    /// waits out the filings already running.
    pub(crate) async fn stop(&self) {
        // The lock is let go in its own block, so the wait holds none.
        {
            let mut is_stopping = lock(&self.is_stopping);
            *is_stopping = true;
            self.filings.close();
        }
        self.filings.wait().await;
    }

    // The registered process of `holder`.
    fn process(&self, holder: TelemetryHolderId) -> Option<Arc<ClaudeProcessExport>> {
        lock(&self.processes).get(&holder).cloned()
    }

    /// `holder`'s stream showed a frame of a message metered as `delta`: its message is kept as
    /// the twin of a record no `result` states, and its region for the helper requests priced
    /// after it.
    pub(crate) fn streamed(&self, holder: TelemetryHolderId, delta: &MeteredUsageDelta) {
        if let Some(process) = self.process(holder) {
            lock(&process.requests).streamed(
                delta.request.request_key.as_ref().map(BoundedText::as_str),
                delta.request.model_id.as_ref(),
                &delta.axis_deltas,
                delta.request.processing_region.clone(),
                Instant::now(),
            );
        }
    }

    /// `holder` wrote a lead `result` now: the requests that ended before it are stated by it, and
    /// its export status takes the turn it ends, which made a request where it streamed usage.
    pub(crate) fn result_stated(&self, holder: TelemetryHolderId) {
        let Some(process) = self.process(holder) else {
            return;
        };
        let now = Instant::now();
        let made_request_since = lock(&process.requests).result_stated(read_unix_time_ms(), now);
        let settled = process.tracker.turn_settled(
            made_request_since.is_some(),
            made_request_since.unwrap_or(now),
        );
        if let Err(error) = settled {
            // Only a stopped scheduler refuses, and the daemon is stopping with it.
            tracing::debug!(
                error = &error as &(dyn Error + 'static),
                "a claude code process's export check could not be armed"
            );
        }
    }

    /// `holder` ended and its session's task read its last frame: every request it holds is
    /// decided now and, where `is_filed`, filed, then its session's turn holdings are released; a
    /// stopping daemon files none, as its stream prices none.
    pub(crate) async fn process_ended(&self, holder: TelemetryHolderId, is_filed: bool) {
        let Some(process) = lock(&self.processes).remove(&holder) else {
            return;
        };
        let decided = lock(&process.requests).take_all();
        if is_filed {
            file(&self.usage, &self.pricing, &process, decided).await;
        }
        process.routes.release_turn_holdings(process.session_id);
    }

    // Decides `holder`'s requests where its session's task never ended it: what it holds, by the
    // exports read so far, is filed and its turn holdings released on a filing of its own.
    fn reap(&self, holder: TelemetryHolderId) {
        let Some(process) = lock(&self.processes).remove(&holder) else {
            return;
        };
        let decided = lock(&process.requests).take_all();
        self.file_later(process, decided, true);
    }

    // Reads one export of `holder`'s process: its export status marked arriving, each request it
    // states held, each that names another session refused, and those now due filed off the
    // receiver's answer.
    fn read_export(&self, holder: TelemetryHolderId, export: &TelemetryExport) {
        let Some(process) = self.process(holder) else {
            tracing::debug!(
                holder = holder.number(),
                "an export of a claude code process no session holds is passed over; its own \
                 result prices its requests"
            );
            return;
        };
        process.tracker.export_arrived();
        let account = process.account.read();
        let mut exported = Vec::new();
        let mut interactions = Vec::new();
        match export {
            TelemetryExport::Logs(request) => {
                for resource_logs in &request.resource_logs {
                    exported.extend(read_claude_record_requests(resource_logs, account.as_ref()));
                }
            }
            TelemetryExport::Traces(request) => {
                for resource_spans in &request.resource_spans {
                    let (requests, read) =
                        read_claude_span_requests(resource_spans, account.as_ref());
                    exported.extend(requests);
                    interactions.extend(read);
                }
            }
        }
        let now = Instant::now();
        let decided = {
            let mut requests = lock(&process.requests);
            for interaction in interactions {
                requests.interaction(interaction);
            }
            let mut decided = Vec::new();
            for request in exported {
                if request.session_id == process.provider_session_id {
                    decided.extend(requests.take(request, now));
                } else {
                    refuse_other_session(&request, account.as_ref());
                }
            }
            decided.extend(requests.take_due(now));
            decided
        };
        if !decided.is_empty() {
            self.file_later(process, decided, false);
        }
    }

    // Files `decided` on a filing of its own, so neither the receiver's answer nor a drop waits on
    // a record, then, where `is_ended`, releases the process's session's turn holdings. Nothing is
    // filed once the daemon stops, nor with no runtime left to file on.
    fn file_later(
        &self,
        process: Arc<ClaudeProcessExport>,
        decided: Vec<ClaudeHelperRequest>,
        is_ended: bool,
    ) {
        let is_stopping = lock(&self.is_stopping);
        let runtime = tokio::runtime::Handle::try_current()
            .ok()
            .filter(|_| !*is_stopping);
        let Some(runtime) = runtime else {
            drop(is_stopping);
            tracing::debug!(
                requests = decided.len(),
                "a claude code process's decided requests are not filed as the daemon stops"
            );
            if is_ended {
                process.routes.release_turn_holdings(process.session_id);
            }
            return;
        };
        let (usage, pricing) = (Arc::clone(&self.usage), Arc::clone(&self.pricing));
        self.filings.spawn_on(
            async move {
                file(&usage, &pricing, &process, decided).await;
                if is_ended {
                    process.routes.release_turn_holdings(process.session_id);
                }
            },
            &runtime,
        );
    }
}

impl ClaudeProcessExport {
    // `helper` metered as one request on the session's thread and placed: on the helper's own run
    // where its agent has a child run, on the run that held the turn when it began, else as the
    // session's own on its latest run's binding. `None` for a request that spent nothing, or one
    // no binding of the session can carry, which is refused and counted.
    fn meter(&self, helper: ClaudeHelperRequest) -> Option<MeteredUsage> {
        let ClaudeHelperRequest {
            request,
            started_at_ms,
            region,
            ..
        } = helper;
        let helper_run = request.agent_id.as_deref().and_then(|agent_id| {
            let (_, route) = self.routes.child_route_for(self.session_id, agent_id)?;
            let owner = SubagentId::new(agent_id.to_owned())
                .map_or(MeteredUsageOwner::Run, MeteredUsageOwner::Helper);
            Some((route.binding_id, owner))
        });
        let (binding_id, owner) = match helper_run {
            Some((binding_id, owner)) => (Some(binding_id), owner),
            None => match self
                .routes
                .lead_run_at(self.session_id, started_at_ms)
                .filter(|_| !request.is_standalone)
            {
                Some(run) => (Some(run.binding_id), MeteredUsageOwner::Run),
                None => (
                    self.routes.latest_lead_binding(self.session_id),
                    MeteredUsageOwner::Session,
                ),
            },
        };
        // The account the process ran on as the request ended, whenever it is filed.
        let provider_account_id = self.account.read_at(request.ended_at_ms);
        let Some(binding_id) = binding_id else {
            RecordRefusal {
                field: "request_id",
                reason: "no binding of its session can carry it",
            }
            .report(
                DESCRIPTOR.provider_id(),
                provider_account_id.as_ref(),
                CLAUDE_EXPORT,
                request.source.wire_type(),
                Map::new(),
            );
            return None;
        };
        let facts = UsageRequestFacts {
            model_id: Some(request.model_id),
            request_key: BoundedText::new(request.request_id),
            speed: request.speed,
            processing_region: region,
            cache_write_extended_tokens: request.cache_write_extended_tokens,
            web_search_requests: None,
            thread_speed: None,
        };
        let delta = meter_from_zero(
            DESCRIPTOR.provider_id(),
            self.provider_session_id.clone(),
            request.counts,
            facts,
        );
        (!delta.is_unchanged()).then_some(MeteredUsage {
            session_id: self.session_id,
            binding_id,
            owner,
            delta,
            provider_account_id,
        })
    }
}

// Records each of `decided` on `process`'s session, on the run that held its turn when the
// request began, the helper's where a helper sent it, and the session's own where no run held
// it, then prices them from the price list. Nothing while no usage record is registered; a
// failed record is reported.
async fn file(
    usage: &PortRegistration<Arc<dyn UsageSink>>,
    live_pricing: &LivePricing,
    process: &ClaudeProcessExport,
    decided: Vec<ClaudeHelperRequest>,
) {
    let Some(sink) = usage.port() else {
        return;
    };
    let mut pricing = ClaudeResultPricing::default();
    for helper in decided {
        helper.request.log_read_for_price();
        if let Some(sequence) = helper.sequence
            && sequence != helper.turns_before + 1
        {
            tracing::debug!(
                request_id = helper.request.request_id.as_str(),
                sequence,
                turns_before = helper.turns_before,
                "a claude code request's interaction sequence names another turn than the time it \
             began; the time is kept"
            );
        }
        let Some(metered) = process.meter(helper) else {
            continue;
        };
        match record_for_price(&**sink, metered).await {
            Ok(Some(kept)) => pricing.keep(kept),
            Ok(None) => {}
            Err(error) => record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                process.session_id,
                "an exported request's usage",
                &*error,
            ),
        }
    }
    price_claude_rows(live_pricing, process.session_id, pricing.take_all()).await;
}

// Refuses and counts `request`, which names a session its process, on `provider_account_id`'s
// account, does not run: a process its token was not minted for exported under it.
fn refuse_other_session(
    request: &ClaudeExportedRequest,
    provider_account_id: Option<&ProviderAccountId>,
) {
    RecordRefusal {
        field: "session.id",
        reason: "it names a session the process its token was minted for does not run",
    }
    .report(
        DESCRIPTOR.provider_id(),
        provider_account_id,
        CLAUDE_EXPORT,
        request.source.wire_type(),
        Map::new(),
    );
    tracing::debug!(
        request_id = request.request_id.as_str(),
        "a claude code request naming another session was refused"
    );
}

impl TelemetryExportReader for ClaudeExports {
    fn read_telemetry_export(
        &self,
        holder: TelemetryHolderId,
        export: TelemetryExport,
    ) -> BoxFuture<'_, ()> {
        self.read_export(holder, &export);
        Box::pin(ready(()))
    }
}
