//! The drain of the export register's hand-off, which only routes: each completed response taken
//! to the session holding its thread on its own launch, to the session its launch streamed it for
//! before the thread moved to another launch, or to its copy's ledger; a response on a thread
//! another launch streams that its own launch never did is refused; anything that waits on Codex
//! (a walk off the stream, a retry of kept responses, an ended copy's filing, a read of the
//! launch's rollout files while its export is absent) goes to the work queue of its own launch,
//! whose task runs it, so one launch's hang stalls no other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::copy_threads::CodexEndedCopy;
use crate::driver::codex::telemetry::exports::{
    CODEX_EXPORT_HAND_OFF_DEPTH, CodexDueCopies, CodexExports,
};
use crate::driver::codex::telemetry::held_responses::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::placement::{
    CodexLaunchPlacement, bucket_off_stream, place_bucket, refuse_response, take_kept_buckets,
};
use crate::driver::codex::telemetry::rollouts::{
    CodexLaunchRollouts, CodexRolloutFallback, CodexStatusTurn,
};

// Why a response whose placement the daemon's stop abandoned was refused.
const STOPPED: &str = "the daemon stopped before its thread could be placed";

// What the reader hands the drain, each with the service that ran it and its launch's placement
// state: one completed response of the export numbered `export_number`, or, after that export's
// responses, a retry of the responses the launch kept before it; or what the register hands it as
// the launch settles a request turn, with the launch's rollout fallback's handles.
pub(super) enum CodexExportItem {
    Response {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        response: Box<CodexCompletedResponse>,
        arrived_at: Instant,
        export_number: u64,
    },
    Retry {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        export_number: u64,
    },
    Settled {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        rollouts: CodexLaunchRollouts,
    },
}

// The work a launch's own task runs.
enum CodexLaunchWork {
    Place {
        response: Box<CodexCompletedResponse>,
        arrived_at: Instant,
        export_number: u64,
    },
    Retry {
        export_number: u64,
    },
    FileCopies(Vec<CodexEndedCopy>),
    Settled(CodexLaunchRollouts),
}

impl CodexLaunchWork {
    // Refuses each response the work carries, naming its thread and `reason`; a retry carries
    // none, since its launch keeps what it retries.
    fn refuse(self, reason: &str) {
        match self {
            Self::Place { response, .. } => refuse_response(&response, reason),
            Self::Retry { .. } | Self::Settled(_) => {}
            Self::FileCopies(copies) => {
                for response in copies.iter().flat_map(|copy| &copy.unclaimed) {
                    refuse_response(response, reason);
                }
            }
        }
    }
}

// A launch's work queue, and its placement state, whose drop ends the queue.
struct CodexLaunchWorker {
    launch: Weak<Mutex<CodexLaunchPlacement>>,
    work: mpsc::Sender<CodexLaunchWork>,
}

/// The drain of the register's hand-off, which routes each completed response to the session it
/// belongs to and hands what waits on Codex to its launch's own task, until the register stops.
pub(crate) struct CodexExportDrain {
    pub(super) register: Weak<CodexExports>,
    pub(super) items: mpsc::Receiver<CodexExportItem>,
    pub(super) copies_ended: Arc<Notify>,
    pub(super) stop: CancellationToken,
}

impl CodexExportDrain {
    /// Routes each handed-off response and files each ended copy when due, each launch's work on
    /// a task of `tasks`, until the register stops; then refuses each response left in the
    /// hand-off, naming its thread.
    pub(crate) async fn run(mut self, tasks: TaskTracker) {
        let mut workers: HashMap<usize, CodexLaunchWorker> = HashMap::new();
        loop {
            let next_due = self
                .register
                .upgrade()
                .and_then(|register| register.next_copy_due());
            let copy_due = async {
                match next_due {
                    Some(due_at) => tokio::time::sleep_until(due_at).await,
                    None => std::future::pending().await,
                }
            };
            let item = tokio::select! {
                biased;
                () = self.stop.cancelled() => break,
                item = self.items.recv() => item,
                // A copy's read ended, so the next copy due may be sooner.
                () = self.copies_ended.notified() => continue,
                () = copy_due => {
                    let due = self
                        .register
                        .upgrade()
                        .map(|register| register.take_due_copies(Instant::now()))
                        .unwrap_or_default();
                    for CodexDueCopies { service, launch, copies } in due {
                        let work = CodexLaunchWork::FileCopies(copies);
                        self.hand_to_launch(&mut workers, &tasks, &service, &launch, work);
                    }
                    continue;
                }
            };
            // The register holds the sender, so its drop ends the drain too.
            let Some(item) = item else {
                return;
            };
            if let Some((service, launch, work)) = self.route(item) {
                self.hand_to_launch(&mut workers, &tasks, &service, &launch, work);
            }
        }
        self.items.close();
        while let Ok(item) = self.items.try_recv() {
            if let CodexExportItem::Response { response, .. } = item {
                refuse_response(&response, STOPPED);
            }
        }
    }

    // Routes `item`: a response on a thread a session of its service holds goes onto that
    // session's queue, one on a thread another live launch streams to the session its own service
    // released the thread from, else refused, one on a copy's thread to the copy's ledger; any
    // other, and a retry, is answered as work for its launch. A response whose service or launch
    // is gone is refused.
    fn route(
        &self,
        item: CodexExportItem,
    ) -> Option<(
        Weak<CodexService>,
        Weak<Mutex<CodexLaunchPlacement>>,
        CodexLaunchWork,
    )> {
        match item {
            CodexExportItem::Response {
                service,
                launch,
                response,
                arrived_at,
                export_number,
            } => {
                let Some(live_service) = service.upgrade() else {
                    refuse_response(&response, "the service that sent it has ended");
                    return None;
                };
                if let Some(session_id) = live_service.session_of_thread(&response.conversation_id)
                {
                    let exported = CodexExportedResponse {
                        response: *response,
                        arrived_at,
                        placed: None,
                        rollout: None,
                    };
                    push_exported_response(&live_service, session_id, exported);
                    return None;
                }
                let others = self
                    .register
                    .upgrade()
                    .map(|register| live_services(&register))
                    .unwrap_or_default();
                if others
                    .iter()
                    .any(|other| other.session_of_thread(&response.conversation_id).is_some())
                {
                    deliver_moved(&live_service, &others, *response, arrived_at);
                    return None;
                }
                let Some(live_launch) = launch.upgrade() else {
                    refuse_response(&response, "the launch that sent it has ended");
                    return None;
                };
                // A copy's thread claims against the copy's own stream.
                let response = Box::new(lock(&live_launch).copies().offer(*response)?);
                let work = CodexLaunchWork::Place {
                    response,
                    arrived_at,
                    export_number,
                };
                Some((service, launch, work))
            }
            CodexExportItem::Retry {
                service,
                launch,
                export_number,
            } => Some((service, launch, CodexLaunchWork::Retry { export_number })),
            CodexExportItem::Settled {
                service,
                launch,
                rollouts,
            } => Some((service, launch, CodexLaunchWork::Settled(rollouts))),
        }
    }

    // Hands `work` to the queue of `launch`, starting its task on `tasks` where none runs; a full
    // queue refuses what the work carries. The queues of launches that are gone are let go here,
    // which ends their tasks.
    fn hand_to_launch(
        &self,
        workers: &mut HashMap<usize, CodexLaunchWorker>,
        tasks: &TaskTracker,
        service: &Weak<CodexService>,
        launch: &Weak<Mutex<CodexLaunchPlacement>>,
        work: CodexLaunchWork,
    ) {
        workers.retain(|_key, worker| worker.launch.strong_count() > 0);
        let worker = workers.entry(launch.as_ptr() as usize).or_insert_with(|| {
            // As deep as the hand-off, so one export's responses all fit.
            let (sender, receiver) = mpsc::channel(CODEX_EXPORT_HAND_OFF_DEPTH);
            tasks.spawn(run_launch_work(
                Weak::clone(service),
                Weak::clone(launch),
                receiver,
                self.stop.clone(),
            ));
            CodexLaunchWorker {
                launch: Weak::clone(launch),
                work: sender,
            }
        });
        match worker.work.try_send(work) {
            Ok(()) => {}
            Err(TrySendError::Full(work)) => work.refuse("its launch's placement work is full"),
            Err(TrySendError::Closed(work)) => work.refuse(STOPPED),
        }
    }
}

// What wakes a launch's task: its next work, or its export status turning.
enum CodexLaunchEvent {
    Work(Option<CodexLaunchWork>),
    Status(CodexStatusTurn),
}

// Runs one launch's work in order until its queue ends or the daemon stops; each piece is raced
// against the stop, and whatever the stop abandons, and what is left in the queue, is refused,
// naming its thread. Work whose service or launch is gone is refused. From the launch's first
// settled request turn on, the task also owns its rollout fallback, which reads while the export
// status reads stopped: once as it turns stopped and at each settled request turn.
async fn run_launch_work(
    service: Weak<CodexService>,
    launch: Weak<Mutex<CodexLaunchPlacement>>,
    mut work: mpsc::Receiver<CodexLaunchWork>,
    stop: CancellationToken,
) {
    let mut fallback: Option<CodexRolloutFallback> = None;
    loop {
        let status_turned = async {
            match fallback.as_mut() {
                Some(fallback) => fallback.status_turned().await,
                None => std::future::pending().await,
            }
        };
        let event = tokio::select! {
            biased;
            () = stop.cancelled() => break,
            next = work.recv() => CodexLaunchEvent::Work(next),
            turn = status_turned => CodexLaunchEvent::Status(turn),
        };
        let next = match event {
            CodexLaunchEvent::Work(next) => next,
            CodexLaunchEvent::Status(turn) => {
                match turn {
                    CodexStatusTurn::Stopped => {
                        if let Some(fallback) = fallback.as_mut() {
                            fallback.start_reading();
                        }
                    }
                    CodexStatusTurn::Arriving => {
                        if let Some(fallback) = fallback.as_mut() {
                            fallback.stop_reading();
                        }
                        continue;
                    }
                    CodexStatusTurn::Gone => {
                        fallback = None;
                        continue;
                    }
                }
                let (Some(service), Some(fallback)) = (service.upgrade(), fallback.as_mut()) else {
                    continue;
                };
                tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    () = fallback.pass(&service) => {}
                }
                continue;
            }
        };
        let Some(next) = next else {
            return;
        };
        let Some((service, launch)) = service.upgrade().zip(launch.upgrade()) else {
            next.refuse("the launch that sent it has ended");
            continue;
        };
        match next {
            CodexLaunchWork::Settled(rollouts) => {
                let fallback = fallback.get_or_insert_with(|| CodexRolloutFallback::new(rollouts));
                if fallback.is_reading() {
                    tokio::select! {
                        biased;
                        () = stop.cancelled() => break,
                        () = fallback.pass(&service) => {}
                    }
                }
            }
            CodexLaunchWork::Place {
                response,
                arrived_at,
                export_number,
            } => {
                if let Some(bucket) =
                    bucket_off_stream(&launch, *response, arrived_at, export_number)
                {
                    let refusal = bucket.refusal();
                    tokio::select! {
                        biased;
                        () = stop.cancelled() => {
                            refusal.refuse(STOPPED);
                            break;
                        }
                        () = place_bucket(&service, &launch, bucket) => {}
                    }
                }
            }
            CodexLaunchWork::Retry { export_number } => {
                let mut buckets = take_kept_buckets(&launch, export_number).into_iter();
                while let Some(bucket) = buckets.next() {
                    let refusal = bucket.refusal();
                    tokio::select! {
                        biased;
                        () = stop.cancelled() => {
                            refusal.refuse(STOPPED);
                            for bucket in buckets {
                                bucket.refusal().refuse(STOPPED);
                            }
                            break;
                        }
                        () = place_bucket(&service, &launch, bucket) => {}
                    }
                }
            }
            CodexLaunchWork::FileCopies(copies) => {
                if !file_copies(&service, copies, &stop).await {
                    break;
                }
            }
        }
    }
    work.close();
    while let Ok(left) = work.try_recv() {
        left.refuse(STOPPED);
    }
}

// Files, as its session's own, each response a copy due now never stated on its stream, each
// filing raced against the stop; answers `false` where the stop came first, every response not
// yet filed then refused.
async fn file_copies(
    service: &CodexService,
    copies: Vec<CodexEndedCopy>,
    stop: &CancellationToken,
) -> bool {
    let mut unfiled = copies.into_iter().flat_map(|copy| {
        let CodexEndedCopy {
            filing,
            folder,
            unclaimed,
        } = copy;
        unclaimed
            .into_iter()
            .map(move |response| (filing.clone(), folder.clone(), response))
    });
    while let Some((mut filing, folder, response)) = unfiled.next() {
        tokio::select! {
            biased;
            () = stop.cancelled() => {
                refuse_response(&response, STOPPED);
                for (_filing, _folder, response) in unfiled {
                    refuse_response(&response, STOPPED);
                }
                return false;
            }
            () = filing.file(response.meter(), service, &folder) => {
                response.log_read_for_price();
            }
        }
    }
    true
}

// Every live service a launch of `register` started, each once, taken out of its lock.
fn live_services(register: &CodexExports) -> Vec<Arc<CodexService>> {
    let mut services: Vec<Arc<CodexService>> = Vec::new();
    for (service, _placement) in register.placements() {
        if let Some(service) = service.upgrade()
            && !services.iter().any(|kept| Arc::ptr_eq(kept, &service))
        {
            services.push(service);
        }
    }
    services
}

// Files `response`, on a thread another of `services` streams now, on the session `service`, its
// own launch's, streamed it for before releasing it, through the first of `services` that
// session is attached to; one on a thread `service` never streamed, or whose session no service
// holds, is refused, naming its thread, so no other launch's session takes it.
fn deliver_moved(
    service: &CodexService,
    services: &[Arc<CodexService>],
    response: CodexCompletedResponse,
    arrived_at: Instant,
) {
    let Some(session_id) = service.former_session_of_thread(&response.conversation_id) else {
        refuse_response(
            &response,
            "another launch streams its thread and its own launch never did",
        );
        return;
    };
    let attached = services.iter().find(|service| {
        service
            .attached_sessions()
            .iter()
            .any(|queue| queue.session_id() == session_id)
    });
    let exported = CodexExportedResponse {
        response,
        arrived_at,
        placed: Some(CodexOffStreamPlacement::Released),
        rollout: None,
    };
    match attached {
        Some(attached) => push_exported_response(attached, session_id, exported),
        None => refuse_response(
            &exported.response,
            "the session its launch streamed it for is attached to no service",
        ),
    }
}

/// Pushes `exported` onto `session_id`'s queue on `service`; one no session takes is refused,
/// naming its thread.
pub(crate) fn push_exported_response(
    service: &CodexService,
    session_id: SessionId,
    exported: CodexExportedResponse,
) {
    let response = exported.response.clone();
    if !service.push_session_item(&session_id, CodexSessionInbound::ExportedResponse(exported)) {
        refuse_response(&response, "no session took it");
    }
}
