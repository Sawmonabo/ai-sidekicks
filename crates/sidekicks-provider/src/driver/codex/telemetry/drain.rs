//! The drain of the export register's hand-off, which only routes: each completed response taken
//! to the session holding its thread on its own launch, to the session its launch streamed it for
//! before the thread moved to another launch, or to its copy's filing; a response on a thread
//! another launch streams that its own launch never did is refused; anything that waits on Codex
//! (a walk off the stream, a retry of kept responses, a copy's filing, a read of the launch's
//! rollout files while its export is absent) goes to the work queue of its own launch, whose task
//! runs it, so one launch's hang stalls no other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::event::usage::UsageSightingSource;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::copy_threads::CodexCopyThread;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::exports::{CODEX_EXPORT_HAND_OFF_DEPTH, CodexExports};
use crate::driver::codex::telemetry::placement::{
    CodexLaunchPlacement, bucket_off_stream, place_bucket, refuse_response, take_kept_buckets,
};
use crate::driver::codex::telemetry::rollouts::fallback::{
    CodexFallbackDue, CodexLaunchRollouts, CodexRolloutFallback,
};
use crate::driver::codex::telemetry::sighting::compose_codex_sighting;

// Why a response whose placement the daemon's stop abandoned was refused.
const STOPPED: &str = "the daemon stopped before its thread could be placed";

// What the reader hands the drain, each with the service that ran it and its launch's placement
// state: the completed responses of the export numbered `export_number`, handed over together, or,
// after that export's responses, a retry of the responses the launch kept before it; or, as the launch registers and
// as it settles a request turn while its export status reads stopped, a read of its rollout
// files, with its fallback's handles.
pub(super) enum CodexExportItem {
    Responses {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        responses: Vec<CodexCompletedResponse>,
        export_number: u64,
    },
    Retry {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        export_number: u64,
    },
    ReadRollouts {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        rollouts: CodexLaunchRollouts,
    },
}

// The work a launch's own task runs.
enum CodexLaunchWork {
    Place {
        response: Box<CodexCompletedResponse>,
        export_number: u64,
    },
    Retry {
        export_number: u64,
    },
    FileCopy {
        copy: CodexCopyThread,
        response: Box<CodexCompletedResponse>,
    },
    ReadRollouts(CodexLaunchRollouts),
}

impl CodexLaunchWork {
    // Refuses each response the work carries, naming its thread and `reason`; a retry carries
    // none, since its launch keeps what it retries.
    fn refuse(self, reason: &str) {
        match self {
            Self::Place { response, .. } | Self::FileCopy { response, .. } => {
                refuse_response(&response, reason);
            }
            Self::Retry { .. } | Self::ReadRollouts(_) => {}
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
    pub(super) stop: CancellationToken,
}

impl CodexExportDrain {
    /// Routes each handed-off response, each launch's work on a task of `tasks`, until the
    /// register stops; then refuses each response left in the hand-off, naming its thread.
    pub(crate) async fn run(mut self, tasks: TaskTracker) {
        let mut workers: HashMap<usize, CodexLaunchWorker> = HashMap::new();
        loop {
            let item = tokio::select! {
                biased;
                () = self.stop.cancelled() => break,
                item = self.items.recv() => item,
            };
            // The register holds the sender, so its drop ends the drain too.
            let Some(item) = item else {
                return;
            };
            match item {
                CodexExportItem::Responses {
                    service,
                    launch,
                    responses,
                    export_number,
                } => {
                    for work in self.route_responses(&service, &launch, responses, export_number) {
                        self.hand_to_launch(&mut workers, &tasks, &service, &launch, work);
                    }
                }
                CodexExportItem::Retry {
                    service,
                    launch,
                    export_number,
                } => {
                    let work = CodexLaunchWork::Retry { export_number };
                    self.hand_to_launch(&mut workers, &tasks, &service, &launch, work);
                }
                CodexExportItem::ReadRollouts {
                    service,
                    launch,
                    rollouts,
                } => {
                    let work = CodexLaunchWork::ReadRollouts(rollouts);
                    self.hand_to_launch(&mut workers, &tasks, &service, &launch, work);
                }
            }
        }
        self.items.close();
        while let Ok(item) = self.items.try_recv() {
            if let CodexExportItem::Responses { responses, .. } = item {
                for response in &responses {
                    refuse_response(response, STOPPED);
                }
            }
        }
    }

    // Routes one export's `responses`: those on threads a session of their service holds go onto
    // that session's queue together, one hand-over per session; one on a thread another live
    // launch streams goes to the session its own service released the thread from, else is
    // refused; one on a copy's thread, and any other, is answered as work for its launch, which
    // this returns. A response whose service or launch is gone is refused.
    fn route_responses(
        &self,
        service: &Weak<CodexService>,
        launch: &Weak<Mutex<CodexLaunchPlacement>>,
        responses: Vec<CodexCompletedResponse>,
        export_number: u64,
    ) -> Vec<CodexLaunchWork> {
        let Some(live_service) = service.upgrade() else {
            for response in &responses {
                refuse_response(response, "the service that sent it has ended");
            }
            return Vec::new();
        };
        let mut held: Vec<(SessionId, Vec<CodexExportedResponse>)> = Vec::new();
        let mut others: Option<Vec<Arc<CodexService>>> = None;
        let mut works = Vec::new();
        for response in responses {
            if let Some(session_id) = live_service.session_of_thread(&response.conversation_id) {
                let exported = CodexExportedResponse {
                    response,
                    placed: None,
                    rollout: None,
                };
                match held
                    .iter_mut()
                    .find(|(held_id, _group)| *held_id == session_id)
                {
                    Some((_held_id, group)) => group.push(exported),
                    None => held.push((session_id, vec![exported])),
                }
                continue;
            }
            let others = others.get_or_insert_with(|| {
                self.register
                    .upgrade()
                    .map(|register| live_services(&register))
                    .unwrap_or_default()
            });
            if others
                .iter()
                .any(|other| other.session_of_thread(&response.conversation_id).is_some())
            {
                deliver_moved(&live_service, others, response);
                continue;
            }
            let Some(live_launch) = launch.upgrade() else {
                refuse_response(&response, "the launch that sent it has ended");
                continue;
            };
            // A copy's thread is filed where the copy's spend is.
            let copy = lock(&live_launch)
                .copies()
                .copy_of(&response.conversation_id);
            let response = Box::new(response);
            works.push(match copy {
                Some(copy) => CodexLaunchWork::FileCopy { copy, response },
                None => CodexLaunchWork::Place {
                    response,
                    export_number,
                },
            });
        }
        for (session_id, group) in held {
            push_exported_responses(&live_service, session_id, group);
        }
        works
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

// What wakes a launch's task: its next work, or its rollout fallback falling due.
enum CodexLaunchEvent {
    Work(Option<CodexLaunchWork>),
    FallbackDue(CodexFallbackDue),
}

// Runs one launch's work in order until its queue ends or the daemon stops; each piece is raced
// against the stop, and whatever the stop abandons, and what is left in the queue, is refused,
// naming its thread. Work whose service or launch is gone is refused. From the launch's first
// read of its rollout files on, the task also owns its rollout fallback, which reads each stop
// the export status counts: once as it is found, at each settled request turn and at each export
// read until its files are let go, and ends with the launch's export status. A pass due is taken
// before queued work, so no queued read runs past an export's read.
async fn run_launch_work(
    service: Weak<CodexService>,
    launch: Weak<Mutex<CodexLaunchPlacement>>,
    mut work: mpsc::Receiver<CodexLaunchWork>,
    stop: CancellationToken,
) {
    let mut fallback: Option<CodexRolloutFallback> = None;
    loop {
        let fallback_due = async {
            match fallback.as_mut() {
                Some(fallback) => fallback.wait_until_due().await,
                None => std::future::pending().await,
            }
        };
        let event = tokio::select! {
            biased;
            () = stop.cancelled() => break,
            due = fallback_due => CodexLaunchEvent::FallbackDue(due),
            next = work.recv() => CodexLaunchEvent::Work(next),
        };
        let next = match event {
            CodexLaunchEvent::Work(next) => next,
            CodexLaunchEvent::FallbackDue(due) => {
                let Some(live_fallback) = fallback.as_mut() else {
                    continue;
                };
                match due {
                    CodexFallbackDue::LaunchEnded => fallback = None,
                    CodexFallbackDue::Pass => {
                        let Some(live_service) = service.upgrade() else {
                            // Nothing is left to read with; the passes due are taken unread, so
                            // they do not wake the task again.
                            while live_fallback.next_pass() {}
                            continue;
                        };
                        let mut is_stopping = false;
                        while live_fallback.next_pass() {
                            tokio::select! {
                                biased;
                                () = stop.cancelled() => {
                                    is_stopping = true;
                                    break;
                                }
                                () = live_fallback.pass(&live_service) => {}
                            }
                        }
                        if is_stopping {
                            break;
                        }
                    }
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
            CodexLaunchWork::ReadRollouts(rollouts) => {
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
                export_number,
            } => {
                if let Some(bucket) = bucket_off_stream(&launch, *response, export_number) {
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
            CodexLaunchWork::FileCopy { copy, response } => {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => {
                        refuse_response(&response, STOPPED);
                        break;
                    }
                    () = file_copy(&service, copy, &response) => {}
                }
            }
        }
    }
    work.close();
    while let Ok(left) = work.try_recv() {
        left.refuse(STOPPED);
    }
}

// Files `response`, an exported response on `copy`'s thread, as its session's own, with its
// sighting, which the usage record passes over where the copy's stream filed it first.
async fn file_copy(
    service: &CodexService,
    copy: CodexCopyThread,
    response: &CodexCompletedResponse,
) {
    let CodexCopyThread {
        mut filing, folder, ..
    } = copy;
    let mut delta = response.meter();
    delta.sighting = compose_codex_sighting(
        UsageSightingSource::Export,
        &response.conversation_id,
        &response.counts,
        None,
    );
    filing.file(delta, service, &folder).await;
    response.log_read_for_price();
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
        placed: Some(CodexOffStreamPlacement::Released),
        rollout: None,
    };
    match attached {
        Some(attached) => push_exported_responses(attached, session_id, vec![exported]),
        None => refuse_response(
            &exported.response,
            "the session its launch streamed it for is attached to no service",
        ),
    }
}

/// Pushes `exported`, one hand-over, onto `session_id`'s queue on `service` as one item, which the
/// session prices together; a hand-over no session takes is refused, each response naming its
/// thread. An empty one pushes nothing.
pub(crate) fn push_exported_responses(
    service: &CodexService,
    session_id: SessionId,
    exported: Vec<CodexExportedResponse>,
) {
    if exported.is_empty() {
        return;
    }
    let responses: Vec<CodexCompletedResponse> =
        exported.iter().map(|each| each.response.clone()).collect();
    if !service.push_session_item(
        &session_id,
        CodexSessionInbound::ExportedResponses(exported),
    ) {
        for response in &responses {
            refuse_response(response, "no session took it");
        }
    }
}
